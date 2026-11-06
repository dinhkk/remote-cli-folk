/**
 * The event and result words the Host's audit log uses. Only these get a
 * translated label; anything else the server (or a hostile Controller) sends is
 * shown as the plain text it is. Used by AuditEntryRow and the locale test.
 */
export const AUDIT_EVENTS: readonly string[] = [
  'pair',
  'connect',
  'disconnect',
  'revoke',
  'expire',
  'tool-decision',
  'pty-open',
  'pty-close',
  'file-write',
  'host-write',
  'policy-deny',
  'quota-reject',
  'quota-disconnect',
];

export const AUDIT_RESULTS: readonly string[] = ['allow', 'deny', 'ok', 'refused', 'error', 'closed'];

/** Results that mean something was blocked or went wrong, shown in a warning tone. */
export const AUDIT_NEGATIVE_RESULTS: ReadonlySet<string> = new Set(['deny', 'refused', 'error']);
