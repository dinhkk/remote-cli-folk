import { AppError } from '@/shared/utils.js';

/** `REMOTECLI_PLUGINS_DISABLED=1` turns the plugin feature off; any other value, or none, keeps it on. */
export const readPluginsDisabled = (env: NodeJS.ProcessEnv): boolean => env.REMOTECLI_PLUGINS_DISABLED === '1';

/** Read once when the server starts; no API or setting can change it while the server runs. */
export const PLUGINS_DISABLED = readPluginsDisabled(process.env);

export const PLUGINS_DISABLED_MESSAGE = 'Plugins are turned off by this server\'s configuration.';

/** What every plugin route that changes plugins or serves their code answers while plugins are off. */
export const pluginsDisabledError = (): AppError =>
  new AppError(PLUGINS_DISABLED_MESSAGE, { statusCode: 403, code: 'PLUGINS_DISABLED' });
