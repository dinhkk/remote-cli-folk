// Uploads through Remote: a 25 MB file-tree upload arrives intact, 26 MB is refused by the Controller before it
// reaches the Host, a cancel half way frees the stream, and the chat attachment endpoints keep their own limits
// (5 MB images, 10 MB files) with the Host's answer passed through as it is.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createHostProject, type HostProject } from './support/e2e-host-project.js';
import { uploadInChunks } from './support/e2e-http-upload.js';
import { singleFileUpload } from './support/e2e-multipart.js';
import { waitUntil } from './support/e2e-util.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';

const MIB = 1024 * 1024;
const sha256 = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

describe('uploads through Remote', () => {
  let world: RemoteWorld;
  let project: HostProject;
  let token = '';

  const uploadPath = (): string => `/r/${world.peerId}/api/file-tree/projects/${project.id}/files/upload`;
  const viaRemote = (pathAndQuery: string, upload: { body: Buffer; contentType: string }, abortAfterBytes?: number) =>
    uploadInChunks(world.controller.baseUrl, `/r/${world.peerId}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': upload.contentType },
      body: upload.body,
      abortAfterBytes,
    });
  const hostStreams = async (): Promise<number> =>
    (await world.host.api('/api/remote/host/status')).json<{ controllers: Array<{ streams: number }> }>().controllers[0]?.streams ?? 0;

  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
    project = await createHostProject(world.host, 'uploads');
  });
  after(async () => {
    await world?.stop();
  });

  it('a 25 MB file arrives on the Host byte for byte', { timeout: 180_000 }, async () => {
    const upload = singleFileUpload('files', 'big-25mb.bin', 25_000_000);
    const outcome = await uploadInChunks(world.controller.baseUrl, uploadPath(), {
      headers: { authorization: `Bearer ${token}`, 'content-type': upload.contentType },
      body: upload.body,
    });
    assert.equal(outcome.kind, 'response');
    if (outcome.kind !== 'response') return;
    assert.equal(outcome.status, 200, outcome.text);
    const stored = path.join(project.dir, 'big-25mb.bin');
    assert.equal(statSync(stored).size, upload.file.length);
    assert.equal(sha256(readFileSync(stored)), sha256(upload.file));
    await waitUntil(async () => (await hostStreams()) === 0, 'the upload stream to close', 15_000);
  });

  it('a 26 MiB request is refused with 413 REMOTE_TOO_LARGE by the Controller; the Host never sees it', { timeout: 120_000 }, async () => {
    const upload = singleFileUpload('files', 'too-big.bin', 26 * MIB);
    // Repeated: the answer must reach a client that is still sending (the refusal must not reset the connection under it).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await viaRemote(`/api/file-tree/projects/${project.id}/files/upload`, upload);
      assert.equal(outcome.kind, 'response');
      if (outcome.kind !== 'response') return;
      assert.equal(outcome.status, 413, outcome.text);
      assert.equal((JSON.parse(outcome.text) as { error: { code: string } }).error.code, 'REMOTE_TOO_LARGE');
    }
    assert.equal(existsSync(path.join(project.dir, 'too-big.bin')), false);
    assert.equal(await hostStreams(), 0, 'no stream was opened for it');
    // the link is still fine
    assert.equal((await world.viaRemote('/api/user/onboarding-status', { token })).status, 200);
  });

  it('cancelling half way frees the stream on the Host, leaves no file behind and the link keeps working', { timeout: 120_000 }, async () => {
    const upload = singleFileUpload('files', 'cancelled.bin', 24_000_000);
    const entriesBefore = readdirSync(project.dir).length;
    const outcome = await viaRemote(`/api/file-tree/projects/${project.id}/files/upload`, upload, 8 * MIB);
    assert.equal(outcome.kind, 'aborted');
    await waitUntil(async () => (await hostStreams()) === 0, 'the Host to free the cancelled stream', 20_000);
    assert.equal(existsSync(path.join(project.dir, 'cancelled.bin')), false);
    assert.equal(readdirSync(project.dir).length, entriesBefore, 'nothing was stored');
    assert.equal((await world.viaRemote('/api/user/onboarding-status', { token })).status, 200);
    const peers = (await world.controller.api('/api/remote/peers')).json<Array<{ peerId: string; state: string }>>();
    assert.equal(peers.find((peer) => peer.peerId === world.peerId)?.state, 'online');
  });

  it('chat attachments keep their limits: the Host refuses 6 MB images and 11 MB files, and the answer is the same as Local', { timeout: 180_000 }, async () => {
    const cases: Array<{ path: string; field: string; filename: string; size: number; type: string; expectOk: boolean }> = [
      { path: '/api/assets/images', field: 'images', filename: 'big.png', size: 6 * MIB, type: 'image/png', expectOk: false },
      { path: '/api/assets/images', field: 'images', filename: 'ok.png', size: 4 * MIB, type: 'image/png', expectOk: true },
      { path: '/api/assets/files', field: 'files', filename: 'big.bin', size: 11 * MIB, type: 'application/octet-stream', expectOk: false },
      { path: '/api/assets/files', field: 'files', filename: 'ok.bin', size: 9 * MIB, type: 'application/octet-stream', expectOk: true },
    ];
    for (const item of cases) {
      const upload = singleFileUpload(item.field, item.filename, item.size, item.type);
      const remote = await viaRemote(item.path, upload);
      const local = await uploadInChunks(world.host.baseUrl, item.path, {
        headers: { authorization: `Bearer ${world.host.jwt}`, 'content-type': upload.contentType },
        body: upload.body,
      });
      assert.equal(remote.kind, 'response', item.filename);
      assert.equal(local.kind, 'response', item.filename);
      if (remote.kind !== 'response' || local.kind !== 'response') return;
      assert.equal(remote.status, item.expectOk ? 200 : 400, `${item.filename} via Remote: ${remote.text.slice(0, 200)}`);
      assert.equal(local.status, remote.status, `${item.filename}: Local and Remote answer alike`);
      if (!item.expectOk) assert.equal(remote.text, local.text, `${item.filename}: the Host's error is passed through unchanged`);
    }
  });
});
