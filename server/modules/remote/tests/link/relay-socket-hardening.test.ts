/**
 * The real `ws` relay socket against a hostile relay: nothing a relay sends, and nothing a consumer
 * throws while handling it, may become an uncaught exception (that would kill the whole server).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import type { RemoteRelaySocketHandlers } from '@/shared/types.js';

import { createRelayPairConnector } from '../../link/pair-connector.js';
import { createWsRelaySocketFactory } from '../../link/relay-socket.js';
import { waitFor } from '../support/relay-link-rig.js';

type Script = (ws: WebSocket) => void;

/** A relay that runs `script` on every accepted connection. */
const withHostileRelay = async (script: Script, body: (url: string) => Promise<void>): Promise<void> => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 16 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    ws.on('error', () => undefined);
    script(ws);
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    await body(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(uncaught, [], 'no uncaught exception');
  } finally {
    process.off('uncaughtException', onUncaught);
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
};

const target = { kind: 'pair', room: 'a'.repeat(32), role: 'host', gate: 'g'.repeat(64) } as const;

const record = (overrides: Partial<RemoteRelaySocketHandlers> = {}) => {
  const log: string[] = [];
  const handlers: RemoteRelaySocketHandlers = {
    onOpen: () => log.push('open'),
    onText: (text) => log.push(`text:${text.slice(0, 20)}`),
    onBinary: (data) => log.push(`binary:${data.length}`),
    onClose: (code, status) => log.push(`close:${code}${status ? `/${status}` : ''}`),
    ...overrides,
  };
  return { log, handlers };
};

test('a handler that throws on a text frame closes that socket with a protocol error and the process survives', async () => {
  await withHostileRelay(
    (ws) => ws.send('hello'),
    async (url) => {
      const { log, handlers } = record({
        onText: () => {
          throw new Error('consumer bug');
        },
      });
      createWsRelaySocketFactory()({ relayUrl: url, ...target }, handlers);
      await waitFor(() => log.some((entry) => entry.startsWith('close:')), 'the socket to close');
      assert.deepEqual(log.filter((entry) => entry.startsWith('close:')), ['close:1002']);
    },
  );
});

test('handlers that throw in onOpen, onBinary and onClose never escape either', async () => {
  const boom = () => {
    throw new Error('consumer bug');
  };
  await withHostileRelay(
    (ws) => ws.send(Buffer.from([1, 2, 3]), { binary: true }),
    async (url) => {
      const { log, handlers } = record({ onOpen: boom, onBinary: boom, onClose: (code) => (log.push(`close:${code}`), boom()) });
      createWsRelaySocketFactory()({ relayUrl: url, ...target }, handlers);
      await waitFor(() => log.some((entry) => entry.startsWith('close:')), 'the socket to close');
      assert.equal(log.filter((entry) => entry.startsWith('close:')).length, 1, 'onClose is reported once');
    },
  );
});

test('the pair connector survives null / string / number / array JSON texts sent by a relay over a real socket', async () => {
  await withHostileRelay(
    (ws) => {
      for (const text of ['null', '"str"', '123', '[]', '{"t":null}']) ws.send(text);
      ws.send('{"t":"ready"}');
    },
    async (url) => {
      const events: string[] = [];
      const connect = createRelayPairConnector({ relayUrl: url, relaySecret: 'secret' });
      connect(
        { roomId: 'a'.repeat(32), pairToken: 'tok', role: 'host' },
        {
          onReady: () => events.push('ready'),
          onPeer: () => events.push('peer'),
          onFrame: () => events.push('frame'),
          onClose: (code) => events.push(`close:${code}`),
        },
      );
      await waitFor(() => events.includes('ready'), 'ready after the junk');
      assert.deepEqual(events, ['ready']);
    },
  );
});

test('a pair-connector consumer that throws inside a callback gets its channel closed with a protocol error', async () => {
  await withHostileRelay(
    (ws) => ws.send('{"t":"ready"}'),
    async (url) => {
      const events: string[] = [];
      const connect = createRelayPairConnector({ relayUrl: url, relaySecret: 'secret' });
      connect(
        { roomId: 'a'.repeat(32), pairToken: 'tok', role: 'host' },
        {
          onReady: () => {
            throw new Error('ceremony bug');
          },
          onPeer: () => undefined,
          onFrame: () => undefined,
          onClose: (code) => events.push(`close:${code}`),
        },
      );
      await waitFor(() => events.length > 0, 'the channel to close');
      assert.deepEqual(events, ['close:1002']);
    },
  );
});

test('a huge text frame and invalid UTF-8 text close the socket (size / encoding violation) and never throw', async () => {
  for (const script of [
    (ws: WebSocket) => ws.send('x'.repeat(3 * 1024 * 1024)),
    (ws: WebSocket) => ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false }),
  ]) {
    await withHostileRelay(script, async (url) => {
      const { log, handlers } = record();
      createWsRelaySocketFactory()({ relayUrl: url, ...target }, handlers);
      await waitFor(() => log.some((entry) => entry.startsWith('close:')), 'the socket to close');
      assert.deepEqual(log.filter((entry) => entry.startsWith('text:')), [], 'the oversized/invalid text never reached the consumer');
      assert.match(log.at(-1) ?? '', /^close:(1006|1007|1009)$/);
    });
  }
});

test('invalid UTF-8 inside a BINARY frame is just bytes: delivered untouched, no decoding, no throw', async () => {
  await withHostileRelay(
    (ws) => ws.send(Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), { binary: true }),
    async (url) => {
      const { log, handlers } = record();
      createWsRelaySocketFactory()({ relayUrl: url, ...target }, handlers);
      await waitFor(() => log.includes('binary:5'), 'the binary frame');
    },
  );
});

test('closing a socket whose upgrade is still in flight is silent: no callback, no uncaught error, nothing sent', async () => {
  await withHostileRelay(
    () => undefined,
    async (url) => {
      const { log, handlers } = record();
      const socket = createWsRelaySocketFactory()({ relayUrl: url, ...target }, handlers);
      socket.close(1000); // still CONNECTING: terminate() makes ws emit an error and a close that must stay silent
      socket.sendText('late');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(log, []);
    },
  );
});

test('closing an open socket tells the relay (a close frame) and stays silent towards the owner', async () => {
  const serverSaw: number[] = [];
  await withHostileRelay(
    (ws) => ws.on('close', (code) => serverSaw.push(code)),
    async (url) => {
      const { log, handlers } = record();
      const socket = createWsRelaySocketFactory()({ relayUrl: url, ...target }, handlers);
      await waitFor(() => log.includes('open'), 'the socket to open');
      socket.close(4000);
      socket.close(4001); // idempotent
      await waitFor(() => serverSaw.length === 1, 'the relay to see the close');
      assert.deepEqual(serverSaw, [4000]);
      assert.deepEqual(log, ['open']);
    },
  );
});
