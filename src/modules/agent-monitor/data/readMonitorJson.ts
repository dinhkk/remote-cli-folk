import type { AgentMonitorSnapshot } from '@/shared/types';

/**
 * `unreachable` = the answer is not the monitor's JSON at all (an HTML page from a dev proxy or a gateway, a server that
 * predates this API, a body of the wrong shape): the server may be outdated, restart it. `http` = the server answered with
 * an error of its own (a status and, usually, a message).
 */
export type MonitorErrorKind = 'unreachable' | 'http';

export class MonitorApiError extends Error {
  readonly kind: MonitorErrorKind;

  readonly status: number;

  constructor(kind: MonitorErrorKind, message: string, status: number) {
    super(message);
    this.name = 'MonitorApiError';
    this.kind = kind;
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The fields the screens rely on: an outdated server that answers JSON without the project grouping fails this on purpose. */
export const isMonitorSnapshot = (value: unknown): value is AgentMonitorSnapshot =>
  isRecord(value)
  && typeof value.generatedAt === 'number'
  && isRecord(value.kpi)
  && Array.isArray(value.sessions)
  && Array.isArray(value.projects)
  && isRecord(value.resources);

/** The message of a server error body (`{ error: 'text' }` or `{ error: { message } }`), else the status line. */
function errorMessageOf(body: unknown, status: number): string {
  if (isRecord(body)) {
    const { error, message } = body;
    const text = isRecord(error) ? error.message : error ?? message;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return `Request failed (${status})`;
}

/**
 * Reads a monitor answer and refuses anything that is not what the monitor sends. Unlike a bare `response.json()` it never
 * lets an HTML page, an empty body or a JSON body of another shape pass for "nothing is running": each becomes an error the
 * screen shows with a retry button.
 */
export async function readMonitorJson<T>(response: Response, isShape: (value: unknown) => value is T): Promise<T> {
  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MonitorApiError('unreachable', `The answer is not JSON (status ${response.status}).`, response.status);
  }
  if (!response.ok) throw new MonitorApiError('http', errorMessageOf(body, response.status), response.status);
  if (!isShape(body)) throw new MonitorApiError('unreachable', 'The answer is JSON but not the monitor\'s.', response.status);
  return body;
}
