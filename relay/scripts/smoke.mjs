// Manual smoke test against a running relay (local `wrangler dev` or a deployed Worker).
//   node scripts/smoke.mjs <relay-url> <RELAY_SECRET>
//   e.g. node scripts/smoke.mjs http://127.0.0.1:8787 "$RELAY_SECRET"   (>= 32 characters, see README)
// /healthz is 200 only when the relay has a usable secret, so a FAIL there means "not configured".
// Creates a random link room: Host registers, Controller joins, one binary frame each way, Host destroys.
// Prints only PASS/FAIL lines; never prints the secret, tokens or the gate.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const [relayUrl, secret] = process.argv.slice(2);
if (!relayUrl || !secret) {
  console.error('usage: node scripts/smoke.mjs <relay-url> <RELAY_SECRET>');
  process.exit(2);
}

const base = new URL(relayUrl);
const wsBase = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}`;
const room = randomBytes(16).toString('hex');
const hostToken = randomBytes(32).toString('base64url');
const controllerToken = randomBytes(32).toString('base64url');
const ctl = createHash('sha256').update(controllerToken).digest('hex');
const gate = createHmac('sha256', secret).update(`link:${room}`).digest('hex');

function open(role) {
  const ws = new WebSocket(`${wsBase}/ws?kind=link&room=${room}&role=${role}&gate=${gate}`);
  const inbox = [];
  let wake;
  ws.on('message', (data, isBinary) => {
    inbox.push(isBinary ? { binary: new Uint8Array(data) } : { text: data.toString() });
    wake?.();
  });
  ws.on('close', (code) => {
    inbox.push({ close: code });
    wake?.();
  });
  const next = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for a frame')), 10_000);
      const take = () => {
        const item = inbox.shift();
        if (!item) return;
        clearTimeout(timer);
        wake = undefined;
        resolve(item);
      };
      wake = take;
      take();
    });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, next }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)));
    ws.on('error', () => undefined);
  });
}

const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
};

try {
  const health = await fetch(`${base.origin}/healthz`);
  check('healthz 200', health.status === 200);

  const host = await open('host');
  host.ws.send(JSON.stringify({ t: 'auth', token: hostToken, ctl }));
  check('host ready', JSON.stringify(await host.next()) === JSON.stringify({ text: '{"t":"ready"}' }));

  const controller = await open('controller');
  controller.ws.send(JSON.stringify({ t: 'auth', token: controllerToken }));
  check('controller ready', (await controller.next()).text === '{"t":"ready"}');
  check('controller sees peer up', (await controller.next()).text === '{"t":"peer","up":true}');
  check('host sees peer up', (await host.next()).text === '{"t":"peer","up":true}');

  controller.ws.send(new Uint8Array([1, 2, 3]));
  const atHost = await host.next();
  check('controller -> host binary', atHost.binary?.join() === '1,2,3');
  host.ws.send(new Uint8Array([9, 8]));
  const atController = await controller.next();
  check('host -> controller binary', atController.binary?.join() === '9,8');

  host.ws.send(JSON.stringify({ t: 'destroy' }));
  const closeHost = await host.next();
  check('destroy closes the host with 4410', closeHost.close === 4410);
  const closeController = await controller.next();
  check('destroy closes the controller with 4410', closeController.close === 4410);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  process.exitCode = 1;
}
process.exit();
