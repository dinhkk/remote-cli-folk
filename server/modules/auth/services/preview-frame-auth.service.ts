import { userDb } from '../../database/index.js';

import { getSessionRuntime } from './session-runtime.service.js';
import { isHtmlPreviewDocumentRequest, readSessionCookie, type SessionRequest } from './session-transport.service.js';

/** Who a frame load of the preview page speaks for: the signed-in browser session, never a token. */
export type PreviewFrameIdentity = { id: number; username: string; sessionId: string };

export type PreviewFrameAuth =
  | { ok: true; user: PreviewFrameIdentity }
  | { ok: false; status: 401 | 423; code: 'AUTH_TOKEN_INVALID' | 'AUTH_SESSION_LOCKED'; message: string };

const refused = (status: 401 | 423, code: 'AUTH_TOKEN_INVALID' | 'AUTH_SESSION_LOCKED', message: string): PreviewFrameAuth =>
  ({ ok: false, status, code, message });

/**
 * Authenticates the one request the Remote Controller accepts with the browser's session cookie instead of a tab
 * token: the browser loading the HTML preview page into a frame of the app (the same request as the Local
 * preview, see `isHtmlPreviewDocumentRequest`: same method, exact path, all three Fetch Metadata headers).
 *
 * Returns null when the request is not such a frame load, so the caller keeps its own authentication. Otherwise:
 * - an Authorization header is refused (a frame load never carries one, and there is no fallback to it);
 * - the cookie must name a session that exists, has not expired and has not been revoked (401);
 * - the account must still exist (401);
 * - a locked session is refused (423), so it learns nothing about any Host;
 * - nothing is read from the URL, and nothing here issues, renews or clears a cookie.
 *
 * Consumed by: the Remote Controller proxy (`/r/<peerId>/...`).
 */
export function authenticatePreviewFrame(req: SessionRequest & { method: string }, rawPath: string): PreviewFrameAuth | null {
  if (!isHtmlPreviewDocumentRequest(req, rawPath)) return null;
  if (req.headers.authorization !== undefined) return refused(401, 'AUTH_TOKEN_INVALID', 'The preview frame does not use a token.');
  const secret = readSessionCookie(req);
  const session = secret ? getSessionRuntime().store.authenticate(secret, true) : null;
  const user = session ? userDb.getUserById(session.userId) : null;
  if (!session || !user) return refused(401, 'AUTH_TOKEN_INVALID', 'Please sign in again.');
  if (session.lockedAt !== null) return refused(423, 'AUTH_SESSION_LOCKED', 'Unlock this session to continue.');
  return { ok: true, user: { id: user.id, username: user.username, sessionId: session.id } };
}
