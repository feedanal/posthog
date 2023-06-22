import { Upload } from '@aws-sdk/lib-storage'
import { createReadStream, writeFileSync } from 'fs'
import { appendFile, unlink } from 'fs/promises'
import { DateTime, Settings } from 'luxon'

import { defaultConfig } from '../../../../../src/config/config'
import { SessionManager } from '../../../../../src/main/ingestion-queues/session-recording/blob-ingester/session-manager'
import { createIncomingRecordingMessage } from '../fixtures'

jest.mock('fs', () => {
    return {
        ...jest.requireActual('fs'),
        writeFileSync: jest.fn(),
        createReadStream: jest.fn().mockImplementation(() => {
            return {
                pipe: () => ({ close: jest.fn() }),
            }
        }),
    }
})

jest.mock('@aws-sdk/lib-storage', () => {
    const mockUpload = jest.fn().mockImplementation(() => {
        return {
            done: jest.fn().mockResolvedValue(undefined),
        }
    })

    return {
        __esModule: true,
        Upload: mockUpload,
    }
})

jest.mock('fs/promises', () => {
    return {
        ...jest.requireActual('fs/promises'),
        unlink: jest.fn().mockResolvedValue(undefined),
        appendFile: jest.fn().mockResolvedValue(undefined),
    }
})

describe('session-manager', () => {
    let sessionManager: SessionManager
    const mockFinish = jest.fn()
    const mockS3Client: any = {
        send: jest.fn(),
    }

    beforeEach(() => {
        // it's always May 25
        Settings.now = () => new Date(2018, 4, 25).valueOf()

        sessionManager = new SessionManager(defaultConfig, mockS3Client, 1, 'session_id_1', 1, 'topic', mockFinish)
        mockFinish.mockClear()
    })

    afterEach(async () => {
        await sessionManager.destroy()
        // it's no longer always May 25
        Settings.now = () => new Date().valueOf()
    })

    it('adds a message', async () => {
        const timestamp = DateTime.now().toMillis() - 10000
        const event = createIncomingRecordingMessage({
            metadata: {
                timestamp: timestamp,
            } as any,
        })

        await sessionManager.add(event)

        expect(sessionManager.buffer).toEqual({
            count: 1,
            oldestKafkaTimestamp: timestamp,
            file: expect.any(String),
            id: expect.any(String),
            size: 4139, // The size of the event payload - this may change when test data changes
            offsets: [1],
            eventsRange: {
                firstTimestamp: 1679568314158,
                lastTimestamp: 1679568314158,
            },
        })

        // the buffer file was created
        expect(writeFileSync).toHaveBeenCalledWith(sessionManager.buffer.file, '', 'utf-8')
    })

    it('does not flush if the predicate tells it not to', async () => {
        await sessionManager.add(createIncomingRecordingMessage())
        await sessionManager.flushIfSessionBufferIsOld(() => ({ shouldFlush: false, extraLogContext: {} }))

        // as a proxy for flush having been called or not
        expect(createReadStream).not.toHaveBeenCalled()
    })

    it('does flush if the predicate tells it to', async () => {
        const firstTimestamp = 1679568043305
        const lastTimestamp = 1679568043305 + 4000

        await sessionManager.add(
            createIncomingRecordingMessage({
                events: [
                    {
                        timestamp: firstTimestamp,
                        type: 4,
                        data: { href: 'http://localhost:3001/', width: 2560, height: 1304 },
                    },
                ],
            })
        )
        await sessionManager.add(
            createIncomingRecordingMessage({
                events: [
                    {
                        timestamp: lastTimestamp,
                        type: 4,
                        data: { href: 'http://localhost:3001/', width: 2560, height: 1304 },
                    },
                ],
            })
        )

        await sessionManager.flushIfSessionBufferIsOld(() => ({ shouldFlush: true, extraLogContext: {} }))

        // as a proxy for flush having been called or not
        expect(createReadStream).toHaveBeenCalled()
        const mockUploadCalls = (Upload as unknown as jest.Mock).mock.calls
        expect(mockUploadCalls.length).toBe(1)
        expect(mockUploadCalls[0].length).toBe(1)
        expect(mockUploadCalls[0][0]).toEqual(
            expect.objectContaining({
                params: expect.objectContaining({
                    Key: `session_recordings/team_id/1/session_id/session_id_1/data/${firstTimestamp}-${lastTimestamp}`,
                }),
            })
        )
    })

    it('flushes messages', async () => {
        const event = createIncomingRecordingMessage()
        await sessionManager.add(event)
        expect(sessionManager.buffer.count).toEqual(1)
        const file = sessionManager.buffer.file
        expect(unlink).not.toHaveBeenCalled()

        const afterResumeFlushPromise = sessionManager.flush('buffer_size')

        expect(sessionManager.buffer.count).toEqual(0)
        expect(sessionManager.flushBuffer?.count).toEqual(1)

        await afterResumeFlushPromise

        expect(sessionManager.flushBuffer).toEqual(undefined)
        expect(mockFinish).toBeCalledTimes(1)
        expect(unlink).toHaveBeenCalledWith(file)
    })

    it('flushes messages and whilst collecting new ones', async () => {
        const event = createIncomingRecordingMessage()
        const event2 = createIncomingRecordingMessage({
            events: [{ timestamp: 1234, type: 4, data: { href: 'http://localhost:3001/' } }],
        })
        await sessionManager.add(event)
        expect(sessionManager.buffer.count).toEqual(1)

        const firstBufferFile = sessionManager.buffer.file

        const flushPromise = sessionManager.flush('buffer_size')
        await sessionManager.add(event2)

        // that the second event is in a new buffer file
        // that the original buffer file is deleted
        expect(sessionManager.buffer.file).toBeDefined()
        expect(sessionManager.buffer.file).not.toEqual(firstBufferFile)

        await flushPromise

        expect(sessionManager.flushBuffer).toEqual(undefined)
        expect(sessionManager.buffer.count).toEqual(1)

        expect((appendFile as jest.Mock).mock.calls.length).toBe(2)
        const lastCall = (appendFile as jest.Mock).mock.calls[1]
        expect(lastCall).toEqual([
            sessionManager.buffer.file,
            '{"window_id":"window_id_1","data":[{"timestamp":1234,"type":4,"data":{"href":"http://localhost:3001/"}}]}\n',
            'utf-8',
        ])
    })
})
