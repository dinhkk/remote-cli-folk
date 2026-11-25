import assert from 'node:assert/strict';

import React from 'react';
import { render } from '@testing-library/react';
import { describe, it } from 'vitest';

import '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { formatMessageTimestamp } from '@/modules/chat/utils/chatFormatting';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, ToolGroupItem } from '@/shared/types';

const TIMESTAMP = '2026-08-19T12:00:00.000Z';
// Whatever the machine's time zone, the row must say what the formatter says.
const EXPECTED = formatMessageTimestamp(TIMESTAMP);

const renderMessage = (message: ChatMessage, prevMessage: ChatMessage | null = null) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent
        message={message}
        prevMessage={prevMessage}
        createDiff={() => []}
        provider="claude"
        showThinking
      />
    </UiPreferencesProvider>,
  );

const timeLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="message-time"]'));

describe('the time stamped on a transcript row', () => {
  it('is shown on a reply that follows another reply', () => {
    const previous: ChatMessage = { type: 'assistant', content: 'First.', timestamp: TIMESTAMP };
    const { container } = renderMessage(
      { type: 'assistant', content: 'Second.', timestamp: TIMESTAMP },
      previous,
    );

    assert.ok(container.querySelector('.chat-message.assistant.grouped'), 'the row is grouped with the one above');
    const [label] = timeLabels(container);
    assert.equal(label?.textContent, EXPECTED);
  });

  it('is shown on a tool row that follows another tool row', () => {
    const previous: ChatMessage = { type: 'assistant', content: '', timestamp: TIMESTAMP, isToolUse: true, toolName: 'Read' };
    const { container } = renderMessage(
      { type: 'assistant', content: '', timestamp: TIMESTAMP, isToolUse: true, toolName: 'Read', toolInput: '{}' },
      previous,
    );

    assert.equal(timeLabels(container).length, 1);
  });

  it('is shown on a compaction row', () => {
    const { container } = renderMessage({
      type: 'assistant',
      content: 'Compacted auto',
      timestamp: TIMESTAMP,
      compact: { phase: 'done' },
    });

    assert.equal(timeLabels(container)[0]?.textContent, EXPECTED);
  });

  it('is shown on a task notification row', () => {
    const { container } = renderMessage({
      type: 'assistant',
      content: 'Task finished',
      timestamp: TIMESTAMP,
      isTaskNotification: true,
      taskNotificationStatus: 'completed',
    });

    assert.equal(timeLabels(container)[0]?.textContent, EXPECTED);
  });

  it('is shown exactly once on a reasoning row', () => {
    // The reasoning body stays mounted while collapsed, so a time drawn inside
    // it as well as in the row footer would show twice once it is opened.
    const { container } = renderMessage({
      type: 'assistant',
      content: 'Thinking it over.',
      timestamp: TIMESTAMP,
      isThinking: true,
    });

    const labels = timeLabels(container);
    assert.equal(labels.length, 1);
    assert.equal(labels[0]?.textContent, EXPECTED);
  });

  it('is shown on a user turn', () => {
    const { container } = renderMessage({ type: 'user', content: 'Hello.', timestamp: TIMESTAMP });

    assert.equal(timeLabels(container)[0]?.textContent, EXPECTED);
  });

  it('carries the full date and seconds in its tooltip', () => {
    const { container } = renderMessage({ type: 'user', content: 'Hello.', timestamp: TIMESTAMP });

    assert.match(timeLabels(container)[0]?.getAttribute('title') ?? '', /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  it('is left out, with no empty span, when the row has no usable timestamp', () => {
    // The type requires a timestamp, but rows built from older or partial
    // provider data reach the renderer without one.
    const missing = renderMessage({ type: 'assistant', content: 'No time.' } as unknown as ChatMessage);
    assert.equal(timeLabels(missing.container).length, 0);

    const invalid = renderMessage({ type: 'assistant', content: 'Bad time.', timestamp: 'not-a-date' });
    assert.equal(timeLabels(invalid.container).length, 0);
  });
});

describe('the time on a collapsed tool group', () => {
  const group: ToolGroupItem = {
    _isGroup: true,
    toolName: 'Read',
    timestamp: TIMESTAMP,
    preview: '/a.ts, /b.ts',
    messages: [
      { type: 'assistant', content: '', timestamp: TIMESTAMP, isToolUse: true, toolName: 'Read', toolInput: '{"file_path":"/a.ts"}' },
      { type: 'assistant', content: '', timestamp: '2026-08-19T12:05:00.000Z', isToolUse: true, toolName: 'Read', toolInput: '{"file_path":"/b.ts"}' },
    ],
  };

  it("shows the first call's time on the summary line", () => {
    const { container } = render(
      <UiPreferencesProvider>
        <ToolGroupContainer
          group={group}
          prevMessage={null}
          createDiff={() => []}
          getMessageKey={(message) => String(message.timestamp)}
          provider="claude"
        />
      </UiPreferencesProvider>,
    );

    const labels = timeLabels(container);
    assert.equal(labels.length, 1, 'the children are not rendered while collapsed');
    assert.equal(labels[0]?.textContent, EXPECTED);
  });
});
