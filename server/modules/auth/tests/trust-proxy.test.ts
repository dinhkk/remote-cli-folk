import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { configureAuthHardening, parseTrustProxy } from '../services/trust-proxy.service.js';

async function requestIp(
  env: NodeJS.ProcessEnv,
  headers: Record<string, string>,
  warnings: string[],
  requests = 1,
): Promise<string> {
  const app = express();
  configureAuthHardening(app, { env, warn: (message) => warnings.push(message) });
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    let ip = '';
    for (let i = 0; i < requests; i += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
      ip = ((await response.json()) as { ip: string }).ip;
    }
    return ip;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('parseTrustProxy understands hop counts, booleans and named ranges', () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(''), undefined);
  assert.equal(parseTrustProxy('0'), 0);
  assert.equal(parseTrustProxy(' 2 '), 2);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
});

test('TRUST_PROXY=1 takes req.ip from X-Forwarded-For', async () => {
  const warnings: string[] = [];
  const ip = await requestIp({ TRUST_PROXY: '1', HOST: '127.0.0.1' }, { 'x-forwarded-for': '203.0.113.9' }, warnings);

  assert.equal(ip, '203.0.113.9');
  assert.equal(warnings.some((message) => message.includes('X-Forwarded-For')), false);
});

test('TRUST_PROXY=true warns that every hop is trusted; a hop count does not', () => {
  const trusting: string[] = [];
  configureAuthHardening(express(), { env: { TRUST_PROXY: 'true', HOST: '127.0.0.1' }, warn: (m) => trusting.push(m) });
  assert.equal(trusting.filter((message) => message.includes('TRUST_PROXY=true')).length, 1);

  const counted: string[] = [];
  configureAuthHardening(express(), { env: { TRUST_PROXY: '1', HOST: '127.0.0.1' }, warn: (m) => counted.push(m) });
  assert.deepEqual(counted, []);
});

test('without TRUST_PROXY req.ip is the socket address and a forwarded header warns once', async () => {
  const warnings: string[] = [];
  const ip = await requestIp({ HOST: '127.0.0.1' }, { 'x-forwarded-for': '203.0.113.9' }, warnings, 3);

  assert.match(ip, /127\.0\.0\.1$/);
  assert.equal(warnings.filter((message) => message.includes('X-Forwarded-For')).length, 1);
});

test('TRUST_PROXY=loopback trusts a forwarded header from a loopback peer', async () => {
  const ip = await requestIp({ TRUST_PROXY: 'loopback', HOST: '127.0.0.1' }, { 'x-forwarded-for': '203.0.113.7' }, []);

  assert.equal(ip, '203.0.113.7');
});

test('no forwarded header and no TRUST_PROXY: no warning', async () => {
  const warnings: string[] = [];
  await requestIp({ HOST: '127.0.0.1' }, {}, warnings);

  assert.deepEqual(warnings, []);
});

test('binding beyond loopback without REMOTECLI_SETUP_TOKEN warns at startup', () => {
  const warnings: string[] = [];
  configureAuthHardening(express(), { env: { HOST: '0.0.0.0' }, warn: (message) => warnings.push(message) });
  assert.equal(warnings.filter((message) => message.includes('REMOTECLI_SETUP_TOKEN')).length, 1);

  const lan: string[] = [];
  configureAuthHardening(express(), { env: { HOST: '192.168.1.5' }, warn: (message) => lan.push(message) });
  assert.equal(lan.filter((message) => message.includes('REMOTECLI_SETUP_TOKEN')).length, 1);

  const unsetHost: string[] = [];
  configureAuthHardening(express(), { env: {}, warn: (message) => unsetHost.push(message) });
  assert.equal(unsetHost.filter((message) => message.includes('REMOTECLI_SETUP_TOKEN')).length, 1, 'HOST defaults to 0.0.0.0');
});

test('no startup warning on loopback or when the setup token is set', () => {
  for (const env of [
    { HOST: '127.0.0.1' },
    { HOST: '::1' },
    { HOST: 'localhost' },
    { HOST: '0.0.0.0', REMOTECLI_SETUP_TOKEN: 'set' },
    { HOST: '0.0.0.0', CLOUDCLI_SETUP_TOKEN: 'set' },
  ]) {
    const warnings: string[] = [];
    configureAuthHardening(express(), { env, warn: (message) => warnings.push(message) });
    assert.equal(warnings.filter((message) => message.includes('REMOTECLI_SETUP_TOKEN')).length, 0, JSON.stringify(env));
  }
});
