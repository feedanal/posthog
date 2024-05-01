import { PluginEvent } from '@posthog/plugin-scaffold'

import { droppedEventCounter } from '../../../../src/worker/ingestion/event-pipeline/metrics'
import { pluginsProcessEventStep } from '../../../../src/worker/ingestion/event-pipeline/pluginsProcessEventStep'
import { runProcessEvent } from '../../../../src/worker/plugins/run'

jest.mock('../../../../src/worker/plugins/run')

const pluginEvent: PluginEvent = {
    distinct_id: 'my_id',
    ip: '127.0.0.1',
    site_url: 'http://localhost',
    team_id: 2,
    now: '2020-02-23T02:15:00Z',
    timestamp: '2020-02-23T02:15:00Z',
    event: 'default event',
    properties: {},
    uuid: '017ef865-19da-0000-3b60-1506093bf40f',
}

describe('pluginsProcessEventStep()', () => {
    let runner: any

    beforeEach(() => {
        runner = {
            nextStep: (...args: any[]) => args,
        }
    })

    it('forwards processed plugin event to `processPersonsStep`', async () => {
        const processedEvent = { ...pluginEvent, event: 'processed' }
        jest.mocked(runProcessEvent).mockResolvedValue(processedEvent)

        const response = await pluginsProcessEventStep(runner, pluginEvent)

        expect(response).toEqual(processedEvent)
    })

    it('does not forward but counts dropped events by plugins', async () => {
        jest.mocked(runProcessEvent).mockResolvedValue(null)
        const droppedEventCounterSpy = jest.spyOn(droppedEventCounter, 'inc')

        const response = await pluginsProcessEventStep(runner, pluginEvent)

        expect(response).toEqual(null)
        expect(droppedEventCounterSpy).toHaveBeenCalledTimes(1)
    })

    it('hidden properties can not be seen nor overridden by plugins', async () => {
        const processedEvent = { ...pluginEvent, event: 'processed', properties: { $heatmap_data: 'new data' } }
        jest.mocked(runProcessEvent).mockResolvedValue(processedEvent)

        const response = await pluginsProcessEventStep(runner, {
            ...pluginEvent,
            properties: { $heatmap_data: 'data', x: 'y' },
        })

        expect(runProcessEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({ properties: { x: 'y' } }))
        expect(response).toEqual({ ...processedEvent, properties: { $heatmap_data: 'data' } })
    })
})
