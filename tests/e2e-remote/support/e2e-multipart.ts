// A multipart/form-data body built by hand (what a browser FormData upload sends), for the upload tests.
import crypto from 'node:crypto';

export type MultipartPart = { name: string; data: Buffer | string; filename?: string; contentType?: string };

export function multipartBody(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----e2e-${crypto.randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`;
    const head = `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${part.contentType ? `Content-Type: ${part.contentType}\r\n` : ''}\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** One file field plus optional text fields. A non-zero `fill` is not all zeros, so a truncated body cannot hash the same. */
export function singleFileUpload(field: string, filename: string, size: number, contentType = 'application/octet-stream', fields: Record<string, string> = {}): { body: Buffer; contentType: string; file: Buffer } {
  const file = Buffer.alloc(size, 0x41);
  crypto.randomFillSync(file, 0, Math.min(size, 1_000_000));
  const parts: MultipartPart[] = Object.entries(fields).map(([name, data]) => ({ name, data }));
  parts.push({ name: field, data: file, filename, contentType });
  const built = multipartBody(parts);
  return { ...built, file };
}
