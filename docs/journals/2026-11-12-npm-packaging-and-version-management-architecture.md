# Technical Journal: Architecture Planning for NPM Packaging, Version Management & Zero-Config Auto-Initialization

**Date:** 2026-11-12  
**Author:** Claude Code Engineer  
**Status:** Plan Approved & Scaffolded  

---

## 1. Context & Motivation

Deploying and testing `claudecodeui-remote` across multiple workstations currently requires a manual, high-friction routine: copying source code, installing developer dependencies, and executing compilation pipelines (`npm run build:client && npm run build:server`) on each machine.

The goal of this architectural session was to design a production-grade distribution and update model:
1. **NPM Distribution:** Package the application as a public scoped package (`@tunghuynh/remotecli`) exposing the `remotecli` command (with `cloudcli` preserved as an alias).
2. **Zero-Config Onboarding:** Allow any user to run `npm install -g @tunghuynh/remotecli && remotecli` with instant automatic initialization of SQLite databases, encryption keys, and setup routes.
3. **In-App Version Checking & Self-Update:** Restore and modernize the Web UI update detection mechanism without third-party rate limits, allowing 1-click updates via `npm install -g @tunghuynh/remotecli@latest`.
4. **Developer Release Workflow:** Provide a single-command automated pipeline (`npm run release`) on the developer's workstation that handles verification, dual-bundle compilation, semantic version bumping, git tagging, and publishing to the NPM registry.

---

## 2. Key Architectural Decisions & Evidence

### 2.1 Zero-Config Database & Cryptographic Key Management
- **Persistence Layer:** `better-sqlite3` persists data at `~/.cloudcli/auth.db` in the user's home directory (`resolveDatabasePath()` in `server/modules/database/connection.ts`).
- **Automatic Migration:** Database schemas and migrations (`server/modules/database/migrations.ts`) run automatically upon server boot.
- **Admin Bootstrapping:** If no records exist in the `users` table, the frontend automatically routes to `/setup`, removing the need for manual credential seeding or `.env` files.
- **Remote Cryptographic Isolation:** The master encryption key (`~/.cloudcli/remote-master.key`) is generated on-demand with strict `0600` permissions. Relay configurations (`relay_url`, `relay_secret`) are sealed directly into the SQLite `app_config` table from the UI modal.
- **Upgrade Invariant:** Because the data directory (`~/.cloudcli/`) lives independently of the global `node_modules` install tree, upgrading the package never affects persisted chat sessions, project metadata, or paired remote links.

### 2.2 Scoped Package & Dynamic Metadata Resolution
- **Identity:** Package renamed from `@cloudcli-ai/cloudcli` to `@tunghuynh/remotecli`.
- **Pre-built Asset Distribution:** The NPM package `files` manifest is scoped strictly to pre-compiled artifacts:
  - `dist/` (Vite client bundle)
  - `dist-server/` (transpiled server JavaScript)
  - `public/api-docs.html`
  - `scripts/` (runtime permissions and node-pty hooks)
- **Eliminating Hardcoded Strings:** Replaced hardcoded `@cloudcli-ai/cloudcli` references across `cli.module.ts`, `cli.service.ts`, and `system.service.ts` with dynamic resolution from `package.json` metadata.

### 2.3 Server-Side NPM Registry Polling & UI Click-to-Update
- **Overcoming API Limitations:** The upstream implementation directly queried `api.github.com` from the browser, hitting client-side rate limits and network firewalls.
- **Backend Registry Lookup:** The backend server queries `https://registry.npmjs.org/@tunghuynh%2Fremotecli/latest` with an in-memory 1-hour cache.
- **Surface API:** The resolved latest version is exposed via the `/health` endpoint and `/api/system/version`.
- **Controlled Process Restart:** Following a successful `npm install -g @tunghuynh/remotecli@latest` executed by `/api/system/update`, the UI instructs the operator to restart the terminal process manually, preventing unexpected mid-stream WebSocket or SQLite transaction drops.

---

## 3. Implementation Plan Structure

The plan was recorded at `plans/20261112-npm-package-and-version-management/`:
- **Phase 0 (`phase-00-rebrand-and-rename-cloudcli-to-remotecli.md`):** Complete renaming from `cloudcli...` to `remotecli...` across storage paths (`~/.remotecli`), environment variables, protocols, storage keys, branding, and auto-migration of legacy data.
- **Phase 1 (`phase-01-package-config-and-metadata.md`):** Package naming, binary configuration, and dynamic metadata refactoring across backend CLI services.
- **Phase 2 (`phase-02-backend-version-check-update.md`):** NPM registry cache layer, version endpoint exposure, and self-update execution service.
- **Phase 3 (`phase-03-frontend-version-modal-ui.md`):** Frontend `useVersionCheck` hook reactivation, update badges, and `VersionUpgradeModal` integration.
- **Phase 4 (`phase-04-release-pipeline-and-packaging.md`):** `.release-it.json` automation, dry-run tarball inspection (`npm pack --dry-run`), and end-to-end zero-config validation.

---

## 4. Key Takeaways

1. **Decouple Data from Distribution:** Isolating SQLite and encryption keys in `~/.cloudcli/` guarantees seamless, zero-maintenance global NPM upgrades without state loss.
2. **Server-Side Registry Probing:** Delegating registry lookups to the local server with TTL caching avoids client-side CORS and API rate limits while keeping the frontend reactive and lightweight.
3. **Pre-Built Distribution:** Publishing pre-built client and server artifacts ensures target machines require only Node.js runtime, eliminating build toolchains on end-user machines.
