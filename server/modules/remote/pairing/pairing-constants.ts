/**
 * Numbers both pairing roles must agree on. Kept apart from either service so neither imports the
 * other's file.
 */

/** A pairing code (and the relay's pair room behind it) lives 5 minutes; the Controller's join gives up after the same time. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
