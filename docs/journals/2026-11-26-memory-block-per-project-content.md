# Memory Block Scope `project` Becomes Per-Project Content

**Date**: 2026-11-26 04:54
**Severity**: High
**Component**: agent-profiles (memory blocks), providers (Claude blocks MCP), Memory tab UI
**Status**: Resolved in working tree, not committed

## What Happened

A `project` memory block used to mean one fixed folder. It now means one definition with a separate content file per folder. Definitions live in `memory-blocks/<id>.json`. Content lives in `memory-block-contents/<id>/<hash>.json`, with its own `rev`, `lastWriter` and `updatedAt`. Agents see a project block only in a folder that has a content file, and only the Host (REST or UI) creates those files. The plan is in `plans/20261126-memory-block-per-project-content/`. All three phases are implemented in `wt-deploy`, uncommitted.

## The Brutal Truth

The design is right, but the blast radius is wide. `scope.directory` now returns 400, so any older frontend that creates a project block fails. The providers test seeds through the agent-profiles store and service with deep imports, each carrying an `oxlint-disable-next-line boundaries/dependencies` and a reason, because the barrel exports no test-only helpers. I could not get a fully green run of the affected suites, because this container lacks `otpauth`, `ps`, `qrcode`, `@xyflow/react` and the relay deps.

## Technical Details

- Migration is lazy and idempotent. Legacy files are backed up to `memory-blocks.legacy/` before any write. A failed run is retried on the next run.
- Hard removal (`DELETE .../contents?directory=&remove=true`) writes `<hash>.tomb` with the last `rev`, so a later re-create does not reuse a rev (no ABA).
- Lint: the three `boundaries` errors in `claude-blocks-mcp.test.ts` are resolved with documented disable comments; that file lints clean.
- Route inventory: 19 registrations / 230 rows, plan said 18.

## What We Tried

- Code review found 0 Critical and 0 High. Three Medium items were fixed: migration retry, the `scope.directory` 400 noted in CHANGELOG, and `expectedRev` on DELETE contents. Without `expectedRev`, an "empty" click could erase newer agent text.
- Test suites: server 3079 pass, 2 fail (`ps ENOENT`, relay deps missing). Frontend 239 files pass, 15 fail at load on missing modules. Targeted agent-profiles suites pass (249 server, 191 client).

## Root Cause Analysis

The old model conflated "project" with "one folder," and the new model needed a file per folder. Migration has to carry legacy data across that change, so it has to be defensive. Name clashes make it messier: a legacy project block that clashes with a global block stays visible only in its old folder. That is the reading the tests encode, but it was not explicitly confirmed.

## Lessons Learned

- Do not ship a REST contract break without a CHANGELOG entry and a version gate. Older UIs will fail silently on create.
- Test seeding that needs module internals gets a documented lint exception instead of widening the barrel.
- An "empty" action on a destructive write needs the same `expectedRev` guard as a normal write.

## Next Steps

1. Run the full lint in an environment with all dependencies installed.
2. Re-run `claude-blocks-mcp`, `allow-list-parity` and the route-scanner tests in an environment with `otpauth` installed.
3. Re-run the full server and frontend suites where `ps`, relay deps, `@xyflow/react` and `qrcode` exist.
4. Confirm the legacy-name-clash reading (legacy block visible in its old folder) with the product owner.
5. Commit only after steps 1 and 2. Then update the release note with the `scope.directory` break.
