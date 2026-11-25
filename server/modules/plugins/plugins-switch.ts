import type { RequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';

/** `REMOTECLI_PLUGINS_DISABLED=1` turns the plugin feature off; any other value, or none, keeps it on. */
export const readPluginsDisabled = (env: NodeJS.ProcessEnv): boolean => env.REMOTECLI_PLUGINS_DISABLED === '1';

/** Read once when the server starts; no API or setting can change it while the server runs. */
export const PLUGINS_DISABLED = readPluginsDisabled(process.env);

export const PLUGINS_DISABLED_MESSAGE = 'Plugins are turned off by this server\'s configuration.';

/** What every plugin route that changes plugins or serves their code answers while plugins are off. */
export const pluginsDisabledError = (): AppError =>
  new AppError(PLUGINS_DISABLED_MESSAGE, { statusCode: 403, code: 'PLUGINS_DISABLED' });

/**
 * Mounted after authentication and in front of the plugin router. While plugins are off the list answers
 * `{ plugins: [], disabled: true }` and every other plugin route answers 403 PLUGINS_DISABLED, so nothing
 * reads the plugin directory or reaches a plugin process. With plugins on it only passes the request on.
 */
export const createPluginsSwitch = (disabled: boolean): RequestHandler => (req, res, next) => {
  if (!disabled) return next();
  if (req.method === 'GET' && (req.path === '/' || req.path === '')) {
    res.json({ plugins: [], disabled: true });
    return;
  }
  next(pluginsDisabledError());
};

export const pluginsSwitch = createPluginsSwitch(PLUGINS_DISABLED);
