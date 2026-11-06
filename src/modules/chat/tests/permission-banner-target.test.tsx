import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import '@/modules/i18n';
import type { PendingPermissionRequest } from '@/shared/types';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import { initTargetContext } from '@/shared/transport/target-context';
import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * Inside a Remote tab the Host drops `rememberEntry` from every permission
 * answer, so a button that promises "always" would be a lie. The UI therefore
 * offers only Allow once and Deny there (a UX courtesy, not a security
 * boundary). Local keeps every option; opencodePermissionPrompts.test.tsx pins
 * that side.
 */

const enterTargetMode = () => {
  window.history.replaceState(null, '', '/?target=peer_abc12345');
  window.name = '';
  initTargetContext();
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.name = '';
  initTargetContext();
});

const claudeRequest: PendingPermissionRequest = {
  requestId: 'claude_1',
  toolName: 'Bash',
  input: { command: 'npm test' },
};
const opencodeRequest: PendingPermissionRequest = {
  requestId: 'per_1',
  toolName: 'bash',
  input: { command: 'git status', patterns: ['git status'] },
  context: { patterns: ['git status'], always: ['git status *'] },
};

const renderBanner = (request: PendingPermissionRequest) => {
  const decisions: Array<{ ids: unknown; decision: Record<string, unknown> }> = [];
  const grants: unknown[] = [];
  const view = render(
    <PermissionRequestsBanner
      pendingPermissionRequests={[request]}
      providerLabel="Claude"
      handlePermissionDecision={(ids, decision) => decisions.push({ ids, decision })}
      handleGrantToolPermission={(suggestion) => {
        grants.push(suggestion);
        return { success: true };
      }}
    />,
  );
  return { ...view, decisions, grants };
};

test('a Claude request offers neither Always allow nor Allow & remember in a tab', () => {
  enterTargetMode();
  const { queryByText, getByText, decisions } = renderBanner(claudeRequest);

  assert.equal(queryByText('Allow & remember') === null, true);
  assert.equal(queryByText('Allow (saved)') === null, true);
  assert.equal(queryByText('Always allow') === null, true);
  fireEvent.click(getByText('Allow once'));
  assert.deepEqual(decisions, [{ ids: 'claude_1', decision: { allow: true } }]);
});

test('an OpenCode request offers no Always allow in a tab, and still can be denied', () => {
  enterTargetMode();
  const { queryByText, getByText, decisions } = renderBanner(opencodeRequest);

  assert.equal(queryByText('Always allow') === null, true);
  fireEvent.click(getByText('Deny'));
  assert.equal(decisions[0]?.decision.allow, false);
  assert.equal('rememberEntry' in (decisions[0]?.decision ?? {}), false);
});

test('outside a tab the remember options are still there', () => {
  const claude = renderBanner(claudeRequest);
  assert.ok(claude.getByText('Allow & remember'));
  claude.unmount();

  const opencode = renderBanner(opencodeRequest);
  assert.ok(opencode.getByText('Always allow'));
});
