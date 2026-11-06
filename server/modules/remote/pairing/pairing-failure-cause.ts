/**
 * A non-secret label for why a pairing could not be stored, so an operator can tell a key problem
 * (`MASTER_KEY_MISMATCH`, `SECRET_BOX_*`) from a full disk (`SQLITE_FULL`). Only a short code made of
 * letters, digits and underscores is kept; messages are never copied because they can embed values.
 */

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;

// Consumed by: the Host and Controller pairing services (`getFailureCause`).
export const describeFailureCause = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && SAFE_CODE.test(name) ? name : 'UnknownError';
};
