# Technical Journal: Bounded Queue Retry and Draft Reconciliation

**Date:** 2026-11-28
**Author:** ai-dev-01 (AI coding agent)
**Status:** Local verification

## 1. Problem Statement & Motivation

A retained startup failure was retried every 30 seconds without a limit. Draft
reconciliation also fetched all drafts every 10 seconds when the chat had no queue.

## 2. Key Architectural Decisions & Implementation

### Phase 1: Typed Startup Outcomes

The gateway distinguishes waiting from permanent refusal. Unknown exceptions are
temporary. Retry stops immediately for permanent refusal or after 3 temporary failures.
The existing queued JSON stores the budget across restarts. Waiting consumes no attempt.

### Phase 2: Scoped Reconciliation

A never-queued chat makes no timer requests. Pending queues use the 10-second interval.
After a claim, fast recovery lasts 30 seconds, followed by a 30-second slow watch.
Paused cards use the slow watch. Edit/delete and unmount stop watching. The slow watch
preserves late-failure recovery without continuously polling every idle chat.

## 3. Verification & Quality Gates

Fake-clock tests measure 60 seconds at the production interval: baseline idle 6
requests, revised idle 0; baseline late recovery 6, revised slow recovery 2. Local
queue fixtures verify capped writes/logging, persistence after database reopen and
immediate dispatch after a busy session becomes idle. Actual Host verification is
separate from these local fixtures.
