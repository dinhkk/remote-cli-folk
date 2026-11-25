import { api } from '@/shared/api';
import type { AgentMonitorKillRequest, AgentMonitorKillResponse, AgentMonitorKillResult } from '@/shared/types';

const RESULTS: readonly AgentMonitorKillResult[] = ['killed', 'stopped', 'gone', 'no-handle', 'unavailable', 'refused', 'error'];

const isResult = (value: unknown): value is AgentMonitorKillResult => typeof value === 'string' && (RESULTS as readonly string[]).includes(value);

/**
 * Asks the server to stop or kill a node. The server answers with a `result` word even on 403 (`refused`) and 500
 * (`error`), so the body is read whatever the status; a body that is not that (a gateway's HTML, a network failure) is `error`.
 * It never throws: the caller always gets a word to show.
 */
export async function sendMonitorKill(request: AgentMonitorKillRequest): Promise<AgentMonitorKillResponse> {
  try {
    const response = await api.agentMonitor.kill(request);
    const body: unknown = JSON.parse(await response.text());
    if (body && typeof body === 'object' && isResult((body as { result?: unknown }).result)) {
      const { result, count } = body as AgentMonitorKillResponse;
      return typeof count === 'number' ? { result, count } : { result };
    }
  } catch {
    // Falls through to `error`.
  }
  return { result: 'error' };
}
