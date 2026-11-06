import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { renderBootFailure } from '@/shared/transport/boot-failure';

/**
 * If the target bootstrap throws or the application chunk fails to load, the
 * page must say so instead of staying blank.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

test('replaces the root with a plain message and logs the cause', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  document.body.innerHTML = '<div id="root"><span>old</span></div>';

  renderBootFailure(new Error('chunk 404'));

  const root = document.getElementById('root') as HTMLElement;
  assert.match(root.textContent ?? '', /could not start/i);
  assert.equal(root.textContent?.includes('chunk 404'), false, 'internals stay out of the page');
  assert.equal(root.querySelector('span'), null);
  assert.equal(errors.mock.calls.length, 1);
});

test('without a root element it still shows the message', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  document.body.innerHTML = '';

  renderBootFailure('boom');

  assert.match(document.body.textContent ?? '', /could not start/i);
});
