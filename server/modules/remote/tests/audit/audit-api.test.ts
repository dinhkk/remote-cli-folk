/**
 * `GET /api/remote/host/audit` on the real module (FR-42): full JWT only (a tab token is 401), paged,
 * filterable by Controller, read-only, and never carrying anything the sanitiser would have removed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { remoteAuditDb } from '@/modules/database/index.js';

import { withModuleRig } from '../support/remote-module-rig.js';

type Page = { entries: Array<{ id: number; controller: string; pairingId: string | null; event: string; target: string; detail: Record<string, unknown> }>; nextBefore: number | null; controllers: Array<{ pairingId: string; label: string }> };

const insert = (pairingId: string, controller: string, target: string, detail: Record<string, unknown> = {}): void =>
  remoteAuditDb.insert({ at: Date.now(), pairing_id: pairingId, controller, event: 'tool-decision', target, result: 'allow', detail: JSON.stringify(detail) });

describe('audit API', () => {
  it('answers only to a full JWT: a tab token, a missing login and another site are refused', async () => {
    await withModuleRig({}, async (rig) => {
      const { tabToken } = rig.arrangePeer();
      assert.equal((await rig.api('/host/audit', { token: tabToken })).status, 401);
      assert.equal((await rig.api('/host/audit', { headers: { authorization: '' }, token: '' })).status, 401);
      assert.equal((await rig.api('/host/audit', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await rig.api('/host/audit')).status, 200);
    });
  });

  it('pages newest first, filters by Controller and lists the Controllers', async () => {
    await withModuleRig({}, async (rig) => {
      for (let index = 0; index < 5; index += 1) insert(index % 2 === 0 ? 'p-phone' : 'p-laptop', index % 2 === 0 ? 'Phone' : 'Laptop', `row-${index}`, { n: index });

      const first = (await rig.api('/host/audit?limit=2')).json<Page>();
      assert.deepEqual(first.entries.map((entry) => entry.target), ['row-4', 'row-3']);
      assert.ok(first.nextBefore !== null);
      const second = (await rig.api(`/host/audit?limit=2&before=${first.nextBefore}`)).json<Page>();
      assert.deepEqual(second.entries.map((entry) => entry.target), ['row-2', 'row-1']);

      const phone = (await rig.api('/host/audit?controller=p-phone')).json<Page>();
      assert.deepEqual(phone.entries.map((entry) => entry.target), ['row-4', 'row-2', 'row-0']);
      assert.deepEqual(phone.controllers.map((entry) => entry.label).sort(), ['Laptop', 'Phone']);
    });
  });

  it('refuses a malformed query with 400 REMOTE_BAD_REQUEST and has no write endpoint', async () => {
    await withModuleRig({}, async (rig) => {
      for (const query of ['limit=0', 'limit=201', 'limit=abc', 'before=-1', 'before=1.5', 'limit[]=1', 'controller=', `controller=${'x'.repeat(65)}`]) {
        const response = await rig.api(`/host/audit?${query}`);
        assert.equal(response.status, 400, query);
        assert.equal((JSON.parse(response.text()) as { error: { code: string } }).error.code, 'REMOTE_BAD_REQUEST');
      }
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const response = await rig.api('/host/audit', { method, body: {}, password: true });
        assert.equal(response.status, 404, method);
      }
    });
  });

  it('an empty audit is an empty page', async () => {
    await withModuleRig({}, async (rig) => {
      assert.deepEqual((await rig.api('/host/audit')).json<Page>(), { entries: [], nextBefore: null, controllers: [] });
    });
  });
});
