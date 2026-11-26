import express from 'express';

import { AppError } from '@/shared/utils.js';

import { parseExpectedBlockRev } from './agent-profiles.blocks.validation.js';
import { parseExportRequest, parseImportRequest, parseRestoreRequest } from './agent-profiles.bundle.validation.js';
import type { BundleService } from './agent-profiles.bundle.service.js';
import type { BlocksService } from './agent-profiles.blocks.service.js';
import type { AgentProfilesService } from './agent-profiles.service.js';
import type { ClaudeAgentsService } from './claude-agents.service.js';

const param = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? '' : value ?? '');

/** A single optional query string value; empty or repeated values count as absent. */
const queryValue = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Optional `expectedRev` query value: absent = undefined, otherwise a non-negative integer (400 when not). */
const parseOptionalRev = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  const rev = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(rev)) throw new AppError('expectedRev must be a non-negative integer', { code: 'INVALID_PROFILE_INPUT', statusCode: 400 });
  return rev;
};

/**
 * JSON body parser of the bundle routes: at most 5 MB (bundles are text; the global parser allows 50 MB). Mount it on
 * `/api/agent-profiles/bundle` before the global parser, which skips a body that is already parsed, so the bundle routes
 * never parse more than 5 MB.
 * Consumed by: server/index.ts, agent-profiles.bundle.routes.test.ts.
 */
export const agentProfilesBundleBodyParser = express.json({
  limit: '5mb',
  type: (req) => (req.headers['content-type'] || '').includes('json'),
});

/**
 * REST routes of the agent profiles (templates, Generate, Claude agents, scope options). Routes
 * only parse transport input and call the services; every rule lives in the services. Errors go to
 * the app error middleware.
 * Mounted behind `authenticateToken`; Remote reaches only `GET /scope-options`.
 */
export function createAgentProfilesRouter(
  service: AgentProfilesService, claudeAgents: ClaudeAgentsService, blocks: BlocksService, bundle: BundleService,
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

  // Per-folder content of a project block (Host only). `directory` is any absolute folder (normalized server-side, not limited to sidebar projects).
  // POST gives a folder an empty content file; PUT edits it (`expectedRev` = the content rev loaded); DELETE empties it (file and rev stay),
  // DELETE with `?remove=true` removes the file; both take an optional `?expectedRev=` (stale = 409).
  router.get('/memory-blocks/:id/contents', respond((req) => blocks.listContents(param(req.params.id))));
  router.post('/memory-blocks/:id/contents', respond((req) => blocks.addContent(param(req.params.id), req.body?.directory), 201));
  router.put('/memory-blocks/:id/contents', respond((req) => blocks.updateContent(
    param(req.params.id), req.body?.directory, req.body?.content, parseExpectedBlockRev(req.body),
  )));
  router.delete('/memory-blocks/:id/contents', respond((req) => {
    const id = param(req.params.id);
    const directory = queryValue(req.query.directory);
    const expectedRev = parseOptionalRev(req.query.expectedRev);
    return req.query.remove === 'true' ? blocks.removeFolder(id, directory, expectedRev) : blocks.emptyContent(id, directory, expectedRev);
  }));

  // Import / export of templates and memory blocks as a YAML or JSON text bundle (Host only, denied for Remote). The bundle is parsed
  // on the server from `text` (mounted with a 5 MB body cap in server/index.ts). Apply answers 200 with `partial`: a mixed result must not look like plain success.
  router.post('/bundle/export', respond((req) => bundle.exportText(parseExportRequest(req.body))));
  router.post('/bundle/import/preview', respond((req) => {
    const request = parseImportRequest(req.body);
    return bundle.previewText(request.text, { projectMap: request.projectMap });
  }));
  router.post('/bundle/import', respond((req) => {
    const { text, ...options } = parseImportRequest(req.body);
    return bundle.applyText(text, options);
  }));
  // Snapshots the server wrote before an overwrite, newest first; restore names one by file name (never a path).
  router.get('/bundle/snapshots', respond(() => bundle.listSnapshots()));
  router.post('/bundle/restore', respond((req) => bundle.restoreSnapshot(parseRestoreRequest(req.body).snapshot)));

  return router;
}
