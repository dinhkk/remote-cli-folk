import type { ChatMessage } from '@/shared/types';
import { readBackgroundTaskStatus } from '@/modules/chat';

export function isAgentTaskMessage(m: ChatMessage): boolean {
  return Boolean(
    m.isSubagentContainer ||
    m.subagent ||
    m.workflow ||
    m.toolName === 'Workflow' ||
    (m.toolName === 'Bash' && readBackgroundTaskStatus(m) !== undefined)
  );
}
