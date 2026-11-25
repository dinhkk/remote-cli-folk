/**
 * `/api/remote/**`: the management API of Remote work (contracts sections 2 and 10). Thin on purpose:
 * the guard chain (same origin, full JWT, JSON, 4 KB) runs first, endpoints marked `*` in the contract add
 * the password re-check, and each handler parses, calls the management service and answers. This API is
 * never reachable through the relay: it lives on the Local origin and a tab token does not open it.
 *
 * When Remote cannot work right now (master key missing or changed, platform mode) every endpoint answers
 * 409 with the reason as `error.code`: the UI only reads codes from non-2xx answers.
 */

import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';

import type { RemoteManagement } from '../runtime/remote-management.service.js';

import { remoteErrorHandler, sendRemoteError } from './remote-api-errors.js';
import type { ManagementRequest, createManagementGuards } from './remote-guards.js';

export type RemoteRoutesOptions = {
  guards: ReturnType<typeof createManagementGuards>;
  /** The management service, or throws the `AppError` that explains why Remote cannot work right now. */
  resolveManagement(): RemoteManagement;
};

type Handler = (req: ManagementRequest, management: RemoteManagement) => unknown;

/**
 * Creates the management router (mounted at `/api/remote` before the global body parsers).
 * Consumed by: the Remote module's mount.
 */
export function createRemoteRoutes({ guards, resolveManagement }: RemoteRoutesOptions): Router {
  const router = express.Router();
  const { requirePassword } = guards;

  const handle =
    (run: Handler): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await run(req as ManagementRequest, resolveManagement()));
      } catch (error) {
        next(error);
      }
    };

  router.use(...guards.chain);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      resolveManagement(); // refuses with the reason before a password is checked or a body is acted on
      next();
    } catch (error) {
      next(error);
    }
  });

  const id = (req: Request, name: string): string => String(req.params[name]);

  router.get('/relay-config', handle((_req, m) => m.relayConfig()));
  router.put(
    '/relay-config',
    requirePassword,
    handle(async (req, m) => {
      const { revocationFailures } = await m.updateRelayConfig(req.body);
      // The contract answer is `{ok}`; a count is added only when some pairing could not be revoked.
      return revocationFailures > 0 ? { ok: true, revocationFailures } : { ok: true };
    }),
  );

  router.get('/host/status', handle((_req, m) => m.hostStatus()));
  // Read-only audit of what Controllers did on this Host; full JWT only (the guard chain above refuses tab tokens).
  router.get('/host/audit', handle((req, m) => m.hostAudit(req.query)));
  router.put('/host/accept', requirePassword, handle((req, m) => m.setAccept(req.body)));
  router.post('/host/pairings/start', requirePassword, handle((_req, m) => m.startHostPairing()));
  router.get('/host/pairings/:pairingId', handle((req, m) => m.hostPairingStatus(id(req, 'pairingId'))));
  router.post('/host/pairings/:pairingId/confirm', handle((req, m) => m.confirmPairing(id(req, 'pairingId'), req.body.sas)));
  router.post('/host/controllers/:pairingId/disconnect', handle((req, m) => m.disconnectController(id(req, 'pairingId'))));
  router.delete('/host/pairings/:pairingId', requirePassword, handle((req, m) => m.revokePairing(id(req, 'pairingId'))));

  router.get('/peers', handle((_req, m) => m.listPeers()));
  router.post('/peers/join', handle((req, m) => m.joinPeer(req.body)));
  router.get('/peers/join/:joinId', handle((req, m) => m.joinStatus(id(req, 'joinId'))));
  router.post('/peers/:peerId/tab-token', handle((req, m) => m.issueTabToken(req.user, id(req, 'peerId'), req.authSession?.id ?? '')));
  router.delete('/peers/:peerId', handle((req, m) => m.forgetPeer(id(req, 'peerId'))));
  // Local label only (nothing goes to the Host or the relay), so no password: it is not a sensitive action.
  router.put('/peers/:peerId/alias', handle((req, m) => m.setPeerAlias(id(req, 'peerId'), req.body)));

  router.use((_req, res) => sendRemoteError(res, 404, 'REMOTE_NOT_FOUND', 'No such management endpoint.'));
  router.use(remoteErrorHandler);
  return router;
}
