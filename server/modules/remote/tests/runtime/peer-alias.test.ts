/**
 * The name a user gives a paired Host (shown on its tab instead of the device name the Host declared):
 * what is accepted, what is cleaned, what is refused, and that it is stored per pairing on this Controller only.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_PEER_ALIAS_LENGTH, normalizePeerAlias } from '../../runtime/remote-management.service.js';

const refusal = (error: unknown): boolean => (error as { statusCode?: number; code?: string }).statusCode === 400 && (error as { code?: string }).code === 'REMOTE_BAD_REQUEST';

describe('normalizePeerAlias', () => {
  it('keeps a plain name as typed, including accents and non-Latin scripts', () => {
    assert.equal(normalizePeerAlias('Home PC'), 'Home PC');
    assert.equal(normalizePeerAlias('Máy nhà - Tầng 2'), 'Máy nhà - Tầng 2');
    assert.equal(normalizePeerAlias('办公室电脑'), '办公室电脑');
  });

  it('trims, collapses whitespace and turns line breaks into single spaces', () => {
    assert.equal(normalizePeerAlias('  Home   PC \n\t'), 'Home PC');
    assert.equal(normalizePeerAlias('Line one\r\nline two'), 'Line one line two');
  });

  it('removes control, zero-width and bidi-override characters that could hide or reorder what a tab shows', () => {
    assert.equal(normalizePeerAlias('Home\u0000 PC'), 'Home PC');
    assert.equal(normalizePeerAlias('ad‮min'), 'ad min', 'a right-to-left override cannot flip the label');
    assert.equal(normalizePeerAlias('Home​PC'), 'Home PC');
    assert.equal(normalizePeerAlias('﻿Home PC'), 'Home PC');
  });

  it('treats null, undefined and blank text as "no alias"', () => {
    assert.equal(normalizePeerAlias(null), null);
    assert.equal(normalizePeerAlias(undefined), null);
    assert.equal(normalizePeerAlias(''), null);
    assert.equal(normalizePeerAlias('   ​  '), null);
  });

  it('accepts exactly the longest alias and refuses one character more (it never cuts what was typed)', () => {
    assert.equal(normalizePeerAlias('a'.repeat(MAX_PEER_ALIAS_LENGTH)), 'a'.repeat(MAX_PEER_ALIAS_LENGTH));
    assert.throws(() => normalizePeerAlias('a'.repeat(MAX_PEER_ALIAS_LENGTH + 1)), refusal);
    // Counted in characters, not UTF-16 units: forty emoji fit.
    assert.equal([...(normalizePeerAlias('😀'.repeat(MAX_PEER_ALIAS_LENGTH)) ?? '')].length, MAX_PEER_ALIAS_LENGTH);
  });

  it('refuses anything that is not text', () => {
    for (const bad of [42, true, {}, ['x']]) assert.throws(() => normalizePeerAlias(bad), refusal);
  });
});
