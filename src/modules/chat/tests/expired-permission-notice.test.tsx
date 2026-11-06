import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import ExpiredPermissionNotice from '@/modules/chat/composer/ExpiredPermissionNotice';
import { dismissExpiredPermission, getExpiredPermissions, recordExpiredPermission } from '@/shared/transport/expired-permissions';

/**
 * A permission card that lapsed while a Remote tab was disconnected must say so
 * rather than vanish when the server replays `permission_cancelled`.
 */

test('a replayed permission_cancelled leaves a visible expired card that can be dismissed', () => {
  render(<ExpiredPermissionNotice />);
  assert.equal(screen.queryByRole('alert'), null);

  act(() => recordExpiredPermission({ requestId: 'req_1', toolName: 'Bash' }));

  const card = screen.getByRole('alert');
  assert.match(card.textContent ?? '', /expired/i);
  assert.match(card.textContent ?? '', /Bash/);
  // A card can lapse by timeout or by an answer elsewhere while connected: no claim about the connection.
  assert.doesNotMatch(card.textContent ?? '', /connection|disconnect|down/i);

  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  assert.equal(screen.queryByRole('alert'), null);
  assert.deepEqual(getExpiredPermissions(), []);
});

test('the same request is recorded once however often it is replayed', () => {
  recordExpiredPermission({ requestId: 'req_dup', toolName: 'Bash' });
  recordExpiredPermission({ requestId: 'req_dup', toolName: 'Bash' });

  assert.equal(getExpiredPermissions().filter((entry) => entry.requestId === 'req_dup').length, 1);
  dismissExpiredPermission('req_dup');
});
