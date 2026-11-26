import assert from 'node:assert/strict';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import '@/modules/i18n';

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => {}, stop: () => {} }),
}));
vi.mock('@/modules/chat/composer/ExpiredPermissionNotice', () => ({ default: () => null }));

const noop = () => {};

/** Mount the real composer and submit button with no network or provider process. */
function renderComposer(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  const props: ComponentProps<typeof ChatComposer> = {
    pendingPermissionRequests: [], handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: { statusText: 'Running in the Claude CLI', canInterrupt: false, startedAt: Date.now() },
    isLoading: true, onAbortSession: vi.fn(), permissionMode: 'default',
    availablePermissionModes: ['default'], onSelectPermissionMode: noop,
    providerLabel: 'Claude', effort: 'medium', availableEffortOptions: [], onSelectEffort: noop,
    model: 'test-model', availableModelOptions: [], onSelectModel: noop, modelsLoading: false,
    tokenBudget: null, onShowTokenUsage: noop, hasInput: false, onClearInput: noop,
    onSubmit: vi.fn(), isDragActive: false, queuedDraft: null, backgroundSendPrompt: null,
    onResolveBackgroundSendPrompt: noop, isEditingSentMessage: false, onCancelEditMessage: noop,
    scheduledMessages: [], onScheduleMessage: noop, onCancelScheduledMessage: noop,
    onEditQueuedDraft: noop, onDeleteQueuedDraft: noop, attachedFiles: [], onRemoveAttachment: noop,
    fileErrors: new Map(), showFileDropdown: false, filteredFiles: [], selectedFileIndex: 0,
    onSelectFile: noop, filteredCommands: [], selectedCommandIndex: 0, onCommandSelect: noop,
    onCloseCommandMenu: noop, isCommandMenuOpen: false, frequentCommands: [],
    getRootProps: () => ({}), getInputProps: () => ({}), openAttachmentPicker: noop,
    inputHighlightRef: createRef<HTMLDivElement>(), renderInputWithMentions: (text) => text,
    textareaRef: createRef<HTMLTextAreaElement>(), input: '', onInputChange: noop,
    onTextareaClick: noop, onTextareaKeyDown: noop, onTextareaPaste: noop,
    onTextareaScrollSync: noop, onTextareaInput: noop, placeholder: 'Message',
    isTextareaExpanded: false, ...overrides,
  };
  return { ...render(<ChatComposer {...props} />), props };
}

test('an external CLI turn disables Stop and explains why', () => {
  const view = renderComposer();
  const button = view.getByRole('button', { name: 'This session cannot be stopped here' }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.title, 'This session cannot be stopped here');
  fireEvent.click(button);
  assert.equal(vi.mocked(view.props.onAbortSession).mock.calls.length, 0);
});

test('an external CLI turn still accepts a queued text draft', () => {
  const view = renderComposer({ input: 'Follow up', hasInput: true });
  const button = view.getByRole('button', { name: 'Queue next message' }) as HTMLButtonElement;
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  assert.equal(vi.mocked(view.props.onSubmit).mock.calls.length, 1);
  assert.equal(vi.mocked(view.props.onAbortSession).mock.calls.length, 0);
});

test('an interruptible turn keeps the composer Stop enabled', () => {
  const view = renderComposer({ activity: { statusText: null, canInterrupt: true, startedAt: Date.now() } });
  const button = view.container.querySelector('form button[aria-label="Stop"]') as HTMLButtonElement;
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  assert.equal(vi.mocked(view.props.onAbortSession).mock.calls.length, 1);
});

test('background-only work keeps Send available', () => {
  const view = renderComposer({ isLoading: false, input: 'Next turn', hasInput: true,
    activity: { statusText: null, canInterrupt: false, background: true, startedAt: Date.now() } });
  const button = view.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  assert.equal(vi.mocked(view.props.onSubmit).mock.calls.length, 1);
});
