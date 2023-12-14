import { actions, afterMount, connect, kea, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import api from 'lib/api'
import { batchExportsListLogic } from 'scenes/batch_exports/batchExportsListLogic'
import { pluginsLogic } from 'scenes/plugins/pluginsLogic'

import { PluginConfigTypeNew } from '~/types'

import { pipelineTransformationsLogic } from '../transformationsLogic'
import type { exportsUnsubscribeModalLogicType } from './exportsUnsubscribeModalLogicType'

export const exportsUnsubscribeModalLogic = kea<exportsUnsubscribeModalLogicType>([
    path(['scenes', 'pipeline', 'exportsUnsubscribeModalLogic']),
    connect({
        values: [
            pluginsLogic,
            ['plugins'],
            batchExportsListLogic,
            ['batchExportConfigs', 'batchExportConfigsLoading'],
            pipelineTransformationsLogic,
            ['canConfigurePlugins'],
        ],
    }),

    actions({
        openModal: true,
        closeModal: true,
        disablePlugin: (id: number) => ({ id }),
    }),
    loaders(({ values }) => ({
        pluginConfigsToDisable: [
            {} as Record<PluginConfigTypeNew['id'], PluginConfigTypeNew>,
            {
                loadPluginConfigs: async () => {
                    const res = await api.get<PluginConfigTypeNew[]>(
                        `api/organizations/@current/plugins/exports_unsubscribe_configs`
                    )
                    return Object.fromEntries(res.map((pluginConfig) => [pluginConfig.id, pluginConfig]))
                },
                disablePlugin: async ({ id }) => {
                    if (!values.canConfigurePlugins) {
                        return values.pluginConfigsToDisable
                    }
                    // const { pluginConfigsToDisable, plugins } = values
                    // const pluginConfig = pluginConfigs[id]
                    // const plugin = plugins[pluginConfig.plugin]
                    // capturePluginEvent(`plugin ${enabled ? 'enabled' : 'disabled'}`, plugin, pluginConfig)
                    // Update order if enabling to be at the end of current enabled plugins
                    // See comment in savePluginConfigsOrder about races
                    const response = await api.update(`api/plugin_config/${id}`, { enabled: false })
                    return { ...values.pluginConfigsToDisable, [id]: response }
                },
            },
        ],
    })),
    selectors({
        loading: [
            (s) => [s.batchExportConfigsLoading, s.pluginConfigsToDisableLoading],
            (batchExportsLoading, pluginConfigsLoading) => batchExportsLoading || pluginConfigsLoading,
        ],
        unsubscribeDisabledReason: [
            (s) => [s.loading, s.pluginConfigsToDisable, s.batchExportConfigs],
            (loading, pluginConfigsToDisable, batchExports) => {
                // pluginConfigsToDisable || batchExports,
                // loop through pluginConfigsToDisable and check if any of them are enabled
                // if so, return false
                // else, return true
                return loading
                    ? 'Loading...'
                    : Object.values(pluginConfigsToDisable).some((pluginConfig) => pluginConfig.enabled)
                    ? 'All apps above need to be disabled explicitly first'
                    : batchExports
                    ? 'All batch exports need to be deleted first'
                    : null
            },
        ],
    }),
    reducers({
        modalOpen: [
            false,
            {
                openModal: () => true,
                closeModal: () => false,
            },
        ],
    }),
    // TODO: add a listener in the billing page to load plugins and open modal or go directly
    afterMount(({ actions }) => {
        actions.loadPluginConfigs()
    }),
])
