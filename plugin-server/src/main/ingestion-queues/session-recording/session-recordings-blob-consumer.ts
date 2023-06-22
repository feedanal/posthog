import * as Sentry from '@sentry/node'
import { captureException } from '@sentry/node'
import { DateTime } from 'luxon'
import { mkdirSync, rmSync } from 'node:fs'
import { CODES, HighLevelProducer as RdKafkaProducer, Message, TopicPartition } from 'node-rdkafka-acosom'
import path from 'path'
import { Gauge } from 'prom-client'

import {
    KAFKA_SESSION_RECORDING_EVENTS,
    KAFKA_SESSION_RECORDING_SNAPSHOT_ITEM_EVENTS,
} from '../../../config/kafka-topics'
import { BatchConsumer, startBatchConsumer } from '../../../kafka/batch-consumer'
import { createRdConnectionConfigFromEnvVars } from '../../../kafka/config'
import { createKafkaProducer, disconnectProducer } from '../../../kafka/producer'
import { PipelineEvent, PluginsServerConfig, RawEventMessage, RedisPool, Team } from '../../../types'
import { status } from '../../../utils/status'
import { TeamManager } from '../../../worker/ingestion/team-manager'
import { ObjectStorage } from '../../services/object_storage'
import { eventDroppedCounter } from '../metrics'
import { OffsetManager } from './blob-ingester/offset-manager'
import { SessionManager } from './blob-ingester/session-manager'
import { SessionOffsetHighWaterMark } from './blob-ingester/session-offset-high-water-mark'
import { IncomingRecordingMessage } from './blob-ingester/types'

// Must require as `tsc` strips unused `import` statements and just requiring this seems to init some globals
require('@sentry/tracing')

const groupId = 'session-recordings-blob'
const sessionTimeout = 30000
const fetchBatchSize = 500

export const bufferFileDir = (root: string) => path.join(root, 'session-buffer-files')

const gaugeSessionsHandled = new Gauge({
    name: 'recording_blob_ingestion_session_manager_count',
    help: 'A gauge of the number of sessions being handled by this blob ingestion consumer',
})

const gaugeSessionsRevoked = new Gauge({
    name: 'recording_blob_ingestion_sessions_revoked',
    help: 'A gauge of the number of sessions being revoked when partitions are revoked when a re-balance occurs',
})

const gaugeBytesBuffered = new Gauge({
    name: 'recording_blob_ingestion_bytes_buffered',
    help: 'A gauge of the bytes of data buffered in files. Maybe the consumer needs this much RAM as it might flush many of the files close together and holds them in memory when it does',
})

const gaugeLagMilliseconds = new Gauge({
    name: 'recording_blob_ingestion_lag_in_milliseconds',
    help: "A gauge of the lag in milliseconds, more useful than lag in messages since it affects how much work we'll be pushing to redis",
    labelNames: ['partition'],
})

/**
 * a predicate constructed and passed to a session manager. It is called with the session start timestamp and returns
 * whether the session should be flushed and some extra log context
 * @param referenceNow the reference time to compare the session start timestamp to
 * @param flushThresholdSeconds the number of seconds after which a session should be flushed
 * @param referenceNowFlushAttemptCount the number of times the consumer has attempted to flush the session for this reference now
 */
export const flushOnAgePredicate = (
    referenceNow: number,
    flushThresholdSeconds: number,
    referenceNowFlushAttemptCount: number
) => {
    return (sessionStartTimestamp: number): { shouldFlush: boolean; extraLogContext: Record<string, any> } => {
        const bufferAge = referenceNow - sessionStartTimestamp
        const shouldFlush = referenceNowFlushAttemptCount > 5 || bufferAge > flushThresholdSeconds

        const extraLogContext = {
            referenceTime: referenceNow,
            referenceTimeHumanReadable: DateTime.fromMillis(referenceNow).toISO(),
            flushThreshold: flushThresholdSeconds,
            bufferAge,
            referenceNowFlushAttemptCount: referenceNowFlushAttemptCount,
        }

        return { shouldFlush, extraLogContext }
    }
}

export class SessionRecordingBlobIngester {
    sessions: Map<string, SessionManager> = new Map()
    private sessionOffsetHighWaterMark: SessionOffsetHighWaterMark
    offsetManager?: OffsetManager
    batchConsumer?: BatchConsumer
    producer?: RdKafkaProducer
    flushInterval: NodeJS.Timer | null = null
    enabledTeams: number[] | null
    // the time at the most recent message of a particular partition
    partitionNow: Record<number, { timestamp: number | null; attemptCount: number }> = {}

    constructor(
        private teamManager: TeamManager,
        private serverConfig: PluginsServerConfig,
        private objectStorage: ObjectStorage,
        private redisPool: RedisPool,
        private flushIntervalTimeoutMs = 30000
    ) {
        const enabledTeamsString = this.serverConfig.SESSION_RECORDING_BLOB_PROCESSING_TEAMS
        this.enabledTeams =
            enabledTeamsString === 'all' ? null : enabledTeamsString.split(',').filter(Boolean).map(parseInt)
        this.sessionOffsetHighWaterMark = new SessionOffsetHighWaterMark(
            this.redisPool,
            serverConfig.SESSION_RECORDING_REDIS_OFFSET_STORAGE_KEY
        )
    }

    public async consume(event: IncomingRecordingMessage, sentrySpan?: Sentry.Span): Promise<void> {
        const { team_id, session_id } = event
        const key = `${team_id}-${session_id}`

        const { partition, topic, offset, timestamp } = event.metadata

        // track the latest message timestamp seen so, we can use it to calculate a reference "now"
        // lag does not distribute evenly across partitions, so track timestamps per partition
        this.partitionNow[partition] = { timestamp, attemptCount: 0 }
        gaugeLagMilliseconds
            .labels({
                partition: partition.toString(),
            })
            .set(DateTime.now().toMillis() - timestamp)

        const highWaterMarkSpan = sentrySpan?.startChild({
            op: 'checkHighWaterMark',
        })
        if (await this.sessionOffsetHighWaterMark.isBelowHighWaterMark({ topic, partition }, session_id, offset)) {
            eventDroppedCounter
                .labels({
                    event_type: 'session_recordings_blob_ingestion',
                    drop_cause: 'high_water_mark',
                })
                .inc()
            return
        }
        highWaterMarkSpan?.finish()

        if (!this.sessions.has(key)) {
            const { partition, topic } = event.metadata

            const sessionManager = new SessionManager(
                this.serverConfig,
                this.objectStorage.s3,
                team_id,
                session_id,
                partition,
                topic,
                (offsets) => {
                    const committedOffset = this.offsetManager?.removeOffsets(topic, partition, offsets)
                    const maxOffset = Math.max(...offsets)

                    // We don't want to block if anything fails here. Watermarks are best effort
                    void this.sessionOffsetHighWaterMark.add({ topic, partition }, session_id, maxOffset)
                    if (committedOffset) {
                        void this.sessionOffsetHighWaterMark.onCommit({ topic, partition }, committedOffset)
                    }
                }
            )

            this.sessions.set(key, sessionManager)
            status.info('📦', 'Blob ingestion consumer started session manager', {
                key,
                partition,
                topic,
                sessionId: session_id,
            })
        }

        this.offsetManager?.addOffset(topic, partition, session_id, offset)
        await this.sessions.get(key)?.add(event)
        // TODO: If we error here, what should we do...?
        // If it is unrecoverable we probably want to remove the offset
        // If it is recoverable, we probably want to retry?
    }

    public async handleKafkaMessage(message: Message, span?: Sentry.Span): Promise<void> {
        const statusWarn = (reason: string, extra?: Record<string, any>) => {
            status.warn('⚠️', 'invalid_message', {
                reason,
                partition: message.partition,
                offset: message.offset,
                ...(extra || {}),
            })
        }

        if (!message.value || !message.timestamp) {
            // Typing says this can happen but in practice it shouldn't
            return statusWarn('message value or timestamp is empty')
        }

        let messagePayload: RawEventMessage
        let event: PipelineEvent

        try {
            messagePayload = JSON.parse(message.value.toString())
            event = JSON.parse(messagePayload.data)
        } catch (error) {
            return statusWarn('invalid_json', { error })
        }

        if (event.event !== '$snapshot_items' || !event.properties?.$snapshot_items?.length) {
            status.debug('🙈', 'Received non-snapshot message, ignoring')
            return
        }

        if (messagePayload.team_id == null && !messagePayload.token) {
            return statusWarn('no_token')
        }

        let team: Team | null = null

        const teamSpan = span?.startChild({
            op: 'fetchTeam',
        })
        if (messagePayload.team_id != null) {
            team = await this.teamManager.fetchTeam(messagePayload.team_id)
        } else if (messagePayload.token) {
            team = await this.teamManager.getTeamByToken(messagePayload.token)
        }
        teamSpan?.finish()

        if (team == null) {
            return statusWarn('team_not_found', {
                teamId: messagePayload.team_id,
                payloadTeamSource: messagePayload.team_id ? 'team' : messagePayload.token ? 'token' : 'unknown',
            })
        }

        if (!team.session_recording_opt_in) {
            eventDroppedCounter
                .labels({
                    event_type: 'session_recordings_blob_ingestion',
                    drop_cause: 'disabled',
                })
                .inc()
            return
        }

        const recordingMessage: IncomingRecordingMessage = {
            metadata: {
                partition: message.partition,
                topic: message.topic,
                offset: message.offset,
                timestamp: message.timestamp,
            },

            team_id: team.id,
            distinct_id: event.distinct_id,
            session_id: event.properties?.$session_id,
            window_id: event.properties?.$window_id,
            events: event.properties.$snapshot_items,
        }

        const consumeSpan = span?.startChild({
            op: 'consume',
        })
        await this.consume(recordingMessage, consumeSpan)
        consumeSpan?.finish()
    }

    private async handleEachBatch(messages: Message[]): Promise<void> {
        const transaction = Sentry.startTransaction({ name: `blobIngestion_handleEachBatch` }, {})

        await Promise.all(
            messages.map(async (message) => {
                const childSpan = transaction.startChild({
                    op: 'handleKafkaMessage',
                })
                await this.handleKafkaMessage(message, childSpan)
                childSpan.finish()
            })
        )

        transaction.finish()
    }

    public async start(): Promise<void> {
        status.info('🔁', 'blob_ingester_consumer - starting session recordings blob consumer')

        // Currently we can't reuse any files stored on disk, so we opt to delete them all
        try {
            rmSync(bufferFileDir(this.serverConfig.SESSION_RECORDING_LOCAL_DIRECTORY), { recursive: true, force: true })
            mkdirSync(bufferFileDir(this.serverConfig.SESSION_RECORDING_LOCAL_DIRECTORY), { recursive: true })
        } catch (e) {
            status.error('🔥', 'Failed to recreate local buffer directory', e)
            captureException(e)
            throw e
        }

        const connectionConfig = createRdConnectionConfigFromEnvVars(this.serverConfig)
        this.producer = await createKafkaProducer(connectionConfig)

        // Create a node-rdkafka consumer that fetches batches of messages, runs
        // eachBatchWithContext, then commits offsets for the batch.
        this.batchConsumer = await startBatchConsumer({
            connectionConfig,
            groupId,
            topic: KAFKA_SESSION_RECORDING_SNAPSHOT_ITEM_EVENTS,
            sessionTimeout,
            consumerMaxBytes: this.serverConfig.KAFKA_CONSUMPTION_MAX_BYTES,
            consumerMaxBytesPerPartition: this.serverConfig.KAFKA_CONSUMPTION_MAX_BYTES_PER_PARTITION,
            consumerMaxWaitMs: this.serverConfig.KAFKA_CONSUMPTION_MAX_WAIT_MS,
            consumerErrorBackoffMs: this.serverConfig.KAFKA_CONSUMPTION_ERROR_BACKOFF_MS,
            fetchBatchSize,
            batchingTimeoutMs: this.serverConfig.KAFKA_CONSUMPTION_BATCHING_TIMEOUT_MS,
            autoCommit: false,
            eachBatch: async (messages) => {
                return await this.handleEachBatch(messages)
            },
        })

        this.offsetManager = new OffsetManager(this.batchConsumer.consumer)

        this.batchConsumer.consumer.on('rebalance', async (err, topicPartitions) => {
            /**
             * see https://github.com/Blizzard/node-rdkafka#rebalancing
             *
             * This event is received when the consumer group starts _or_ finishes rebalancing.
             *
             * NB if the partition assignment strategy changes then this code may need to change too.
             * e.g. round-robin and cooperative strategies will assign partitions differently
             */
            if (err.code === CODES.ERRORS.ERR__ASSIGN_PARTITIONS) {
                /**
                 * The assign_partitions indicates that the consumer group has new assignments.
                 * We don't need to do anything, but it is useful to log for debugging.
                 */
                return
            }

            if (err.code === CODES.ERRORS.ERR__REVOKE_PARTITIONS) {
                /**
                 * The revoke_partitions indicates that the consumer group has had partitions revoked.
                 * As a result, we need to drop all sessions currently managed for the revoked partitions
                 */

                const revokedPartitions = topicPartitions.map((x) => x.partition)
                if (!revokedPartitions.length) {
                    return
                }

                const sessionsToDrop = [...this.sessions.entries()].filter(([_, sessionManager]) =>
                    revokedPartitions.includes(sessionManager.partition)
                )

                // any commit from this point is invalid, so we revoke immediately
                this.offsetManager?.revokePartitions(KAFKA_SESSION_RECORDING_EVENTS, revokedPartitions)
                await this.destroySessions(sessionsToDrop)

                gaugeSessionsRevoked.set(sessionsToDrop.length)
                revokedPartitions.forEach((partition) => {
                    gaugeLagMilliseconds.remove({ partition: partition.toString() })
                })

                topicPartitions.forEach((topicPartition: TopicPartition) => {
                    this.sessionOffsetHighWaterMark.revoke(topicPartition)
                })

                return
            }

            // We had a "real" error
            status.error('🔥', 'blob_ingester_consumer - rebalancing error', { err })
            // TODO: immediately die? or just keep going?
        })

        // Make sure to disconnect the producer after we've finished consuming.
        this.batchConsumer.join().finally(async () => {
            if (this.producer && this.producer.isConnected()) {
                status.debug(
                    '🔁',
                    'blob_ingester_consumer disconnecting kafka producer in session recordings batchConsumer finally'
                )
                await disconnectProducer(this.producer)
            }
        })

        this.batchConsumer.consumer.on('disconnected', async (err) => {
            // since we can't be guaranteed that the consumer will be stopped before some other code calls disconnect
            // we need to listen to disconnect and make sure we're stopped
            status.info('🔁', 'blob_ingester_consumer batch consumer disconnected, cleaning up', { err })
            await this.stop()
        })

        // We trigger the flushes from this level to reduce the number of running timers
        this.flushInterval = setInterval(() => {
            status.info('🚽', `blob_ingester_session_manager flushInterval fired`)
            // It's unclear what happens if an exception occurs here so, we try catch it just in case
            let sessionManagerBufferSizes = 0

            for (const [key, sessionManager] of this.sessions) {
                sessionManagerBufferSizes += sessionManager.buffer.size

                // in practice, we will always have a values for latestKafkaMessageTimestamp,
                const referenceTime = this.partitionNow[sessionManager.partition]
                const referenceNow = referenceTime.timestamp
                if (!referenceTime || !referenceNow) {
                    throw new Error(
                        'No latestKafkaMessageTimestamp for partition ' +
                            sessionManager.partition +
                            ' even though it has at least one session: ' +
                            sessionManager.sessionId
                    )
                }
                this.partitionNow[sessionManager.partition].attemptCount += 1

                void sessionManager
                    .flushIfSessionBufferIsOld(
                        flushOnAgePredicate(
                            referenceNow,
                            this.serverConfig.SESSION_RECORDING_MAX_BUFFER_AGE_SECONDS * 1000,
                            this.partitionNow[sessionManager.partition].attemptCount
                        )
                    )
                    .catch((err) => {
                        status.error(
                            '🚽',
                            'blob_ingester_consumer - failed trying to flush on idle session: ' +
                                sessionManager.sessionId,
                            {
                                err,
                                session_id: sessionManager.sessionId,
                            }
                        )
                        captureException(err, { tags: { session_id: sessionManager.sessionId } })
                        throw err
                    })

                // If the SessionManager is done (flushed and with no more queued events) then we remove it to free up memory
                if (sessionManager.isEmpty) {
                    this.sessions.delete(key)
                }
            }

            gaugeSessionsHandled.set(this.sessions.size)
            gaugeBytesBuffered.set(sessionManagerBufferSizes)

            status.info('🚽', `blob_ingester_session_manager flushInterval completed`)
        }, this.flushIntervalTimeoutMs)
    }

    public async stop(): Promise<void> {
        status.info('🔁', 'blob_ingester_consumer - stopping')

        if (this.flushInterval) {
            clearInterval(this.flushInterval)
        }

        if (this.producer && this.producer.isConnected()) {
            status.info('🔁', 'blob_ingester_consumer disconnecting kafka producer in batchConsumer stop')
            await disconnectProducer(this.producer)
        }
        await this.batchConsumer?.stop()

        // This is inefficient but currently necessary due to new instances restarting from the committed offset point
        await this.destroySessions([...this.sessions.entries()])

        this.sessions = new Map()
    }

    async destroySessions(sessionsToDestroy: [string, SessionManager][]): Promise<void> {
        const destroyPromises: Promise<void>[] = []

        sessionsToDestroy.forEach(([key, sessionManager]) => {
            this.sessions.delete(key)
            destroyPromises.push(sessionManager.destroy())
        })

        await Promise.allSettled(destroyPromises)
    }
}
