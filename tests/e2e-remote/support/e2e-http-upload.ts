// A request body written in chunks with backpressure, so a test can stop in the middle (cancel) or keep writing
// while the server has already answered (a refusal before the body is read). `fetch` hides both.
import http from 'node:http';

export type UploadOutcome =
  | { kind: 'response'; status: number; headers: http.IncomingHttpHeaders; text: string }
  | { kind: 'aborted'; bytesWritten: number };

export type UploadOptions = {
  method?: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Destroys the connection once this many body bytes have been written. */
  abortAfterBytes?: number;
  /** Pause between 64 KiB chunks (keeps an upload slow enough to observe). */
  chunkDelayMs?: number;
};

const CHUNK = 64 * 1024;

export function uploadInChunks(baseUrl: string, pathAndQuery: string, options: UploadOptions): Promise<UploadOutcome> {
  const url = new URL(pathAndQuery, baseUrl);
  return new Promise((resolve, reject) => {
    let written = 0;
    let answered = false;
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'POST',
        headers: { ...options.headers, 'content-length': String(options.body.length) },
      },
      (response) => {
        answered = true;
        const parts: Buffer[] = [];
        response.on('data', (part: Buffer) => parts.push(part));
        response.on('end', () => resolve({ kind: 'response', status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(parts).toString('utf8') }));
        response.on('error', reject);
      },
    );
    // A server that refuses early may reset the connection while the body is still being written: the answer wins.
    request.on('error', (error) => {
      if (!answered) reject(error);
    });

    const writeMore = (): void => {
      if (request.destroyed) return;
      while (written < options.body.length) {
        if (options.abortAfterBytes !== undefined && written >= options.abortAfterBytes) {
          request.destroy();
          resolve({ kind: 'aborted', bytesWritten: written });
          return;
        }
        const piece = options.body.subarray(written, Math.min(written + CHUNK, options.body.length));
        written += piece.length;
        const last = written >= options.body.length;
        const ok = last ? (request.end(piece), true) : request.write(piece);
        if (last) return;
        if (options.chunkDelayMs) {
          setTimeout(writeMore, options.chunkDelayMs);
          return;
        }
        if (!ok) {
          request.once('drain', writeMore);
          return;
        }
      }
    };
    writeMore();
  });
}
