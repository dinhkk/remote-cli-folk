import { emitLinkEvent, requestTabToken } from '@/shared/transport/target-context';

// Registry codes (contracts.md section 9) that mean "the link to the Host is the
// problem", as opposed to an application error the Host itself reported.
const LINK_ERROR_CODES = new Set([
  'REMOTE_LINK_DOWN',
  'REMOTE_UPSTREAM_AUTH',
  'REMOTE_QUOTA',
  'REMOTE_TOO_LARGE',
  'REMOTE_PROTOCOL',
  'REMOTE_UNSUPPORTED_MODE',
  'REMOTE_INTERNAL',
]);

/**
 * What a Remote tab does with a response. Nothing the Host says may touch the
 * Controller's session, so there is no token refresh and no sign-out here: a
 * 401 may only mean the tab token needs renewing, and a 502/503 from the
 * Controller's own proxy is reported as a link problem for the status overlay.
 * Used by authenticatedFetch and by the fetch-based event stream.
 */
export const handleTargetResponse = (response: Response): void => {
  if (response.status === 401) {
    requestTabToken();
    return;
  }
  if (response.status !== 502 && response.status !== 503) {
    return;
  }
  void response
    .clone()
    .json()
    .then((body: { error?: { code?: unknown } }) => {
      const code = body?.error?.code;
      if (typeof code === 'string' && LINK_ERROR_CODES.has(code)) {
        emitLinkEvent({ kind: 'link-error', code, status: response.status });
      }
    })
    .catch(() => undefined);
};
