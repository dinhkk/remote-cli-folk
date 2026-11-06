import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteRelayLink } from '@/shared/types.js';

import { systemClock } from '../../pairing/pairing-clock.js';
import { runDownloadScenario, runEchoScenario, runUploadScenario } from '../support/link-transfer-scenarios.js';
import { createLinkRig, waitFor } from '../support/relay-link-rig.js';

/** Two real RelayLinks through the in-process fake relay on the system clock: pulls 25 MiB one way and echoes. */
const withConnectedPair = async (body: (links: { host: RemoteRelayLink; controller: RemoteRelayLink }) => Promise<void>) => {
  const rig = createLinkRig();
  try {
    const host = rig.createLink('host', { clock: systemClock });
    const controller = rig.createLink('controller', { clock: systemClock });
    host.start();
    await waitFor(() => host.status.state === 'online', 'the Host to come online');
    controller.start();
    await waitFor(() => controller.status.state === 'online', 'the Controller to come online');
    await body({ host, controller });
  } finally {
    rig.dispose();
  }
};

test('integration: a 25 MiB upload crosses two links through the relay intact', { timeout: 60_000 }, async () => {
  await withConnectedPair(({ host, controller }) => runUploadScenario(host, controller, 25 * 1024 * 1024));
});

test('integration: a 12 MiB download from the Host reaches the Controller intact', { timeout: 60_000 }, async () => {
  await withConnectedPair(({ host, controller }) => runDownloadScenario(host, controller));
});

test('integration: 300 WebSocket messages echo back in order through batching', { timeout: 30_000 }, async () => {
  await withConnectedPair(({ host, controller }) => runEchoScenario(host, controller));
});

test('integration: a small message overtakes the rest of a large upload (priority on the real link)', { timeout: 60_000 }, async () => {
  await withConnectedPair(async ({ host, controller }) => {
    let uploaded = 0;
    let uploadAtMessage = -1;
    host.onStream((stream, open) => {
      if (open.kind === 'ws') {
        stream.setHandlers({
          onMessage: () => {
            uploadAtMessage = uploaded;
          },
        });
      } else {
        stream.setHandlers({
          onBody: (chunk) => {
            uploaded += chunk.length;
          },
        });
      }
    });
    const ws = controller.openStream({ kind: 'ws', meta: { path: '/ws' } }, {});
    const upload = controller.openStream({ kind: 'http', meta: { method: 'PUT', path: '/up', headers: {} } }, {});
    // Fill the upload queue to the pause mark, then send a permission-response-sized message.
    const chunk = Buffer.alloc(1024 * 1024, 1);
    for (let i = 0; i < 4; i += 1) upload.writeBody(chunk, false);
    ws.sendMessage(Buffer.from('{"type":"permission-response"}'), false);
    await waitFor(() => uploadAtMessage >= 0, 'the small message to arrive');
    assert.ok(uploadAtMessage < 4 * 1024 * 1024, `the message arrived after ${uploadAtMessage} upload bytes: it was not stuck behind the queue`);
    upload.cancel();
    ws.cancel();
  });
});
