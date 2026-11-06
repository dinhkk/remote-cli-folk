import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteRelaySocket, RemoteRelaySocketHandlers, RemoteRelaySocketTarget } from '@/shared/types.js';

import { createRelayPairConnector } from '../../link/pair-connector.js';

/** A scripted socket: the test plays the relay. */
const setup = () => {
  const sent: Array<string | Uint8Array> = [];
  const state = { closedWith: undefined as number | undefined, closeCalls: 0, target: undefined as RemoteRelaySocketTarget | undefined, failSends: false };
  const holder: { handlers?: RemoteRelaySocketHandlers } = {};
  const socket: RemoteRelaySocket = {
    sendText: (text) => void sent.push(text),
    sendBinary: async (data) => {
      if (state.failSends) throw new Error('socket gone');
      sent.push(data);
    },
    close: (code) => {
      state.closeCalls += 1;
      state.closedWith = code;
    },
  };
  const connect = createRelayPairConnector({
    relayUrl: 'wss://relay.example',
    relaySecret: 'secret',
    socketFactory: (target, handlers) => {
      state.target = target;
      holder.handlers = handlers;
      return socket;
    },
  });
  const events: string[] = [];
  const channel = connect(
    { roomId: 'a'.repeat(32), pairToken: 'tok', role: 'controller' },
    {
      onReady: () => events.push('ready'),
      onPeer: (up) => events.push(`peer:${up}`),
      onFrame: (frame) => events.push(`frame:${frame.length}`),
      onClose: (code) => events.push(`close:${code}`),
    },
  );
  return { channel, events, sent, state, relay: holder.handlers as RemoteRelaySocketHandlers };
};

test('connects to a pair room with the derived gate and authenticates with the pair token once open', () => {
  const { relay, sent, state } = setup();
  assert.equal(state.target?.kind, 'pair');
  assert.equal(state.target?.role, 'controller');
  assert.match(state.target?.gate ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(sent, []);
  relay.onOpen();
  assert.deepEqual(sent, ['{"t":"auth","token":"tok"}']);
});

test('relay texts and frames reach the ceremony; junk and unknown texts are ignored', () => {
  const { relay, events } = setup();
  relay.onText('{"t":"ready"}');
  relay.onText('{"t":"peer","up":true}');
  relay.onText('{"t":"peer","up":"yes"}');
  relay.onText('{"t":"something-else"}');
  relay.onText('not json');
  relay.onText('{"t":"peer","up":false}');
  relay.onBinary(Buffer.alloc(5));
  assert.deepEqual(events, ['ready', 'peer:true', 'peer:false', 'peer:false', 'frame:5']);
});

test('JSON texts that are not objects (null, string, number, array, boolean) never throw out of the socket listener', () => {
  const { relay, events } = setup();
  for (const text of ['null', '"str"', '123', '[]', 'true', 'x'.repeat(3 * 1024 * 1024), '{"t":null}', '{"t":{"x":1}}']) {
    assert.doesNotThrow(() => relay.onText(text), `text ${text.slice(0, 12)}`);
  }
  assert.deepEqual(events, []);
  relay.onText('{"t":"ready"}');
  assert.deepEqual(events, ['ready'], 'the connector still works afterwards');
});

test('an upgrade the relay refused keeps its HTTP status: 401/403/503 are rejections, anything else is unavailable', () => {
  const closes: number[][] = [];
  const connectWith = (httpStatus: number | undefined, code = 0) => {
    const holder: { handlers?: RemoteRelaySocketHandlers } = {};
    const connect = createRelayPairConnector({
      relayUrl: 'wss://relay.example',
      relaySecret: 'secret',
      socketFactory: (_target, handlers) => {
        holder.handlers = handlers;
        return { sendText: () => undefined, sendBinary: () => undefined, close: () => undefined };
      },
    });
    connect(
      { roomId: 'a'.repeat(32), pairToken: 'tok', role: 'host' },
      { onReady: () => undefined, onPeer: () => undefined, onFrame: () => undefined, onClose: (closeCode) => closes.push([closeCode]) },
    );
    holder.handlers?.onClose(code, httpStatus);
  };
  connectWith(401);
  connectWith(403);
  connectWith(503);
  connectWith(400);
  connectWith(502);
  connectWith(undefined, 1006);
  connectWith(undefined, 4404);
  assert.deepEqual(closes, [[4401], [4401], [4401], [0], [0], [1006], [4404]]);
});

test('close reports the relay code once; later traffic and sends are dropped', () => {
  const { channel, relay, events, sent } = setup();
  relay.onClose(4410);
  relay.onClose(1006);
  relay.onText('{"t":"ready"}');
  relay.onBinary(Buffer.alloc(1));
  channel.sendFrame(Buffer.alloc(1));
  channel.sendDestroy();
  channel.close();
  assert.deepEqual(events, ['close:4410']);
  assert.deepEqual(sent, []);
});

test('sendFrame/sendDestroy go out while open; a failing send is swallowed; close() is silent and idempotent', async () => {
  const { channel, relay, events, sent, state } = setup();
  channel.sendFrame(Buffer.from([7]));
  channel.sendDestroy();
  state.failSends = true;
  channel.sendFrame(Buffer.from([8])); // rejection must not become an unhandled rejection
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(sent[1], '{"t":"destroy"}');
  channel.close();
  channel.close();
  relay.onClose(1000);
  assert.equal(state.closeCalls, 1);
  assert.equal(state.closedWith, 1000);
  assert.deepEqual(events, []);
});
