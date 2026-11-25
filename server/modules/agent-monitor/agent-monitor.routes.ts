import express from 'express';

import type { AgentMonitorKillRequest, AgentMonitorKillResult } from '@/shared/types.js';

import type { AgentMonitorKiller } from './agent-monitor.kill.js';
import type { AgentMonitorService } from './agent-monitor.service.js';

const MAX_ID_LENGTH = 256;

/** `refused` is a 403 and `error` a 500, so the Host bridge's audit row says what happened; everything else is a 200. */
const STATUS_OF: Record<AgentMonitorKillResult, number> = {
  killed: 200, stopped: 200, gone: 200, 'no-handle': 200, unavailable: 200, refused: 403, error: 500,
};

const asId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null);

/** The body of a kill request when it has the right shape; null otherwise. */
function readKillRequest(body: unknown): AgentMonitorKillRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { sessionId, nodeId, mode } = body as Record<string, unknown>;
  const session = asId(sessionId);
  const node = asId(nodeId);
  if (!session || !node || (mode !== 'stop' && mode !== 'kill')) return null;
  return { sessionId: session, nodeId: node, mode };
}

/**
 * The agent monitor's HTTP surface, mounted behind `authenticateToken`:
 * - `GET /snapshot`: the full picture. The open screen polls it; each call also keeps the CPU/RAM sampler and the terminal
 *   transcript reading alive.
 * - `GET /summary`: the few numbers of the header badge. Starts nothing.
 * - `POST /kill`: stops one agent or kills processes (see `agent-monitor.kill.ts`). Not mounted without a killer.
 * A Remote controller may read both GETs and may kill (a Controller already holds a shell on the Host, so this raises no
 * privilege; a kill through the bridge leaves one audit row). The answers name Host folders, sessions and processes, so they
 * reach every paired Controller. A request and a response carry no process id.
 */
export function createAgentMonitorRouter(service: AgentMonitorService, killer?: AgentMonitorKiller): express.Router {
  const router = express.Router();

  router.get('/snapshot', (_req, res, next) => {
    try {
      // Live data: a cached copy would show a stale picture and could outlive the screen.
      res.set('Cache-Control', 'no-store');
      res.json(service.snapshot());
    } catch (error) {
      next(error);
    }
  });

  router.get('/summary', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await service.summary());
    } catch (error) {
      next(error);
    }
  });

  if (killer) {
    router.post('/kill', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const request = readKillRequest(req.body);
        if (!request) {
          res.status(400).json({ error: 'sessionId and nodeId (1-256 characters) and mode ("stop" or "kill") are required' });
          return;
        }
        const response = await killer.kill(request);
        res.status(STATUS_OF[response.result]).json(response);
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
