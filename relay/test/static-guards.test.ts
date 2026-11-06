// Source-level guards for rules a behavioural test cannot see (contracts.md section 4 + phase 04):
// no timers in the Durable Object, no logging, no static files, hibernation API, constant-time compare,
// no crypto libraries, SQLite-backed DO class.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const relayRoot = resolve(fileURLToPath(import.meta.url), '../..');
const srcDir = join(relayRoot, 'src');

/** Source without comments and string/template literal bodies would be over-engineering; strip comments only. */
function code(file: string): string {
  return readFileSync(join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const sourceFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

describe('relay source guards', () => {
  it('has the expected modules', () => {
    expect(sourceFiles.sort()).toEqual(['gate.ts', 'index.ts', 'room.ts', 'types.ts']);
  });

  it('uses no setTimeout/setInterval anywhere (time is handled by the SQLite state and one alarm)', () => {
    for (const f of sourceFiles) expect(code(f), f).not.toMatch(/\bset(Timeout|Interval)\b/);
  });

  it('never logs (tokens, gates and hashes must not reach any log)', () => {
    for (const f of sourceFiles) expect(code(f), f).not.toMatch(/\bconsole\s*\./);
  });

  it('accepts sockets through the hibernation API only', () => {
    const room = code('room.ts');
    expect(room).toMatch(/\.acceptWebSocket\(/);
    expect(room).not.toMatch(/\.accept\(\s*\)/);
    expect(room).not.toMatch(/addEventListener\(\s*['"]message['"]/);
  });

  it('compares token hashes with timingSafeEqual and the gate with subtle.verify', () => {
    expect(code('room.ts')).toMatch(/crypto\.subtle\.timingSafeEqual\(/);
    expect(code('gate.ts')).toMatch(/crypto\.subtle\.verify\(/);
  });

  it('imports no packages and no Node built-ins (WebCrypto only; the Workers runtime module is allowed)', () => {
    for (const f of sourceFiles) {
      const imports = [...code(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of imports) expect(spec, `${f} imports ${spec}`).toMatch(/^(\.\.?\/|cloudflare:workers$)/);
    }
  });

  it('keeps the Durable Object state in SQLite storage', () => {
    const room = code('room.ts');
    expect(room).toMatch(/storage\.sql\.exec\(/);
    expect(room).not.toMatch(/storage\.(put|get|delete)\(/);
  });
});

describe('wrangler config guards', () => {
  const raw = readFileSync(join(relayRoot, 'wrangler.jsonc'), 'utf8');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;

  it('serves no static assets and defines no secret in vars', () => {
    expect(config).not.toHaveProperty('assets');
    expect(config).not.toHaveProperty('site');
    expect(JSON.stringify(config.vars ?? {})).not.toMatch(/secret|token/i);
  });

  it('declares Room as a SQLite-backed Durable Object (Free plan)', () => {
    expect(config.durable_objects).toEqual({ bindings: [{ name: 'ROOM', class_name: 'Room' }] });
    const migrations = config.migrations as Array<{ new_sqlite_classes?: string[]; new_classes?: string[] }>;
    expect(migrations.some((m) => m.new_sqlite_classes?.includes('Room'))).toBe(true);
    expect(migrations.some((m) => m.new_classes?.length)).toBe(false);
  });

  it('has workers.dev enabled and no custom routes (the user chooses names at deploy time)', () => {
    expect(config.workers_dev).toBe(true);
    expect(config).not.toHaveProperty('routes');
    expect(config).not.toHaveProperty('route');
  });
});

describe('package guards', () => {
  it('has no runtime dependencies (no crypto libraries, nothing shipped in the Worker bundle)', () => {
    const pkg = JSON.parse(readFileSync(join(relayRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('pins wrangler to an exact version (the deploy tool is not allowed to float)', () => {
    const pkg = JSON.parse(readFileSync(join(relayRoot, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
