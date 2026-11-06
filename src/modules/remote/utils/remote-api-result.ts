import { readApiErrorMessage } from '@/shared/api';
import type { RemoteApiFailure, RemoteApiResult } from '@/shared/types';

/** Failure code for a 2xx answer whose body is not what the contract describes (also what a server without the Remote module gives when the SPA shell answers). */
export const MALFORMED_RESPONSE_CODE = 'MALFORMED_RESPONSE';

const readErrorCode = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const { error, code } = body as { error?: unknown; code?: unknown };
  const nested = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const found = typeof nested === 'string' ? nested : code;
  return typeof found === 'string' && found !== '' ? found : null;
};

/** Code of a refused password on an endpoint marked `*` (contracts.md section 10). */
const INVALID_CREDENTIALS_CODE = 'AUTH_INVALID_CREDENTIALS';

/**
 * True when a result says the typed account password was wrong: 403 with
 * AUTH_INVALID_CREDENTIALS (contracts.md section 10), or a bare 401 for
 * compatibility with a server that still answers that way. Any other 403 is a
 * refusal for another reason.
 */
export const isWrongPassword = (result: RemoteApiResult<unknown>): boolean =>
  !result.ok && ((result.status === 403 && result.code === INVALID_CREDENTIALS_CODE) || result.status === 401);

/** True when a result says too many password attempts were made (429, with a Retry-After the UI does not need). */
export const isPasswordLockout = (result: RemoteApiResult<unknown>): boolean => !result.ok && result.status === 429;

/**
 * Runs one management API request and folds every outcome into a value: the parsed
 * body on success, or `{ ok: false, status, code, message }` for a refusal, a
 * network error (status 0) or a body the parser rejects. Nothing throws, so the
 * screens can branch on a wrong password or a lockout without try/catch.
 * Used by useRemoteApi and the shared status poll.
 */
export const readRemoteResult = async <T>(
  request: () => Promise<Response>,
  parse: (body: unknown) => T | null,
): Promise<RemoteApiResult<T>> => {
  let response: Response;
  try {
    response = await request();
  } catch {
    return { ok: false, status: 0, code: null, message: null };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An empty or non-JSON body is read as "no details".
  }

  if (!response.ok) {
    const failure: RemoteApiFailure = {
      ok: false,
      status: response.status,
      code: readErrorCode(body),
      message: readApiErrorMessage(body),
    };
    return failure;
  }

  const data = parse(body);
  if (data === null) {
    return { ok: false, status: response.status, code: MALFORMED_RESPONSE_CODE, message: null };
  }
  return { ok: true, data };
};
