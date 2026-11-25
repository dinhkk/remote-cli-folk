import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

const KEY = 'RC_TEST_LOGIN_PHRASE';

/** Reads only one key from `.env.test`; the file is never loaded into `process.env`. */
function fromEnvFile(): string | undefined {
  try {
    return parseEnv(readFileSync(path.resolve(process.cwd(), '.env.test'), 'utf8'))[KEY] || undefined;
  } catch {
    return undefined; // No `.env.test`: use a random value.
  }
}

const base = process.env[KEY] || fromEnvFile();

/**
 * Login phrase for the fake account that a test creates for itself.
 * Each label gives a different value. Without a fixed value, every run gets a new random one.
 */
export function testLoginPhrase(label = 'primary'): string {
  return base ? `${base}-${label}` : `${label}-${randomUUID()}`;
}
