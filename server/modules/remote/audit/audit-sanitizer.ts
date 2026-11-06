/**
 * Sanitising of everything that goes into the Host audit (FR-42, NFR-5): values are short, printable and
 * free of the secret patterns that commonly appear in shell commands. The audit is the one place where a
 * (shortened) command may be stored, so this is where "never store file contents, long commands or
 * secrets" is enforced: producers hand over raw strings, nothing reaches the database unmasked.
 *
 * Masking runs on the whole string BEFORE the cut, and the cut works on the masked text, so a secret that
 * straddles the 200-character boundary is never left half visible; a mask marker the cut would split is
 * dropped whole.
 *
 * The masks are a DENY-LIST of the credential shapes that commonly appear in commands (they cannot know an
 * arbitrary password): `key=value`, `--flag value`, JSON/YAML `"key": value`, HTTP headers (Authorization,
 * Cookie, Set-Cookie, X-Api-Key, X-Auth-Token, ...), `-u user:pass`, `-pSecret` / `-p secret` for the few
 * tools that take a password there, `scheme://user:pass@host` (password may contain `@`), PEM private keys
 * and the well-known token prefixes. The documentation says plainly that it is best-effort.
 */

/** Longest value stored (commands and paths). */
export const AUDIT_VALUE_MAX = 200;
/** Input cap before masking: bounds the regexp work for a hostile multi-megabyte "command". */
const MASK_INPUT_MAX = 2_000;
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_JSON = 2_000;
const MASK = '***';

type MaskReplacer = string | ((substring: string, ...groups: string[]) => string);
type MaskRule = readonly [pattern: RegExp, replacement: MaskReplacer];

/**
 * A value after `=`, `:` or a space: a double- or single-quoted string (backslash escapes, a missing closing
 * quote is tolerated, an optional leading backslash covers JSON inside a shell string) or a run of anything
 * but ASCII whitespace. Unicode spaces (no-break space, em space, ...) belong to the value: a shell does not
 * split on them. A value that is already masked is left alone, which keeps masking idempotent.
 */
const DOUBLE_QUOTED = String.raw`\\?"(?:\\.|[^"\\])*"?`;
const SINGLE_QUOTED = String.raw`\\?'(?:\\.|[^'\\])*'?`;
const BARE = String.raw`[^ \t\r\n]+`;
const VALUE = String.raw`(?!\*\*\*)(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${BARE})`;
/** The value of a header that may hold several `;`-separated credentials: up to the closing quote or the end of the line. */
const HEADER_VALUE = String.raw`(?!\*\*\*)(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^\s"'][^\r\n"']*)`;

/** An optional (possibly backslash-escaped) quote that closes a key: `"password"`, `\"password\"`. */
const KEY_END_QUOTE = String.raw`(?:\\?["'])?`;
/** Words that make a key a credential. */
const SECRET_WORDS = String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|cookie)`;

/** Tools whose `-p` / `-pSECRET` is a password (everywhere else `-p` is a port, a path flag, `mkdir -p`, ...). */
const PASSWORD_FLAG_CONTEXT = /\b(?:mysql[\w-]*|mariadb[\w-]*|sshpass|(?:docker|podman|nerdctl|buildah|skopeo)[ \t]+login|htpasswd)\b/i;
const PASSWORD_FLAG = new RegExp(String.raw`(^|[ \t])-p(?:([ \t]+)(?!-)|(?=[^ \t\r\n]))${VALUE}`, 'g');

/** `-u user:pass` style credentials of curl and friends; a plain user name or a `uid:gid` pair is left alone. */
const USER_FLAG = new RegExp(String.raw`(^|[ \t])((?:-u|--user|--proxy-user)(?:[ \t]+|=)?)(${VALUE})`, 'g');

const MASK_RULES: readonly MaskRule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY ${MASK}-----`],
  // Headers: Authorization takes the rest of the line (`Bearer x`, `Basic x`, `token x`), Cookie / Set-Cookie too (several `a=b; c=d` pairs).
  [new RegExp(String.raw`(\b(?:proxy-)?authorization${KEY_END_QUOTE}[ \t]*[:=][ \t]*)${HEADER_VALUE}`, 'gi'), `$1${MASK}`],
  [new RegExp(String.raw`(\b(?:set-)?cookie${KEY_END_QUOTE}[ \t]*:[ \t]*)${HEADER_VALUE}`, 'gi'), `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MASK}`],
  // `--token x`, `--password=x`, `--client-secret x`.
  [new RegExp(String.raw`(--?[\w-]*(?:token|password|passwd|secret|api-?key|access-?key|auth|bearer|credentials?)(?:=|[ \t]+))${VALUE}`, 'gi'), `$1${MASK}`],
  // `name=value` with a secret word in the name.
  [new RegExp(String.raw`(\b[\w.-]{0,64}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w.-]{0,64}\s*=\s*)${VALUE}`, 'gi'), `$1${MASK}`],
  // JSON / YAML / header style `"name": value`, `name: value`, `X-Api-Key: value`.
  [new RegExp(String.raw`(\b[\w.-]{0,64}${SECRET_WORDS}[\w.-]{0,64}${KEY_END_QUOTE}[ \t]*:[ \t]*)${VALUE}`, 'gi'), `$1${MASK}`],
  // Environment-style assignments: any UPPER_CASE name that ends in or contains a secret word.
  [new RegExp(String.raw`(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Z0-9_]*=)${VALUE}`, 'g'), `$1${MASK}`],
  [
    USER_FLAG,
    (match, lead, flag, value) => {
      const unquoted = value.replace(/^\\?["']/, '').replace(/["']+$/, '');
      return !unquoted.includes(':') || /^\d+:\d+$/.test(unquoted) ? match : `${lead}${flag}${MASK}`;
    },
  ],
  // Well-known token shapes (the whole token goes, so no recognisable prefix is left to be cut in half).
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{16,}/g, MASK],
  [/\bglpat-[0-9A-Za-z_-]{10,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Za-z]{16}\b/g, MASK],
  [/\bnpm_[A-Za-z0-9]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MASK],
  // user:password@host in URLs. The password may contain `@`: everything up to the LAST `@` before the host goes.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#]*@/gi, `$1${MASK}@`],
];

/** Replaces the secret patterns in `text` (also usable on its own, e.g. in tests). */
export const maskSecrets = (text: string): string => {
  let masked = text.length > MASK_INPUT_MAX ? text.slice(0, MASK_INPUT_MAX) : text;
  for (const [pattern, replacement] of MASK_RULES) masked = masked.replace(pattern, replacement as string);
  if (PASSWORD_FLAG_CONTEXT.test(masked)) masked = masked.replace(PASSWORD_FLAG, (_match, lead: string, gap?: string) => `${lead}-p${gap ?? ''}${MASK}`);
  return masked;
};

/**
 * C0/C1 control characters, the Unicode line/paragraph separators, and the invisible direction/zero-width
 * characters that can make a stored command or label read differently from what it is (U+200B-200F,
 * U+202A-202E, U+2066-2069, U+061C, U+FEFF). Written as escapes inside a string, so no editor can turn them
 * into line breaks.
 */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

/**
 * Printable form: control characters become `?`, then the text is cut to `max` characters (the cut is marked
 * with `…`). A mask marker the cut would split in two is dropped whole.
 */
const cut = (text: string, max: number): string => {
  const printable = text.replace(CONTROL_CHARACTERS, '?');
  if (printable.length <= max) return printable;
  let head = printable.slice(0, max - 1);
  if (printable[max - 1] === '*') head = head.replace(/\*{1,2}$/, '');
  return `${head}…`;
};

/** Masks, then shortens: the form in which a command, path or label is stored. */
export const sanitizeAuditText = (value: unknown, max = AUDIT_VALUE_MAX): string => cut(maskSecrets(String(value ?? '')), max);

/**
 * A `detail` object reduced to what may be stored: at most 12 keys of `[A-Za-z0-9_-]{1,32}`, values that are
 * strings (masked and cut), finite numbers or booleans. Anything else (objects, arrays, functions) is dropped,
 * and the whole JSON is cut down by removing keys when it is still over 2000 characters.
 */
export const sanitizeAuditDetail = (detail: Record<string, unknown> | undefined): Record<string, string | number | boolean> => {
  const clean: Record<string, string | number | boolean> = {};
  if (!detail || typeof detail !== 'object') return clean;
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(clean).length >= MAX_DETAIL_KEYS) break;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key) || key === '__proto__') continue;
    if (typeof value === 'string') clean[key] = sanitizeAuditText(value);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
  }
  while (JSON.stringify(clean).length > MAX_DETAIL_JSON) delete clean[Object.keys(clean).pop() as string];
  return clean;
};
