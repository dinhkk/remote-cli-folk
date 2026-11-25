# Technical Journal: HTML Preview with Scripts in Remote Tabs

**Date:** 2026-11-25  
**Author:** Claude Code Engineer  
**Status:** Implemented & Verified (automated tests, Chrome and Edge)  

---

## 1. Problem Statement & Motivation

The editor previews a saved `.html` file in a frame. On Local, the server sends the preview page with a sandbox policy, so the scripts of the file run in an opaque origin with no network.
In a Remote tab, the preview only displayed the HTML. The scripts did not run, and the route was denied in three places: the route table (`route-rules.ts`), the tab's own request policy (`target-route-policy.ts`) and the Host handler (it asked for a browser session and Fetch Metadata).

A page with a chart or a form did not work in a Remote tab, but the same file worked on Local.

Two facts shape the design:
1. **The Host is untrusted in the Controller's origin.** A paired Host chooses the bytes of the file and, in principle, any header. The Controller already forces `SANDBOX_CSP` on every non-JSON answer for this reason.
2. **A frame load cannot carry a tab token.** The browser sends the request for an `iframe` itself. It can add the session cookie but not an `Authorization` header. A token in the URL would end up in history, logs and `Referer`.

---

## 2. Key Architectural Decisions & Implementation

### Phase 1: Host side
- **Route table:** `GET /api/file-tree/projects/*/files/html-preview` moves from the deny list to the allow list in `server/modules/remote/policy/route-rules.ts`. The row count stays 208. Other methods and look-alike paths stay denied.
- **Handler:** `server/modules/file-tree/file-tree.routes.ts` accepts `authKind === 'loopback'` (the Host bridge) next to the browser session, and asks for Fetch Metadata only on the session branch. Any other kind of authentication (platform mode, none) stays refused.
- **Why the Host does not ask for Fetch Metadata on the bridge:** The Controller checks all three headers on the request of the real browser. The Host sees only the bridge. Passing the three headers to the Host would need an exception in `REQUEST_HEADER_ALLOW_LIST`, which every route shares.
- **Shared policy string:** `HTML_PREVIEW_CSP` moves to `server/modules/file-tree/html-preview-csp.ts` and is exported through the module barrel. The Local page and the Controller use one constant.

### Phase 2: Cookie authentication of one request
- **Function:** `authenticatePreviewFrame` in `server/modules/auth/services/preview-frame-auth.service.ts`.
- **Predicate:** It reuses `isHtmlPreviewDocumentRequest`, the predicate of the Local page: `GET`, the exact path, the three Fetch Metadata values and an `Origin` that is absent or the server's own.
- **Order of checks:** predicate (no match returns `null`), no `Authorization` header, cookie session exists and is not revoked or expired, account exists, session not locked.
- **Locked sessions:** `store.authenticate(secret, true)` also returns locked sessions. The function checks `lockedAt` itself and answers `423`, before the proxy looks at any pairing.
- **No cookie writes:** The function never sets, renews or clears a cookie. Its refusals are JSON with `Cache-Control: no-store` and no `X-Auth-Error`, like the refusals of the tab token path.

### Phase 3: Controller proxy
- **Same bookkeeping as the token path:** After authentication the proxy calls `store.touch` and `connections.track`, so a lock, a revoke or a sign-out cuts a response in flight.
- **Pairing:** The request still goes through `registry.attach(peerId)`. A forgotten pairing answers 404, an expired one 410, and a revoked link 503.
- **Request headers:** `withoutConditionalHeaders` removes `Range`, `If-None-Match` and `If-Modified-Since` for this request, so the Host cannot answer 206 or 304.
- **Response headers:** `previewDocumentHeaders` builds the whole header set from the Controller's values. Only `Content-Length` and `X-Request-Id` come from the Host. `Set-Cookie`, `Content-Disposition`, `ETag` and the Host's own policy are dropped.
- **Closed by default:** Only a `200` for a request the Controller recognised itself gets the script-enabled policy. Every other answer for the page route starts with `SANDBOX_CSP`, set when the request arrives: a Host answer with another status, also when its body is JSON, the JSON errors of the Controller itself, and the answers to a tab-token request for the same path.
- **Fetch Metadata for the status check:** The app asks the page with `fetch` before it loads the frame. If that request carries no Fetch Metadata, the proxy answers `400 HTML_PREVIEW_FETCH_METADATA_REQUIRED`, as the Local server does, so the app shows the HTML instead of a frame that would be refused. Only the presence of the headers is checked, because a `fetch` sends other values than a frame load.

### Phase 4: Client
- **Frame:** `HtmlPreview.tsx` loads `httpUrl(htmlPreviewPath(...))` with `sandbox="allow-scripts"` in both modes. No frame gets `allow-same-origin`, `allow-forms` or `allow-modals` for the isolated page.
- **Fallback:** If the status check is not 200, a Remote tab shows the editor text in a `srcdoc` frame with an empty sandbox. The Local fallback is unchanged.
- **Notice:** A new string `htmlPreview.untrustedRemoteIsolated` exists in all 15 locales. The fallback sentence for a Remote tab is unchanged.
- **Tab policy:** The tab's own deny rule for the route is removed, and the parity test compares the tab's list with the server's table.

### Decisions that did not change
- `SANDBOX_CSP`, `TARGET_PAGE_CSP`, the main page policy and the sandbox of the Remote tab frame are unchanged.
- No dependency, lockfile, relay, protocol, crypto or pairing change.
- The preview loads nothing from the network. Its policy is `default-src 'none'` with inline script and style only.

### Observed, not changed
- A script in the previewed file can read `document.referrer` and `document.baseURI`, so it can learn the Controller's address and the path of its own file. Its network access stays closed by the policy.

---

## 3. Verification & Quality Gates

**What ran, at the head of the branch (the last commits add this journal and one E2E test; the E2E suite ran just before them):**
- **Server tests (`npm test`):** 2676 tests, 2662 pass, 0 fail, 14 skipped (2648 tests before the change).
- **Client tests (`npm run test:client`):** 1472 tests pass in 200 files (1467 before).
- **Crypto tests:** 110 pass.
- **`npm run typecheck` and `npm run build`:** 0 errors.
- **Lint:** 281 warnings and 2 errors, the same as before the change.

**New tests:**
- `server/modules/remote/tests/controller/controller-proxy-preview-frame.test.ts`: 17 tests on the production route table. They cover the headers a hostile Host cannot change, 206 and 304 answers, the refusals (no cookie, a token, a missing or wrong Fetch Metadata header, a foreign `Origin`, other methods, look-alike paths), locked, revoked and expired sessions, a response cut by a lock or a revoke, and a forgotten, expired or revoked pairing.
- `server/modules/auth/tests/preview-frame-auth.test.ts`: 3 tests. `server/modules/remote/tests/policy/header-filter.test.ts`: 3 new tests.
- `server/modules/file-tree/tests/file-tree.routes.test.ts` and `html-preview-guard.test.ts`: the Host handler accepts the bridge and still refuses other callers.
- `src/modules/code-editor/tests/html-preview-isolated.test.tsx`: 10 tests, among them the Remote tab check and load, the fallback for nine statuses and a network failure, and "no frame gets `allow-same-origin`".
- `tests/e2e-remote/e2e-html-preview-frame.test.ts`: 7 tests on a real Controller and Host, among them a real revoke by the Host.

**Remote E2E suite (`npm run test:e2e-remote`):** 110 tests, 107 pass, 2 fail, on a loaded machine.
- `keeps typing responsive while a 25 MB upload runs through the same link` fails with a p95 of 442 ms. The same test fails on the base commit (p95 385 ms).
- `a 25 MB file arrives on the Host byte for byte` failed once with `REMOTE_QUOTA` (429) during the full run. It passed when run again alone.

**Browser check (headless Chrome 153 and Edge 158, DevTools protocol, a real Controller and Host with test data):**
- The status check of a tab (token, no cookie) gets 200 with the plain sandbox policy.
- The frame (`sandbox="allow-scripts"`, `src` through `/r/<peer>/...`) loads with 200 in three places: straight in the Controller page, one level down inside a same-origin frame, and in the page that carries the Remote tab policy (`?target=`). The browser sent `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: iframe` and the cookie.
- A hostile file ran its script: `scriptRan` yes, `origin` null. Its `fetch` calls to the Controller failed, its WebSockets did not open, and no request it made reached the server.
- The same URL in the address bar answers 401. The same URL with `fetch` and the cookie answers 401.

**What did not run:**
- Firefox, Safari (including iOS) and a phone-size viewport.
- The preview opened from the real Remote tab UI in a browser. The frames were inserted by a script in the same shape the app uses; the component itself is covered by Vitest.
- A Host that is a real separate machine or a real relay.

**Commits:** see `git log db2acb9..HEAD` on the branch.
