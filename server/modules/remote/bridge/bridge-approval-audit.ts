/**
 * Audit of approval decisions (FR-42, AC-32) as the Host sees them on a chat socket. The Host sends
 * `permission_request {requestId, toolName, input}` to the Controller; the Controller answers with
 * `chat.permission-response {requestId, allow, updatedInput?, message?}`. This tracker remembers, per
 * stream, what each request was (tool name and ONE short field: the command, path or URL), and when the
 * answer comes it reports one `tool-decision` event: tool, card kind (S1 tool, S2 question, S3 plan), allow
 * or deny, the original command and, when the Controller changed it (`updatedInput`), the changed one too.
 *
 * It never keeps or reports file contents, edit hunks, plans, answers to questions or the free-text
 * `message`: only the fields chosen by `summarizeToolInput`. The strings it passes on are masked and cut by
 * the audit service. It reads the existing stream bytes only; it never alters what is forwarded.
 */

import type { RemoteAuditEvent } from '@/shared/types.js';

import { classifyToolApproval, summarizeToolFields, type ToolFieldSummaries } from '../audit/tool-input-summary.js';

/** Host messages bigger than this are not inspected (a permission request is small). */
const MAX_INSPECTED_BYTES = 256 * 1024;
/** Requests remembered per socket; a Host with more unanswered cards than this forgets the oldest. */
const MAX_PENDING_REQUESTS = 64;

const FIELDS = ['command', 'path', 'url'] as const;

type PendingRequest = { toolName: string; fields: ToolFieldSummaries };

const parseObject = (data: Buffer): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export type ApprovalTracker = {
  /** A message the Host sent to the Controller. */
  observeHost(data: Buffer, binary: boolean): void;
  /** A message the Controller sent (already accepted by the WS policy): reports when it is an approval answer. */
  observeController(data: Buffer): void;
};

/**
 * Creates the tracker of one chat socket.
 * Consumed by: the WebSocket half of the Host bridge.
 */
export function createApprovalTracker(audit: (event: RemoteAuditEvent) => void): ApprovalTracker {
  const pending = new Map<string, PendingRequest>();

  return {
    observeHost(data, binary) {
      if (binary || data.length > MAX_INSPECTED_BYTES || !data.includes('permission_')) return;
      const message = parseObject(data);
      if (!message || typeof message.requestId !== 'string') return;
      if (message.kind === 'permission_request' && typeof message.toolName === 'string') {
        if (pending.size >= MAX_PENDING_REQUESTS) pending.delete(pending.keys().next().value as string);
        pending.set(message.requestId, { toolName: message.toolName, fields: summarizeToolFields(message.toolName, message.input) });
      } else if (message.kind === 'permission_resolved' || message.kind === 'permission_cancelled') {
        pending.delete(message.requestId);
      }
    },

    observeController(data) {
      if (data.length > MAX_INSPECTED_BYTES || !data.includes('permission-response')) return;
      const message = parseObject(data);
      if (!message || message.type !== 'chat.permission-response' || typeof message.requestId !== 'string') return;
      const request = pending.get(message.requestId);
      pending.delete(message.requestId);
      const toolName = request?.toolName ?? 'unknown';
      const detail: Record<string, unknown> = { tool: toolName, kind: classifyToolApproval(toolName), known: request !== undefined };
      const original = request?.fields ?? {};
      for (const field of FIELDS) if (original[field]) detail[field] = original[field].text;
      // The Controller may approve a DIFFERENT command than the one asked. The two are compared by their full
      // length and SHA-256 (never by the cut text), so a change after the 2000th, or the 200th, character still
      // counts; both lengths are kept next to the two (cut, later masked) texts.
      const updated = summarizeToolFields(toolName, message.updatedInput);
      for (const field of FIELDS) {
        const next = updated[field];
        if (!next || next.sha256 === original[field]?.sha256) continue;
        const name = field.charAt(0).toUpperCase() + field.slice(1);
        detail[`updated${name}`] = next.text;
        detail[`${field}Changed`] = true;
        if (original[field]) detail[`${field}Length`] = original[field].length;
        detail[`updated${name}Length`] = next.length;
      }
      audit({ event: 'tool-decision', target: toolName, result: message.allow ? 'allow' : 'deny', detail });
    },
  };
}
