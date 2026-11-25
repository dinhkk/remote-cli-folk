import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import jwt from 'jsonwebtoken';

import { userDb } from '../../database/index.js';

const key = randomBytes(32);
const TTL_SECONDS = 300;

export function isLoopbackAddress(address = ''): boolean {
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return address === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
}

/** Host bridge credentials never use the persisted login key or survive a process restart. */
export function issueLoopbackToken(): string {
  const user = userDb.getFirstUser();
  if (!user) throw new Error('Cannot issue a loopback token: no user exists yet');
  return jwt.sign({ typ: 'host-loopback', userId: user.id }, key, {
    algorithm: 'HS256', expiresIn: TTL_SECONDS, jwtid: randomUUID(),
  });
}

export function authenticateLoopback(token: string | undefined, address: string | undefined) {
  if (!token || !isLoopbackAddress(address)) return null;
  try {
    const claims = jwt.verify(token, key, { algorithms: ['HS256'] });
    if (typeof claims === 'string' || claims.typ !== 'host-loopback'
      || typeof claims.userId !== 'number' || typeof claims.exp !== 'number'
      || typeof claims.iat !== 'number' || claims.exp - claims.iat > TTL_SECONDS) return null;
    return userDb.getUserById(claims.userId) ?? null;
  } catch { return null; }
}
