// The Controller must forward a path exactly as the browser sent it: matching against the allow-list is
// case-insensitive, the forwarded path keeps its case. A chat attachment called `Report.PDF` is stored and
// downloaded under that exact name (the download header carries the name the Host received in the URL).
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { uploadInChunks } from './support/e2e-http-upload.js';
import { multipartBody, singleFileUpload } from './support/e2e-multipart.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';

describe('attachment names keep their case through Remote', () => {
  let world: RemoteWorld;
  let token = '';

  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
  });
  after(async () => {
    await world?.stop();
  });

  it('Report.PDF is stored and downloaded as Report.PDF, not report.pdf', async () => {
    // ASCII content, so the text of the download is the bytes of the upload.
    const content = Buffer.from('%PDF-1.4 e2e report\n'.repeat(200));
    const upload = { ...multipartBody([{ name: 'files', data: content, filename: 'Report.PDF', contentType: 'application/pdf' }]), file: content };
    const stored = await uploadInChunks(world.controller.baseUrl, `/r/${world.peerId}/api/assets/files`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': upload.contentType },
      body: upload.body,
    });
    assert.equal(stored.kind, 'response');
    if (stored.kind !== 'response') return;
    assert.equal(stored.status, 200, stored.text);
    const record = (JSON.parse(stored.text) as { attachments: Array<{ name: string; path: string; size: number }> }).attachments[0];
    assert.equal(record.name, 'Report.PDF');
    const storedName = path.posix.basename(record.path);
    assert.ok(storedName.endsWith('-Report.PDF'), storedName);

    const download = await world.viaRemote(`/api/assets/files/${storedName}`, { token });
    assert.equal(download.status, 200, download.text);
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${storedName}"`);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-type') ?? '', /application\/pdf/);
    assert.equal(download.text, content.toString());

    // The same request made as Local gives the same header: the proxy changed nothing about the name.
    const local = await world.host.api(`/api/assets/files/${storedName}`);
    assert.equal(local.headers.get('content-disposition'), download.headers.get('content-disposition'));
  });

  it('a route written in upper case still matches the allow-list and reaches the Host with its case intact', async () => {
    const upload = singleFileUpload('files', 'MiXeD.TXT', 64, 'text/plain');
    const stored = await uploadInChunks(world.controller.baseUrl, `/r/${world.peerId}/api/assets/files`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': upload.contentType },
      body: upload.body,
    });
    assert.equal(stored.kind, 'response');
    if (stored.kind !== 'response') return;
    const storedName = path.posix.basename((JSON.parse(stored.text) as { attachments: Array<{ path: string }> }).attachments[0].path);
    const download = await world.viaRemote(`/API/ASSETS/FILES/${storedName}`, { token });
    assert.equal(download.status, 200, download.text);
    assert.ok(download.headers.get('content-disposition')?.includes('MiXeD.TXT'));
  });
});
