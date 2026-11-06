/**
 * Audit write failures are swallowed (the request being audited never fails) but must not be invisible: the
 * runtime logs the error NAME once per interval, with no row content.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditService } from '../../audit/audit.service.js';
import { createWriteErrorLogger } from '../../audit/audit-write-error-log.js';
import { createManualClock } from '../support/manual-clock.js';

test('the first failure is logged at once, further ones within a minute are counted, and the next minute reports how many were missed', () => {
  const clock = createManualClock(1_700_000_000_000);
  const lines: string[] = [];
  const log = createWriteErrorLogger({ now: clock.now, warn: (line) => lines.push(line) });
  log('SqliteError');
  log('SqliteError');
  log('Error');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[WARN\] Remote audit write failed: SqliteError/);
  clock.advance(59_000);
  log('SqliteError');
  assert.equal(lines.length, 1);
  clock.advance(2_000);
  log('SqliteError');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /3 more failure/);
});

test('only an error name is ever written: not a message, not a path, not a row', () => {
  const lines: string[] = [];
  const log = createWriteErrorLogger({ now: () => 0, warn: (line) => lines.push(line) });
  log('database is locked: SECRET-DETAIL /home/me/.cloudcli/auth.db');
  log('Error with a very long name '.repeat(20));
  const all = lines.join('\n');
  assert.ok(!all.includes('SECRET-DETAIL'));
  assert.ok(!all.includes('/home/me'));
  assert.ok(lines.every((line) => line.length < 160));
});

test('a throwing warn never escapes, and the audit service reports failures through the hook it is given', () => {
  const clock = createManualClock(1_700_000_000_000);
  const log = createWriteErrorLogger({
    now: clock.now,
    warn: () => {
      throw new Error('stderr closed');
    },
  });
  assert.doesNotThrow(() => log('Error'));
  const lines: string[] = [];
  const audit = createAuditService({
    repository: {
      insert() {
        throw new Error('disk full');
      },
      list: () => [],
      listControllers: () => [],
      purgeBefore: () => 0,
    },
    clock,
    onWriteError: createWriteErrorLogger({ now: clock.now, warn: (line) => lines.push(line) }),
  });
  assert.doesNotThrow(() => audit.record({ pairingId: 'p', label: 'x' }, { event: 'connect', target: 'link', result: 'ok' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Error/);
});
