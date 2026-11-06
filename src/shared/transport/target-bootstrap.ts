import { connectToParent } from '@/shared/transport/tab-channel';
import { installServiceWorkerStub, installStorageShim } from '@/shared/transport/storage-shim';
import { emitLinkEvent, initTargetContext } from '@/shared/transport/target-context';

/**
 * First thing main.tsx runs, before the application is imported.
 *
 * In a Remote tab it installs the storage and service-worker stand-ins, then
 * waits (bounded) for the Controller page to hand over the tab token and the
 * stored tab state, so that every module that reads storage while it loads sees
 * the tab's own data and none of them touches the real, forbidden storage. In
 * Local mode it finds no target and returns immediately: nothing is installed.
 *
 * @returns whether this document is a Remote tab.
 */
export const prepareTargetMode = async (win: Window = window): Promise<boolean> => {
  const target = initTargetContext(win);
  if (!target) {
    return false;
  }

  const shim = installStorageShim(win);
  installServiceWorkerStub(win);

  const connected = await connectToParent({ nonce: target.nonce, peerId: target.peerId, shim, win });
  if (!connected) {
    // No token will come on its own; the tab shows "session expired" instead of a login screen.
    emitLinkEvent({ kind: 'session-expired' });
  }
  return true;
};
