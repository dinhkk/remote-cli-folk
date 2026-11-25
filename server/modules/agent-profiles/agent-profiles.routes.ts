import express from 'express';

import type { BlocksService } from './agent-profiles.blocks.service.js';
import type { AgentProfilesService } from './agent-profiles.service.js';
import type { ClaudeAgentsService } from './claude-agents.service.js';

const param = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? '' : value ?? '');

/** A single optional query string value; empty or repeated values count as absent. */
const queryValue = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * REST routes of the agent profiles (templates, Generate, Claude agents, scope options). Routes
 * only parse transport input and call the services; every rule lives in the services. Errors go to
 * the app error middleware.
 * Mounted behind `authenticateToken`; Remote reaches only `GET /scope-options`.
 */
export function createAgentProfilesRouter(
  service: AgentProfilesService, claudeAgents: ClaudeAgentsService, blocks: BlocksService,
): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>, status = 200) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.status(status).json(await operation(req)); } catch (error) { next(error); }
    };

  // The main agents a new chat in one sidebar project can start with (`?projectId=<sidebar project id>`); the only route Remote may call.
  router.get('/scope-options', respond((req) => service.scopeOptions(queryValue(req.query.projectId))));

  // The single list of agents: built-in + user + the project folder's `.claude/agents` (`?directory=<absolute>`).
  router.get('/claude-agents', respond((req) => claudeAgents.list(queryValue(req.query.directory))));
  router.put('/claude-agents/hidden', respond((req) => claudeAgents.setHidden(req.body)));

  router.get('/templates', respond(() => service.listTemplates()));
  router.post('/templates', respond((req) => service.createTemplate(req.body), 201));
  router.get('/templates/:id', respond((req) => service.getTemplate(param(req.params.id))));
  router.put('/templates/:id', respond((req) => service.updateTemplate(param(req.params.id), req.body)));
  router.delete('/templates/:id', respond((req) => service.deleteTemplate(param(req.params.id))));

  // Generate: template -> native agent file in `<directory>/.claude/agents/` (or `~/.claude/agents/` without a directory).
  router.get('/generate/values', respond((req) => service.getRememberedValues(queryValue(req.query.directory))));
  router.post('/generate/preview', respond((req) => service.previewGenerate(req.body)));
  router.post('/generate', respond((req) => service.generate(req.body), 201));

  // App-owned memory blocks the `blocks` MCP server serves to agents (Host only; the user edits them here, `expectedRev` = the rev loaded).
  router.get('/memory-blocks', respond(() => blocks.list()));
  router.post('/memory-blocks', respond((req) => blocks.create(req.body), 201));
  router.put('/memory-blocks/:id', respond((req) => blocks.update(param(req.params.id), req.body)));
  router.delete('/memory-blocks/:id', respond((req) => blocks.remove(param(req.params.id))));

  return router;
}
