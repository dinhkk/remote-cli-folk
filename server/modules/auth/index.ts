// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';

// configureAuthHardening: used by the server entrypoint once, right after creating the Express app.
export { configureAuthHardening } from './services/trust-proxy.service.js';

// Remote token API: used by the Remote module to give sandboxed tabs scoped access and to
// authenticate the Host bridge's own loopback requests.
export { issueTabToken, verifyTabToken, issueLoopbackToken } from './services/remote-token.service.js';
export type { TabTokenClaims, TabTokenVerification } from './services/remote-token.service.js';
// verifyPassword: used by Remote management endpoints that must re-confirm the owner's password.
export { verifyPassword } from './auth.module.js';
// Epoch API: "log out everywhere" bumps it; Remote closes its streams when it changes.
export { getAuthEpoch, onAuthEpochChange } from './services/auth-epoch.service.js';
// rotateJwtSecret: replaces the stored JWT secret ({ rotated: false } when pinned by JWT_SECRET env).
// It does not revoke cookie sessions; logout-all revokes sessions and bumps the epoch.
export { rotateJwtSecret } from './auth.middleware.js';

// Server transports share one session registry and request-origin policy.
export { getSessionRuntime, startSessionExpiry } from './services/session-runtime.service.js';
export { createApiSessionGuard } from './services/api-session-guard.service.js';
export { isSessionOriginAllowed, readAuthTransportConfig } from './services/session-transport.service.js';
export { assertAuthModeCompatible } from './services/auth-mode.service.js';
export { secretsMatch } from './auth.middleware.js';

export { resetTotp } from './services/reset-totp.service.js';

export { requireRecentMfa } from './services/mfa-runtime.service.js';
export type { AuthSession } from './services/session-store.service.js';
