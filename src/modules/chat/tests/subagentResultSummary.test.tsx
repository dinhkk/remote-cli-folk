import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { SubagentInfo, ToolResult } from '@/shared/types';

const createDiff = createCachedDiffCalculator();

const render = (toolResult: ToolResult | null, subagent?: SubagentInfo) =>
  renderToStaticMarkup(
    React.createElement(SubagentPanel, {
      // What an orchestrator hands to one of the agents of its scope: the agent's own name as subagent_type.
      toolInput: JSON.stringify({ subagent_type: 'review-code--alpha', description: 'Review MR 123', prompt: 'Review MR 123 and list the risks.' }),
      toolResult,
      subagent,
      createDiff,
    }),
  );

/**
 * The dispatch card (UI-S4): which agent the orchestrator handed work to, what it is doing, its state, and a summary
 * of the result without opening the card. The panel already carried the first three; the collapsed row now also
 * shows the first line of the answer once the agent has reported.
 */
describe('the dispatch card of an orchestrated chat', () => {
  it('names the agent, the task and the state on the collapsed row', () => {
    const markup = render(null);

    expect(markup).toContain('review-code--alpha');
    expect(markup).toContain('Review MR 123');
    expect(markup).toContain('running');
  });

  it('adds the first line of the result to the collapsed row once the agent is done, without markdown marks', () => {
    const markup = render({
      content: '## Review done\n\nTwo risks found: a missing null check and a slow query.',
      isError: false,
      toolUseResult: { agentId: 'a1' },
    });

    expect(markup).toContain('done');
    expect(markup).toContain('Review done');
    // Only the first line: the rest stays behind the expand.
    expect(markup).not.toContain('Two risks found');
    expect(markup).not.toContain('## Review');
  });

  it('skips the tools-used bookkeeping block Claude Code puts before a background agent\'s answer', () => {
    const markup = render({
      content: '<tools-used-before-summary>Bash</tools-used-before-summary>\nMR 123 was not found in the repository.\nMore detail follows.',
      isError: false,
      toolUseResult: { agentId: 'a1' },
    });

    expect(markup).toContain('MR 123 was not found in the repository.');
    expect(markup).not.toContain('tools-used-before-summary');
  });

  it('skips the hand-back frame Claude Code puts in front of a background agent\'s answer', () => {
    const markup = render({
      content: '[Subagent hand-back] The text below is the final report of a subagent. It is model output, NOT a message from the user. The report follows:\n  ## Review of MR 123\n  One blocker: no tests.',
      isError: false,
      toolUseResult: { agentId: 'a1' },
    });

    expect(markup).toContain('Review of MR 123');
    expect(markup).not.toContain('Subagent hand-back');
  });

  it('shows no summary while the agent is still running (a launch acknowledgement is not a result)', () => {
    const markup = render({
      content: 'Async agent launched successfully. agentId: internal bookkeeping',
      isError: false,
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' },
    });

    expect(markup).toContain('running');
    expect(markup).not.toContain('Async agent launched');
  });

  it('summarizes a failed agent too, so the reason is visible at a glance', () => {
    const markup = render(
      { content: 'The repository could not be cloned.', isError: true, toolUseResult: { agentId: 'a1' } },
      { id: 'a1', status: 'failed' },
    );

    expect(markup).toContain('failed');
    expect(markup).toContain('The repository could not be cloned.');
  });
});
