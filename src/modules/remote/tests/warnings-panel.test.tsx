import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import { RemoteWarningsPanel } from '@/modules/remote/components/RemoteWarningsPanel';
import { UnverifiedDeviceName } from '@/modules/remote/components/UnverifiedDeviceName';

/**
 * Four conditions deserve a warning on the Remote screen, and a healthy setup
 * deserves none: a master key that is only a file (FR-41) or that changed, an
 * approval timeout shorter than five minutes (FR-31), and a server mode where
 * Remote cannot run. A device name is never trusted, so it is always labelled.
 */

const healthy = {
  masterKeySource: 'env' as const,
  masterKeyMismatch: false,
  unsupportedMode: false,
  approvalTimeoutMs: 300000,
};

test('a healthy setup shows no warning at all', () => {
  const view = render(<RemoteWarningsPanel {...healthy} />);

  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(view.container.firstChild, null);
});

test('a master key that only lives in a file is flagged and points at the environment variable', () => {
  render(<RemoteWarningsPanel {...healthy} masterKeySource="file" />);

  const alert = screen.getByRole('alert');
  assert.match(alert.textContent ?? '', /generated into a file/);
  assert.match(alert.textContent ?? '', /CLOUDCLI_REMOTE_MASTER_KEY/);
});

test('a master key that changed or went missing is its own, stronger warning', () => {
  render(<RemoteWarningsPanel {...healthy} masterKeyMismatch />);

  const alert = screen.getByRole('alert');
  assert.match(alert.textContent ?? '', /changed or is missing/);
  assert.match(alert.textContent ?? '', /never generated while pairings exist/);
});

test('an approval timeout below five minutes warns and names the current value', () => {
  render(<RemoteWarningsPanel {...healthy} approvalTimeoutMs={55000} />);

  const alert = screen.getByRole('alert');
  assert.match(alert.textContent ?? '', /time out after 55 seconds/);
  assert.match(alert.textContent ?? '', /CLAUDE_TOOL_APPROVAL_TIMEOUT_MS=300000/);
});

test('299999 ms still warns and exactly 300000 ms does not', () => {
  const view = render(<RemoteWarningsPanel {...healthy} approvalTimeoutMs={299999} />);
  assert.ok(screen.getByRole('alert'));
  view.unmount();

  render(<RemoteWarningsPanel {...healthy} approvalTimeoutMs={300000} />);
  assert.equal(screen.queryByRole('alert'), null);
});

test('a longer timeout, or one the server did not report, raises nothing', () => {
  const view = render(<RemoteWarningsPanel {...healthy} approvalTimeoutMs={600000} />);
  assert.equal(screen.queryByRole('alert'), null);
  view.unmount();

  render(<RemoteWarningsPanel {...healthy} approvalTimeoutMs={null} />);
  assert.equal(screen.queryByRole('alert'), null);
});

test('a short timeout in whole minutes reads in minutes', () => {
  render(<RemoteWarningsPanel {...healthy} approvalTimeoutMs={120000} />);

  assert.match(screen.getByRole('alert').textContent ?? '', /time out after 2 minutes/);
});

test('an unsupported server mode is called out', () => {
  render(<RemoteWarningsPanel {...healthy} unsupportedMode />);

  assert.match(screen.getByRole('alert').textContent ?? '', /not supported in this server mode/);
});

test('several problems are listed together, one alert each', () => {
  render(<RemoteWarningsPanel {...healthy} masterKeySource="file" approvalTimeoutMs={55000} unsupportedMode />);

  assert.equal(screen.getAllByRole('alert').length, 3);
});

test('a device name is always followed by the unverified label', () => {
  render(<UnverifiedDeviceName name="Alice-PC" />);

  assert.ok(screen.getByText('Alice-PC'));
  const label = screen.getByText('Unverified');
  assert.equal(label.getAttribute('title'), 'The Controller chose this name itself. It is not verified.');
});

test('a hostile device name is plain text, never markup', () => {
  const { container } = render(<UnverifiedDeviceName name={'<img src=x onerror=alert(1)>'} />);

  assert.equal(container.querySelector('img'), null);
  assert.ok(screen.getByText('<img src=x onerror=alert(1)>'));
});
