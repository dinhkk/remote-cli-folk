/**
 * The Controller's receive budgets (contracts section 6): per stream, per pairing and global, the
 * biggest holder is cut first, drained streams stop counting, and the defaults/overrides resolve as documented.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_GLOBAL_RECEIVE_BUDGET_BYTES,
  DEFAULT_PAIRING_RECEIVE_BUDGET_BYTES,
  DEFAULT_RECEIVE_BUDGET_BYTES,
  createReceiveLedger,
  resolveReceiveBudgets,
} from '../../controller/receive-budget.js';

const MIB = 1024 * 1024;

/** A stream whose unread bytes the test sets; `cancel` records the cut and releases like a real stream's onClosed does. */
const fakeStream = () => {
  const state = { unread: 0, cut: false, release: (() => undefined) as () => void };
  return {
    state,
    stream: {
      unread: () => state.unread,
      cancel: () => {
        state.cut = true;
        state.release();
      },
    },
  };
};

describe('resolveReceiveBudgets', () => {
  it('defaults to 8 MiB per stream, 32 MiB per pairing and 128 MiB overall', () => {
    assert.deepEqual(resolveReceiveBudgets(), { perStream: 8 * MIB, perPairing: 32 * MIB, global: 128 * MIB });
    assert.equal(DEFAULT_RECEIVE_BUDGET_BYTES, 8 * MIB);
    assert.equal(DEFAULT_PAIRING_RECEIVE_BUDGET_BYTES, 32 * MIB);
    assert.equal(DEFAULT_GLOBAL_RECEIVE_BUDGET_BYTES, 128 * MIB);
  });

  it('takes MiB overrides from the environment, ignoring anything that is not a positive number', () => {
    const env = {
      CLOUDCLI_REMOTE_RECEIVE_BUDGET_STREAM_MIB: '2',
      CLOUDCLI_REMOTE_RECEIVE_BUDGET_PAIRING_MIB: '0',
      CLOUDCLI_REMOTE_RECEIVE_BUDGET_GLOBAL_MIB: 'lots',
    };
    assert.deepEqual(resolveReceiveBudgets(env), { perStream: 2 * MIB, perPairing: 32 * MIB, global: 128 * MIB });
  });

  it('lets explicit options win over the environment', () => {
    const env = { CLOUDCLI_REMOTE_RECEIVE_BUDGET_STREAM_MIB: '2' };
    assert.equal(resolveReceiveBudgets(env, { perStream: 1000 }).perStream, 1000);
  });
});

describe('receive ledger', () => {
  const budgets = { perStream: 100, perPairing: 250, global: 400 };

  const track = (ledger: ReturnType<typeof createReceiveLedger>, peerId: string) => {
    const { state, stream } = fakeStream();
    const ticket = ledger.track(peerId, stream);
    state.release = ticket.release;
    return { state, ticket };
  };

  it('cuts a stream over its own budget and leaves the others alone', () => {
    const ledger = createReceiveLedger(budgets);
    const a = track(ledger, 'p1');
    const b = track(ledger, 'p1');
    a.state.unread = 101;
    b.state.unread = 10;
    a.ticket.enforce();
    assert.equal(a.state.cut, true);
    assert.equal(b.state.cut, false);
    assert.equal(ledger.size, 1);
  });

  it('cuts the biggest holder of a pairing when the streams add up over the pairing budget, even if another stream was the writer', () => {
    const ledger = createReceiveLedger(budgets);
    const big = track(ledger, 'p1');
    const mid = track(ledger, 'p1');
    const writer = track(ledger, 'p1');
    big.state.unread = 95;
    mid.state.unread = 90;
    writer.state.unread = 80; // total 265 > 250, nobody over 100
    writer.ticket.enforce();
    assert.equal(big.state.cut, true, 'the biggest holder goes');
    assert.equal(mid.state.cut, false);
    assert.equal(writer.state.cut, false, 'the writer fits once the biggest is gone (170 <= 250)');
  });

  it('keeps cutting until the total fits', () => {
    const ledger = createReceiveLedger({ perStream: 100, perPairing: 150, global: 1000 });
    const streams = [90, 80, 70, 60].map((unread) => {
      const entry = track(ledger, 'p1');
      entry.state.unread = unread;
      return entry;
    });
    streams[3].ticket.enforce(); // total 300 > 150: 90 and 80 go (130 left)
    assert.deepEqual(streams.map((entry) => entry.state.cut), [true, true, false, false]);
  });

  it('does not mix pairings in the per-pairing budget, but does in the global one', () => {
    const ledger = createReceiveLedger(budgets);
    const a = track(ledger, 'p1');
    const b = track(ledger, 'p2');
    const c = track(ledger, 'p3');
    const d = track(ledger, 'p4');
    for (const entry of [a, b, c, d]) entry.state.unread = 90; // each pairing 90 <= 250; overall 360 <= 400
    d.ticket.enforce();
    assert.deepEqual([a, b, c, d].map((entry) => entry.state.cut), [false, false, false, false]);

    a.state.unread = 100;
    b.state.unread = 100;
    c.state.unread = 100;
    d.state.unread = 100; // overall 400, still fits
    d.ticket.enforce();
    assert.equal(d.state.cut, false);
    c.state.unread = 100;
    const e = track(ledger, 'p5');
    e.state.unread = 50; // overall 450 > 400: the biggest (first of the 100s) goes
    e.ticket.enforce();
    assert.equal([a, b, c, d].filter((entry) => entry.state.cut).length, 1);
    assert.equal(e.state.cut, false);
  });

  it('stops counting a stream that drained or was released', () => {
    const ledger = createReceiveLedger(budgets);
    const a = track(ledger, 'p1');
    const b = track(ledger, 'p1');
    const c = track(ledger, 'p1');
    a.state.unread = 100;
    b.state.unread = 100;
    c.state.unread = 100; // 300 > 250
    a.state.unread = 0; // the browser caught up on one of them
    c.ticket.enforce();
    assert.deepEqual([a, b, c].map((entry) => entry.state.cut), [false, false, false]);

    b.ticket.release();
    assert.equal(ledger.size, 2);
    b.state.unread = 1000;
    c.ticket.enforce();
    assert.equal(b.state.cut, false, 'a released stream is no longer cut');
  });

  it('enforce on a stream that was already cut does nothing', () => {
    const ledger = createReceiveLedger(budgets);
    const a = track(ledger, 'p1');
    a.state.unread = 500;
    a.ticket.enforce();
    assert.equal(a.state.cut, true);
    a.ticket.enforce();
    assert.equal(ledger.size, 0);
  });
});
