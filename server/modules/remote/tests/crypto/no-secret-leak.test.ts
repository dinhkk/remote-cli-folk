import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createControllerHandshake, createHostHandshakeListener, HandshakeError } from '../../crypto/handshake.js';
import { createSecureChannel } from '../../crypto/secure-channel.js';
import { createSecretBox, secretAad } from '../../crypto/secret-box.js';

const cryptoSourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'crypto');

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

test('crypto sources never write to the console or stdio', () => {
  const sources = fs.readdirSync(cryptoSourceDir).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length >= 4, 'expected the crypto sources to be present');
  for (const name of sources) {
    const source = fs.readFileSync(path.join(cryptoSourceDir, name), 'utf8');
    assert.ok(!/\bconsole\./.test(source), `${name} uses console`);
    assert.ok(!/process\.(stdout|stderr)/.test(source), `${name} writes to stdio`);
  }
});

test('a full handshake, traffic, failures and sealing log nothing containing secrets', async () => {
  const captured: string[] = [];
  const originals = new Map<string, unknown>();
  for (const method of CONSOLE_METHODS) {
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  }

  const k = Buffer.alloc(32, 0x5a);
  const plaintext = 'TOP-SECRET-PLAINTEXT-d3adb33f';
  let keysHex: string[] = [];
  try {
    const listener = createHostHandshakeListener({ k });
    const controller = createControllerHandshake({ k });
    const pending = listener.acceptHello1(controller.hello1);
    const completed = controller.completeWithHello2(pending.hello2);
    const hostKeys = pending.completeWithHello3(completed.hello3);
    keysHex = [completed.keys.sendKey, completed.keys.receiveKey, hostKeys.sendKey].map((key) => key.toString('hex'));

    const frames: Buffer[] = [];
    const sender = createSecureChannel({ ...completed.keys, transmit: (frame) => { frames.push(frame); } });
    const receiver = createSecureChannel({ ...hostKeys, transmit: () => undefined });
    await sender.send(Buffer.from(plaintext));
    receiver.receive(frames[0]);
    receiver.receive(Buffer.alloc(40, 0x10)); // bad frame
    try {
      receiver.receive(frames[0]); // replay -> fatal
    } catch {
      // expected
    }
    try {
      createControllerHandshake({ k: Buffer.alloc(32, 1) }).completeWithHello2(pending.hello2);
    } catch (error) {
      assert.ok(error instanceof HandshakeError);
    }

    const box = createSecretBox(k);
    box.open(box.seal(plaintext, secretAad('t', 'c', 'i')), secretAad('t', 'c', 'i'));
    try {
      box.open(box.seal(plaintext, secretAad('t', 'c', 'i')), secretAad('t', 'c', 'other'));
    } catch {
      // expected
    }
  } finally {
    for (const method of CONSOLE_METHODS) console[method] = originals.get(method) as never;
  }

  const output = captured.join('\n');
  const needles = [k.toString('hex'), k.toString('base64'), plaintext, ...keysHex];
  for (const needle of needles) assert.ok(!output.includes(needle), `leaked ${needle.slice(0, 8)}…`);
});
