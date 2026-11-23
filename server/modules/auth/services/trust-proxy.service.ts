import type express from 'express';

import { readAuthTransportConfig } from './session-transport.service.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Reads the TRUST_PROXY env value into what Express's `trust proxy` setting accepts: a hop
 * count ("1"), a boolean, or a named/CIDR range ("loopback", "10.0.0.0/8"). Unset means
 * "do not trust forwarded headers" (Express's default), returned as undefined.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

/**
 * Network-facing auth hardening applied once at startup:
 *  - sets Express `trust proxy` from TRUST_PROXY so the login limiter sees real client IPs
 *    behind a reverse proxy (and only then — a too-wide setting lets clients forge X-Forwarded-For);
 *  - warns once when X-Forwarded-For arrives while TRUST_PROXY is unset, because then every
 *    client shares the proxy's IP and one attacker can lock out everyone;
 *  - warns when listening beyond loopback without REMOTECLI_SETUP_TOKEN, since the first visitor
 *    to a fresh server can otherwise register the owner account.
 */
export function configureAuthHardening(
  app: express.Express,
  options: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): void {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const transport = readAuthTransportConfig(env);
  if (transport.trustProxyConfigured && transport.origins.length === 0) {
    warn('[auth] TRUST_PROXY is configured without explicit allowed origins; authentication relies on the forwarded Host.');
  }
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
    if (trustProxy === true) {
      warn(
        '[auth] TRUST_PROXY=true trusts every hop in X-Forwarded-For: a client can forge its IP and dodge or poison login limits unless your proxy overwrites that header. Prefer the exact number of proxies in front of this server.',
      );
    }
  } else {
    let warned = false;
    app.use((req, _res, next) => {
      if (!warned && req.headers['x-forwarded-for']) {
        warned = true;
        warn(
          '[auth] X-Forwarded-For received but TRUST_PROXY is not set: login limits will see the proxy IP for every client. Set TRUST_PROXY to the number of proxies in front of this server.',
        );
      }
      next();
    });
  }

  const host = env.HOST || '0.0.0.0';
  const setupToken = env.REMOTECLI_SETUP_TOKEN || env.CLOUDCLI_SETUP_TOKEN;
  if (!LOOPBACK_HOSTS.has(host) && !setupToken) {
    warn(
      `[auth] Listening on ${host} without REMOTECLI_SETUP_TOKEN: until the first account exists, anyone who can reach this server can register as its owner. Set REMOTECLI_SETUP_TOKEN to require a token.`,
    );
  }
}
