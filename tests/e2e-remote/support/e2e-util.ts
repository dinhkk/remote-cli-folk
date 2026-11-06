// Small shared helpers of the Remote end-to-end harness: free ports, polling, sleeping, fork root.
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/** Root of the fork (the directory that holds `server/`, `tests/` and `dist-server/`). */
export const FORK_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Polls `condition` every 50 ms until it returns a truthy value; throws a labelled error on timeout. */
export async function waitUntil<T>(condition: () => T | Promise<T>, what: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await condition();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
    }
    await sleep(50);
  }
}
