/**
 * What the audit keeps of a tool approval card (S1 tool approval, S2 question, S3 plan): the tool name and,
 * for a few tools, ONE short field that says what was approved (the command line, the path, the URL). File
 * contents, edit hunks, plans and answers are never copied (FR-42). The strings are only extracted here;
 * masking and the 200-character cut happen in the audit service.
 */

import crypto from 'node:crypto';

/** Which approval card a tool request is (requirements section 4.7). */
export type ToolApprovalKind = 'S1' | 'S2' | 'S3';

/** `ExitPlanMode` is the plan card (S3); `AskUserQuestion` and OpenCode `question` are the question card (S2); the rest asks for permission (S1). */
export const classifyToolApproval = (toolName: string): ToolApprovalKind => {
  const name = toolName.toLowerCase();
  if (name === 'exitplanmode') return 'S3';
  if (name === 'askuserquestion' || name === 'question') return 'S2';
  return 'S1';
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Only the start of a field is kept as text (the audit stores 200 characters; the extra room lets masking see a secret near the cut). */
const FIELD_MAX = 2_000;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Which of the three fields a tool's input carries, and the full (uncut) value. */
const pickField = (toolName: string, input: unknown): { field: 'command' | 'path' | 'url'; value: string } | undefined => {
  const fields = asRecord(input);
  if (!fields) return undefined;
  switch (toolName.toLowerCase()) {
    case 'bash': {
      const command = text(fields.command);
      return command === undefined ? undefined : { field: 'command', value: command };
    }
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit': {
      const path = text(fields.file_path) ?? text(fields.notebook_path) ?? text(fields.path);
      return path === undefined ? undefined : { field: 'path', value: path };
    }
    case 'webfetch': {
      const url = text(fields.url);
      return url === undefined ? undefined : { field: 'url', value: url };
    }
    default:
      return undefined;
  }
};

/** The kept form of one field: its start as text (for masking and the 200-character cut), and the length and SHA-256 of the WHOLE value (to tell two values apart). */
export type ToolFieldSummary = { text: string; length: number; sha256: string };

/** What is known about the one field of a tool input worth keeping. */
export type ToolFieldSummaries = { command?: ToolFieldSummary; path?: ToolFieldSummary; url?: ToolFieldSummary };

/**
 * The one field of a tool input worth keeping, by tool, with a fingerprint of the full value: comparing two
 * values by `sha256` (and `length`) is exact however long they are, so a change hidden behind a long shared
 * prefix cannot be missed. `{}` for tools whose input is content (plans, answers, edits).
 */
// Consumed by: the approval tracker of the Host bridge (when a Controller answers an approval card).
export const summarizeToolFields = (toolName: string, input: unknown): ToolFieldSummaries => {
  const picked = pickField(toolName, input);
  if (!picked) return {};
  return {
    [picked.field]: {
      text: picked.value.slice(0, FIELD_MAX),
      length: picked.value.length,
      sha256: crypto.createHash('sha256').update(picked.value).digest('hex'),
    },
  };
};

/** The one field of a tool input worth keeping, cut to its first 2000 characters; `{}` for tools whose input is content. */
export const summarizeToolInput = (toolName: string, input: unknown): { command?: string; path?: string; url?: string } => {
  const picked = pickField(toolName, input);
  return picked ? { [picked.field]: picked.value.slice(0, FIELD_MAX) } : {};
};
