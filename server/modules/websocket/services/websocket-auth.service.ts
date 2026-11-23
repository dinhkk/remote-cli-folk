import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest, AuthenticatedWebSocketUser } from '@/shared/types.js';
import { isSessionOriginAllowed, readAuthTransportConfig } from '@/modules/auth/index.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (request: AuthenticatedWebSocketRequest) => AuthenticatedWebSocketUser | null;
};

/** Shared origin policy applies to every browser socket, including plugin and notification sockets. */
export function isWebSocketOriginAllowed(origin: string | undefined, host: string | undefined, _pathname: string, secure = false): boolean {
  return isSessionOriginAllowed({ headers: { origin, host }, socket: {}, secure }, readAuthTransportConfig(process.env));
}

export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies,
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  // The auth adapter classifies cookie versus typed loopback bearer and applies the origin policy.
  const user = dependencies.authenticateWebSocket(request);
  if (!user) return false;
  request.user = user;
  return true;
}
