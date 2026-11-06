/** Longest detail line shown; the long values (what the Controller changed a command to) never go through it, they get a line of their own. */
const MAX_SUMMARY_LENGTH = 240;

/** The fields a Controller may change in an approval, as the audit names them. */
const CHANGE_FIELDS = ['command', 'path', 'url'] as const;
export type AuditChangeField = (typeof CHANGE_FIELDS)[number];

const upper = (field: AuditChangeField): string => field.charAt(0).toUpperCase() + field.slice(1);

/** Detail keys that belong to a change and are shown on the change's own line, not in the one-line summary. */
const CHANGE_KEYS: ReadonlySet<string> = new Set(
  CHANGE_FIELDS.flatMap((field) => [`updated${upper(field)}`, `${field}Changed`, `${field}Length`, `updated${upper(field)}Length`]),
);

type AuditDetail = Record<string, string | number | boolean>;

/**
 * One plain-text line for an audit entry's detail object: `key: value` pairs
 * joined by " · ", cut at a fixed length. Returns '' when there is no detail.
 * The change fields (`updatedCommand`, lengths, flags) are left out: they are shown by
 * `extractAuditChanges` on their own line. The result is only ever rendered as a React text node.
 */
export const summarizeAuditDetail = (detail: AuditDetail): string => {
  const line = Object.entries(detail)
    .filter(([key]) => !CHANGE_KEYS.has(key))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');
  return line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH)}…` : line;
};

/** A value the Controller changed before approving: what it was changed to and the lengths (null when the audit has none). */
export type AuditChange = { field: AuditChangeField; value: string; fromLength: number | null; toLength: number | null };

const asLength = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The changes recorded in an entry's detail (command, path, URL), each to be shown on a line of its own with a marker. */
export const extractAuditChanges = (detail: AuditDetail): AuditChange[] => {
  const changes: AuditChange[] = [];
  for (const field of CHANGE_FIELDS) {
    const value = detail[`updated${upper(field)}`];
    if (typeof value !== 'string') continue;
    changes.push({ field, value, fromLength: asLength(detail[`${field}Length`]), toLength: asLength(detail[`updated${upper(field)}Length`]) });
  }
  return changes;
};
