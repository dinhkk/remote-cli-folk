import type { ImportBasis, ImportOptions, ImportPlan } from '@/shared/types';

/** The server refuses a bundle body over 5 MB; the client checks first so the user gets a clear message instead of a failed request. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** The project choice that leaves a source folder out of the import (a `<select>` value). */
export const SKIP_FOLDER = '';

/** Item and folder codes that have a human wording under `bundle.codes.<code>`. */
export const BUNDLE_CODES = [
  'CONFLICT', 'IDENTICAL', 'SENSITIVE_NOT_ACCEPTED', 'STALE', 'BASIS_REQUIRED', 'BLOCK_SCOPE_IMMUTABLE', 'BLOCK_NAME_AMBIGUOUS',
  'BLOCK_NOT_MIGRATED', 'BLOCK_CONTENT_CORRUPT', 'BLOCK_LIMIT_REACHED', 'BLOCK_CONTENT_LIMIT_REACHED', 'BLOCK_TOO_LARGE',
  'DUPLICATE_KEY', 'DUPLICATE_TARGET_FOLDER', 'no-target-folder', 'FOLDER_TEXT_HOST_ONLY', 'DEFINITION_NOT_APPLIED', 'BLOCK_READ_ONLY',
] as const;

/** What the user chose in a preview: the ticked keys and, per source folder key, the sidebar project id (or {@link SKIP_FOLDER}). */
type ImportChoices = {
  overwrite: ReadonlySet<string>;
  acceptSensitive: ReadonlySet<string>;
  projectMap: Readonly<Record<string, string>>;
};

/** Size of the text in UTF-8 bytes, which is what the server counts. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Whether the text is over the size the server accepts. */
export function isBundleTooLarge(text: string): boolean {
  // A code unit takes 1 to 3 bytes: the extremes decide without encoding a multi-megabyte string on every keystroke.
  if (text.length > MAX_BUNDLE_BYTES) return true;
  if (text.length * 3 <= MAX_BUNDLE_BYTES) return false;
  return byteLength(text) > MAX_BUNDLE_BYTES;
}

/** Whole megabytes with one decimal, for the "too large" message. */
export function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** The distinct source folders of a plan (one entry per `sourceKey`, first seen wins), which is what the mapping UI lists. */
export function sourceFolders(plan: ImportPlan): { sourceKey: string; sourceDirectory: string }[] {
  const seen = new Map<string, string>();
  for (const item of plan.items) {
    for (const folder of item.folders ?? []) {
      if (!seen.has(folder.sourceKey)) seen.set(folder.sourceKey, folder.sourceDirectory);
    }
  }
  return [...seen].map(([sourceKey, sourceDirectory]) => ({ sourceKey, sourceDirectory }));
}

/**
 * Turns the plan and the user's ticks into the apply request options. Ticks of keys the plan does not have are dropped,
 * skipped folders get no mapping, and the `basis` of every ticked row is copied from the plan so apply can refuse a
 * target that changed since the preview.
 */
export function buildImportOptions(plan: ImportPlan, choices: ImportChoices): Required<Pick<ImportOptions, 'overwrite' | 'acceptSensitive' | 'projectMap' | 'basis'>> {
  const basisOf = new Map<string, ImportBasis>();
  for (const item of plan.items) {
    basisOf.set(item.key, item.basis);
    for (const folder of item.folders ?? []) basisOf.set(folder.key, folder.basis);
  }
  const overwrite = [...choices.overwrite].filter((key) => basisOf.has(key));
  const acceptSensitive = [...choices.acceptSensitive].filter((key) => basisOf.has(key));
  const basis: Record<string, ImportBasis> = {};
  for (const key of [...overwrite, ...acceptSensitive]) basis[key] = basisOf.get(key)!;
  const projectMap = Object.fromEntries(Object.entries(choices.projectMap).filter(([, projectId]) => projectId !== SKIP_FOLDER));
  return { overwrite, acceptSensitive, projectMap, basis };
}

/** The i18n key of a code's wording, or null when the code has none (the server's own reason is shown instead). */
export function codeKey(code: string | undefined): string | null {
  return code && (BUNDLE_CODES as readonly string[]).includes(code) ? `bundle.codes.${code}` : null;
}

/** The i18n key (and values) that word a sensitive reason such as `mcpServers` or `tool:Bash`. */
export function sensitiveReasonKey(reason: string): { key: string; values: { name?: string } } {
  if (reason.startsWith('tool:')) return { key: 'bundle.sensitive.tool', values: { name: reason.slice('tool:'.length) } };
  return { key: `bundle.sensitive.${reason}`, values: {} };
}

/** Saves text as a file through the browser's download (an object URL and a temporary link). */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
