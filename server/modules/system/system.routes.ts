import express from 'express';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
): express.Router {
  const router = express.Router();

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/version', async (request, response, next) => {
    try {
      const force = request.query.force === 'true' || request.query.force === '1';
      const versionInfo = await systemUpdateService.checkSystemVersion(force);
      response.json(versionInfo);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
