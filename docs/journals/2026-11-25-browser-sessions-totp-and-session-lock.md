# Technical Journal: Cookie Browser Sessions, TOTP Sign-in and Session Lock

**Date:** 2026-11-25  
**Author:** Claude Code Engineer  
**Status:** Completed & Verified  

---

## 1. Problem Statement & Motivation

People often open RemoteCLI from a phone or another laptop, over a LAN, a mesh network or a Remote relay. Before this change, sign-in returned a JWT that was valid for 7 days. The browser kept it in `localStorage` and sent it as a bearer header.
1. **Sign-Out Was Client-Side:** Signing out deleted the browser's copy of the token. The server had no per-browser session, so it could not list browsers or sign out one of them.
2. **One Factor:** A password was the only check in front of every agent and terminal on the host, even when the server was reachable beyond `localhost`.
3. **Unattended Devices:** A signed-in tablet could not be locked. The only option was to sign out.
4. **Long-Lived Transports:** The server authenticated websockets, terminals and Remote streams once, at connect time. No session existed that could close them later.

---

## 2. Key Architectural Decisions & Implementation

### Phase 1: Revocable Cookie Sessions
- **Database-Backed Sessions:** `createSessionStore` in `server/modules/auth/services/session-store.service.ts` keeps one `auth_sessions` row per browser. The row holds the expiry (7 days), the revocation and the lock state. When the row is revoked, the next request fails.
- **Cookie Only:** Sign-in answers with `Set-Cookie`: `HttpOnly; SameSite=Strict; Path=/`, plus the `__Host-` prefix and `Secure` over HTTPS. The JSON body carries no secret. The frontend stores no token.
- **One `/api` Guard:** `createApiSessionGuard` runs before every API router and body parser. It requires the `x-remotecli-request: 1` header and checks `Origin` and `Sec-Fetch-Site`. It accepts JSON bodies, and multipart bodies only on a fixed list of upload routes. `REMOTECLI_ALLOWED_ORIGINS` adds origins. If an entry is a wildcard, the server stops at startup.
- **Transports Close With Their Session:** `createSessionConnections` in `session-runtime.service.ts` tracks every HTTP stream, `/ws`, `/shell` and Remote proxy socket by session id. `startSessionExpiry` checks every second. It closes the transports of an ended session with `4401 session-ended`, or of a locked session with `4403 session-locked`.
- **Loopback Bearer for the Host Bridge:** The Host bridge's own requests still use a bearer. `loopback-token.service.ts` issues it for 5 minutes and signs it with a key that lives only in process memory. The server accepts it only from `127.0.0.1` or `::1`.

### Phase 2: TOTP Second Factor
- **Opt-In Per User:** The user enrolls an authenticator in Settings → Sessions → *Two-factor authentication (TOTP)* by scanning a QR code (`TotpSettings.tsx`). Activation returns 10 single-use recovery codes once. It also signs out every other device.
- **Two-Step Sign-In:** If TOTP is on, `POST /api/auth/login` returns a challenge that expires after 5 minutes. `POST /api/auth/mfa/verify` then creates the session (`MfaLoginForm.tsx`).
- **Sealed Seeds, No Replay:** The existing Remote master key (`getMasterSecret`) encrypts each seed. The server accepts each 30-second code step once (`last_used_step`).
- **Recent-Code Rule for Sensitive Actions:** `requireRecentMfa` requires a code verified in the last 10 minutes for these actions: disable TOTP, replace recovery codes, change the password, sign out all devices, create API keys, change Remote pairings. If the code is older, `MfaReauthDialog.tsx` asks for a new one and the client sends the request again.
- **Throttling:** After 5 wrong sign-in codes, the user is blocked for 5 minutes. Each later block doubles, up to 24 hours. After 5 wrong codes on an open session, the server revokes that session.
- **Offline Recovery:** `remotecli reset-totp` (`reset-totp.service.ts`) turns TOTP off and revokes every session. It writes to the database file directly. No HTTP route calls it.

### Phase 3: Session Lock
- **Server-Side Lock:** A locked session can call 4 routes (`isLockedSessionRouteAllowed`). Every other route answers `423 AUTH_SESSION_LOCKED`, and the session's transports close. Only an authenticator code unlocks a session, so the lock exists only while TOTP is on.
- **Idle Lock:** By default, a session locks after 24 hours without web activity. The user sets 1 to 168 hours in `SessionLockSettings.tsx`. To raise the hours or turn the lock off, the session needs a recent code.
- **Quick Lock:** `QuickSessionLockButton.tsx` sits in both workspace header layouts and in the Remote shell. It calls `POST /api/auth/lock`. `SessionLockScreen.tsx` then covers the app until the user unlocks.
- **Session List:** `SessionsSettingsTab.tsx` lists signed-in browsers with browser family, last activity and expiry. The user signs out one device or all of them.

---

## 3. Verification & Quality Gates

- **Server Tests:** `server/modules/auth/tests/` covers the session store, runtime and transport rules (`session-store`, `session-runtime`, `session-transport`, `session-api`, `session-lock`), TOTP (`totp-store`, `mfa-api`, `mfa-reset`, `totp-master-key-recovery`) and the guard wiring against the real routers (`auth-module-wiring`, `api-docs-auth`).
- **Client Tests:** `src/modules/auth/tests/` covers the MFA sign-in step, focus in the re-verification dialog, quick lock, the lock context, remaining-attempt messages and the session-expired notice. `src/modules/settings/tests/` covers the Sessions and TOTP settings.
- **Run on 2026-11-25 (Windows, Node.js 24.19.0):** `npx tsx --tsconfig server/tsconfig.json --test "server/modules/auth/**/*.test.ts"` ran 135 tests: 134 passed and 1 failed. The failure is `server-environment-bootstrap.test.ts`, which needs permission to create symlinks; Windows refused it (`EPERM`). `npx vitest run src/modules/auth src/modules/settings` ran 26 files and 118 tests; all passed.
- **Module Guide:** `server/modules/auth/README.md` documents the routes, limits, configuration and gotchas.
