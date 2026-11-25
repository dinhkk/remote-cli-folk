import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeProjectDirectory } from '../agent-monitor.transcript-reader.js';

/** Builders for fake Claude config directories: transcripts and sub-agent files shaped like the ones the CLI writes. */

export const SESSION_ID = '11111111-2222-3333-4444-555555555555';

type Json = Record<string, unknown>;

export const userLine = (timestamp: string, content: unknown = 'hello'): Json => ({
  type: 'user', timestamp, isSidechain: false, message: { role: 'user', content },
});

/** One content block of an assistant message; the CLI writes one line per block and repeats the usage on each. */
export const assistantLine = (messageId: string, block: Json, usage: Json = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 }, model = 'claude-sonnet-5-5'): Json => ({
  type: 'assistant', message: { id: messageId, role: 'assistant', model, usage, content: [block] },
});

export const toolUse = (id: string, name: string): Json => ({ type: 'tool_use', id, name, input: {} });

export const toolResultLine = (toolUseId: string): Json => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
});

export type FakeAgent = {
  id: string;
  meta?: Json;
  lines: Json[];
  /** How long ago the transcript was last written. */
  ageMs?: number;
};

/** A temporary `~/.claude` with one project directory; `cleanup()` removes it. */
export async function createFakeClaudeHome(cwd: string, sessionId = SESSION_ID) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'monitor-claude-'));
  const projectDirectory = path.join(home, 'projects', encodeProjectDirectory(cwd));
  await fsp.mkdir(path.join(projectDirectory, sessionId, 'subagents'), { recursive: true });

  const write = async (file: string, lines: Json[], ageMs = 0): Promise<void> => {
    await fsp.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await fsp.utimes(file, when, when);
    }
  };

  return {
    home,
    projectDirectory,
    writeMain: (lines: Json[], ageMs = 0) => write(path.join(projectDirectory, `${sessionId}.jsonl`), lines, ageMs),
    async writeAgent({ id, meta, lines, ageMs = 0 }: FakeAgent): Promise<void> {
      const base = path.join(projectDirectory, sessionId, 'subagents', `agent-${id}`);
      if (meta) await fsp.writeFile(`${base}.meta.json`, JSON.stringify(meta));
      await write(`${base}.jsonl`, lines, ageMs);
    },
    cleanup: () => fsp.rm(home, { recursive: true, force: true }),
  };
}
