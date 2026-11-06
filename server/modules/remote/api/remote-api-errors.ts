/**
 * JSON errors of the management API (contracts section 9: one registry of codes). Every refusal has the
 * same envelope as the server's global handler, `{ success: false, error: { code, message, details? } }`,
 * so the UI reads `error.code` the same way everywhere. Known domain errors (pairing, relay settings,
 * master key, link down, rejected bodies) are translated here; anything else is passed on to the global
 * handler, which answers a generic 500 without leaking details.
 *
 * Nothing in this file can see a secret: error messages come from our own error classes, which never
 * embed keys, tokens or passwords.
 */

import type { ErrorRequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';

import { InvalidPairCodeError } from '../crypto/key-derivation.js';
import { SecretBoxError } from '../crypto/secret-box.js';
import { RemoteLinkDownError } from '../link/relay-link.js';
import { PairingError } from '../pairing/pairing-host.service.js';
import { RemoteConfigError } from '../storage/remote-storage.service.js';

type MappedError = { status: number; code: string; message: string; details?: unknown; headers?: Record<string, string> };

const PAIRING_ERRORS: Record<PairingError['code'], { status: number; code: string }> = {
  PAIRING_LOCKED: { status: 423, code: 'REMOTE_PAIR_LOCKED' },
  PAIRING_LIMIT: { status: 409, code: 'REMOTE_PAIR_FULL' },
  PAIRING_NOT_FOUND: { status: 404, code: 'REMOTE_PAIR_NOT_FOUND' },
  PAIRING_NOT_READY: { status: 409, code: 'REMOTE_PAIR_NOT_READY' },
  INVALID_SAS: { status: 400, code: 'REMOTE_PAIR_INVALID_SAS' },
};

/** Errors `body-parser` raises carry a `type`; the ones that mean "the client sent something we refuse". */
const readBodyParserError = (error: unknown): MappedError | null => {
  const { type } = (error ?? {}) as { type?: unknown };
  if (typeof type !== 'string') return null;
  if (type === 'entity.too.large') return { status: 413, code: 'REMOTE_TOO_LARGE', message: 'The request body is too large.' };
  if (['entity.parse.failed', 'encoding.unsupported', 'charset.unsupported', 'request.size.invalid', 'request.aborted', 'entity.verify.failed'].includes(type)) {
    return { status: 400, code: 'REMOTE_BAD_REQUEST', message: 'The request body is not valid JSON.' };
  }
  return null;
};

const mapRemoteError = (error: unknown): MappedError | null => {
  if (error instanceof AppError) {
    const retryAfter = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      headers: error.code === 'AUTH_RATE_LIMITED' && typeof retryAfter === 'number' ? { 'Retry-After': String(retryAfter) } : undefined,
    };
  }
  if (error instanceof PairingError) {
    const { status, code } = PAIRING_ERRORS[error.code];
    return { status, code, message: error.message, details: error.lockedUntil === undefined ? undefined : { lockedUntil: error.lockedUntil } };
  }
  if (error instanceof InvalidPairCodeError) return { status: 400, code: 'REMOTE_PAIR_CODE_INVALID', message: error.message };
  if (error instanceof RemoteConfigError) return { status: 400, code: error.code, message: error.message };
  if (error instanceof SecretBoxError && (error.code === 'MASTER_KEY_MISMATCH' || error.code === 'MASTER_KEY_INVALID')) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof RemoteLinkDownError) return { status: 503, code: 'REMOTE_LINK_DOWN', message: error.message };
  return readBodyParserError(error);
};

/**
 * Sends one error answer in the management envelope.
 * Consumed by: the management guards and routes.
 */
export const sendRemoteError = (
  res: import('express').Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void => {
  res.status(status).json({ success: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
};

/**
 * Error middleware closing the management router: translates the errors above and forwards the rest.
 * Consumed by: the management routes (and the guard tests).
 */
export const remoteErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  const mapped = mapRemoteError(error);
  if (!mapped || res.headersSent) {
    next(error);
    return;
  }
  for (const [name, value] of Object.entries(mapped.headers ?? {})) res.setHeader(name, value);
  sendRemoteError(res, mapped.status, mapped.code, mapped.message, mapped.details);
};
