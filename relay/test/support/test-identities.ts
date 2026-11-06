// Test identities: random b64url relay tokens plus the hex SHA-256 the relay stores/compares.
// Uses only WebCrypto so it runs in workerd and in Node.

import type { Role } from './relay-harness';

const encoder = new TextEncoder();

export const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const toB64Url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomHex = (byteLength: number): string => toHex(crypto.getRandomValues(new Uint8Array(byteLength)));

/** SHA-256 over the UTF-8 bytes of the token string exactly as sent on the wire. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

export interface LinkIdentity {
  hostToken: string;
  controllerToken: string;
  /** hex SHA-256(controllerToken), sent by the Host in its first auth frame. */
  ctl: string;
}

export const randomToken = (): string => toB64Url(crypto.getRandomValues(new Uint8Array(32)));

export async function makeLinkIdentity(): Promise<LinkIdentity> {
  const hostToken = randomToken();
  const controllerToken = randomToken();
  return { hostToken, controllerToken, ctl: await sha256Hex(controllerToken) };
}

export const newRoomId = (): string => randomHex(16);

export const authFrame = (token: string, ctl?: string): { t: 'auth'; token: string; ctl?: string } =>
  ctl === undefined ? { t: 'auth', token } : { t: 'auth', token, ctl };

export const tokenFor = (identity: LinkIdentity, role: Role): string =>
  role === 'host' ? identity.hostToken : identity.controllerToken;
