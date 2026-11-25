import type { FileHandle } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AgentMonitorNode } from '@/shared/types.js';

/** Last bytes of a session's main transcript that are read (the file itself can be tens of MB: never read whole). */
const MAIN_TAIL_BYTES = 128 * 1024;
/** Most of one sub-agent transcript that is read (its last bytes when it is bigger): a lower bound for its token count. */
const SUBAGENT_READ_BYTES = 1024 * 1024;
/** Bytes read from the start of a sub-agent transcript to find its first timestamp (when the agent started). */
const START_PROBE_BYTES = 64 * 1024;
/** Sub-agents inspected per session, newest first. */
const MAX_SUBAGENTS = 30;
/** Project directories scanned for a session whose folder-derived directory has no transcript (a renamed or moved folder). */
const MAX_PROJECT_DIRECTORIES_SCANNED = 400;
/** A sub-agent whose transcript has not grown for this long and never said it finished reads as stopped, not running. */
export const AGENT_STALE_MS = 3 * 60_000;
/** A failed search for a session's transcript directory is not repeated for this long. */
const MISSING_RETRY_MS = 15_000;
/** Cap on remembered per-file results, so a long-lived server cannot grow without bound. */
const MAX_CACHED_FILES = 500;

/** Claude session ids are UUIDs; anything with a separator or dot-segment is not one. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The tools that start a sub-agent: an agent waiting on one is not "running a tool" itself. */
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);

type AnyRecord = Record<string, unknown>;

const asRecord = (value: unknown): AnyRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
const asString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** What a transcript tail says about one agent's recent work. */
type TranscriptActivity = {
  /** The tool the agent has called and not yet had an answer for; null when it is between calls. */
  pendingTool: string | null;
  model: string | null;
  /** Billed-looking total of the assistant messages read: input + output + cache creation, each message counted once. */
  tokens: number;
  toolCalls: number;
  /** Size of the context of the last request (input + cache read + cache creation), null when no message was read. */
  contextTokens: number | null;
};

/**
 * Folds transcript records into an `activity`. The CLI writes one line per content block, repeating the message's usage
 * on each, so usage is kept per message id (the last line of a message carries its final output count).
 */
export function summariseTranscript(records: readonly AnyRecord[]): TranscriptActivity {
  const pending = new Map<string, string>();
  const usageByMessage = new Map<string, AnyRecord>();
  const toolIds = new Set<string>();
  let model: string | null = null;
  let lastUsage: AnyRecord | null = null;
  let anonymous = 0;

  for (const record of records) {
    const message = asRecord(record.message);
    if (!message) continue;
    const content = Array.isArray(message.content) ? message.content : [];

    if (record.type === 'assistant') {
      model = asString(message.model) ?? model;
      const usage = asRecord(message.usage);
      if (usage) {
        usageByMessage.set(asString(message.id) ?? `anonymous-${anonymous++}`, usage);
        lastUsage = usage;
      }
      for (const block of content) {
        const item = asRecord(block);
        if (item?.type !== 'tool_use') continue;
        const id = asString(item.id);
        if (id) toolIds.add(id);
        const name = asString(item.name);
        if (id && name) pending.set(id, name);
      }
    } else if (record.type === 'user') {
      for (const block of content) {
        const item = asRecord(block);
        const id = item?.type === 'tool_result' ? asString(item.tool_use_id) : null;
        if (id) pending.delete(id);
      }
    }
  }

  let tokens = 0;
  for (const usage of usageByMessage.values()) {
    tokens += asNumber(usage.input_tokens) + asNumber(usage.output_tokens) + asNumber(usage.cache_creation_input_tokens);
  }

  const pendingTools = [...pending.values()].filter((name) => !DELEGATION_TOOLS.has(name));
  return {
    pendingTool: pendingTools.length > 0 ? pendingTools[pendingTools.length - 1] : null,
    model,
    tokens,
    toolCalls: toolIds.size,
    contextTokens: lastUsage
      ? asNumber(lastUsage.input_tokens) + asNumber(lastUsage.cache_read_input_tokens) + asNumber(lastUsage.cache_creation_input_tokens)
      : null,
  };
}

/** Parses the complete JSON lines of a chunk; the first line is dropped when the chunk starts mid-file (it may be cut). */
function parseChunk(chunk: string, startsMidFile: boolean): AnyRecord[] {
  const lines = chunk.split('\n');
  if (startsMidFile) lines.shift();
  const records: AnyRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (parsed) records.push(parsed);
    } catch {
      // A line cut off at the end (the CLI is mid-write) or garbage is not evidence of anything.
    }
  }
  return records;
}

/** Reads the last `maxBytes` of a file as records, bounded: a bigger file is never read whole. Null when unreadable. */
async function readTailRecords(filePath: string, maxBytes: number): Promise<{ records: AnyRecord[]; size: number; mtimeMs: number } | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    return { records: parseChunk(buffer.toString('utf8'), size > length), size, mtimeMs };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The first timestamp of a transcript (when it began), read from at most the first bytes; null when it is not there. */
async function readFirstTimestamp(filePath: string): Promise<number | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(START_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, START_PROBE_BYTES, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const firstLine = text.includes('\n') ? text.slice(0, text.indexOf('\n')) : text;
    const stamp = /"timestamp"\s*:\s*"([^"]+)"/.exec(firstLine)?.[1];
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Claude names a project directory after the folder, every character that is not a letter or digit becoming `-`. */
export const encodeProjectDirectory = (folder: string): string => folder.replace(/[^a-zA-Z0-9]/g, '-');

export type TranscriptSessionDetail = {
  /** False when no transcript of the session was found: everything below is then unknown. */
  found: boolean;
  /** The orchestrator's pending tool call (null when between calls or unknown). */
  lastToolName: string | null;
  model: string | null;
  contextTokens: number | null;
  /** When the main transcript was last written (ms), null when unknown. */
  lastWriteAt: number | null;
  /** Every inspected sub-agent, newest first, with its state derived as described on `deriveAgentState`. */
  agents: AgentMonitorNode[];
};

type ReaderOptions = {
  /** The Claude config directory (`~/.claude`). Only ever read. */
  claudeHome: string;
  now?: () => number;
};

/** A finished flag that is not `true` means "not finished": the CLI writes it into the agent's `.meta.json` when the agent ends. */
function deriveAgentState(finished: boolean, lastWriteAt: number, at: number): AgentMonitorNode['state'] {
  if (finished) return 'done';
  return at - lastWriteAt <= AGENT_STALE_MS ? 'running' : 'stopped';
}

/**
 * Reads what the Claude CLI wrote to disk about a session that the app did not start: the main transcript's tail and every
 * sub-agent's transcript with its `.meta.json`. Reads are bounded (a tail of the main file, at most 1 MB of a sub-agent
 * file), results are cached by file size and modification time, and nothing is ever written.
 *
 * What it cannot know is left unknown rather than guessed: an agent waiting for a permission answer, an agent that failed
 * (a finished agent always reads as done) and exact token totals of agents whose transcript is bigger than the read limit.
 */
export function createTranscriptReader({ claudeHome, now = Date.now }: ReaderOptions) {
  const projectsDirectory = path.join(claudeHome, 'projects');
  const directoryBySession = new Map<string, string>();
  const missingSince = new Map<string, number>();
  const activityByFile = new Map<string, { size: number; mtimeMs: number; activity: TranscriptActivity }>();
  const startByFile = new Map<string, number>();

  const remember = <K, V>(map: Map<K, V>, key: K, value: V): void => {
    if (map.size >= MAX_CACHED_FILES) map.clear();
    map.set(key, value);
  };

  const hasTranscript = (directory: string, sessionId: string): Promise<boolean> =>
    fsp.stat(path.join(directory, `${sessionId}.jsonl`)).then((stat) => stat.isFile(), () => false);

  /** `<claude home>/projects/<folder>` of a session: from its folder name first, else by looking for its transcript. */
  async function findProjectDirectory(cwd: string | null, sessionId: string): Promise<string | null> {
    const known = directoryBySession.get(sessionId);
    if (known) return known;
    const failedAt = missingSince.get(sessionId);
    if (failedAt !== undefined && now() - failedAt < MISSING_RETRY_MS) return null;

    if (cwd) {
      const guess = path.join(projectsDirectory, encodeProjectDirectory(cwd));
      if (await hasTranscript(guess, sessionId)) {
        remember(directoryBySession, sessionId, guess);
        return guess;
      }
    }
    let entries: string[] = [];
    try {
      entries = (await fsp.readdir(projectsDirectory)).slice(0, MAX_PROJECT_DIRECTORIES_SCANNED);
    } catch {
      // No projects directory at all: nothing to find.
    }
    for (const entry of entries) {
      const candidate = path.join(projectsDirectory, entry);
      if (await hasTranscript(candidate, sessionId)) {
        remember(directoryBySession, sessionId, candidate);
        return candidate;
      }
    }
    remember(missingSince, sessionId, now());
    return null;
  }

  async function readAgents(projectDirectory: string, sessionId: string, at: number): Promise<AgentMonitorNode[]> {
    const directory = path.join(projectDirectory, sessionId, 'subagents');
    let entries: string[];
    try {
      entries = await fsp.readdir(directory);
    } catch {
      return [];
    }

    const transcripts = entries.filter((entry) => /^agent-.+\.jsonl$/.test(entry));
    const withTimes = await Promise.all(transcripts.map(async (entry) => {
      const stat = await fsp.stat(path.join(directory, entry)).catch(() => null);
      return stat ? { entry, mtimeMs: stat.mtimeMs, size: stat.size } : null;
    }));
    const newest = withTimes.filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SUBAGENTS);

    const agents = await Promise.all(newest.map(async ({ entry, mtimeMs, size }): Promise<AgentMonitorNode> => {
      const transcriptPath = path.join(directory, entry);
      const agentId = entry.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let meta: AnyRecord = {};
      try {
        meta = asRecord(JSON.parse(await fsp.readFile(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'))) ?? {};
      } catch {
        // Written when the agent starts; a missing one only costs the agent's name.
      }

      let activityEntry = activityByFile.get(transcriptPath);
      if (!activityEntry || activityEntry.size !== size || activityEntry.mtimeMs !== mtimeMs) {
        const tail = await readTailRecords(transcriptPath, SUBAGENT_READ_BYTES);
        activityEntry = { size, mtimeMs, activity: summariseTranscript(tail?.records ?? []) };
        remember(activityByFile, transcriptPath, activityEntry);
      }
      const { activity } = activityEntry;

      let startedAt = startByFile.get(transcriptPath);
      if (startedAt === undefined) {
        startedAt = (await readFirstTimestamp(transcriptPath)) ?? mtimeMs;
        remember(startByFile, transcriptPath, startedAt);
      }

      const finished = meta.finished === true;
      const state = deriveAgentState(finished, mtimeMs, at);
      const description = asString(meta.description) ?? '';
      return {
        id: asString(meta.toolUseId) ?? agentId,
        name: asString(meta.agentType) ?? (description || 'agent'),
        kind: 'agent',
        description,
        state,
        startedAt,
        endedAt: state === 'running' ? null : mtimeMs,
        tokens: activity.tokens,
        toolCalls: activity.toolCalls,
        lastToolName: state === 'running' ? activity.pendingTool : null,
        tokensPerSecond: 0,
        model: asString(meta.model) ?? activity.model,
      };
    }));
    return agents.sort((a, b) => b.startedAt - a.startedAt);
  }

  return {
    /** Everything the transcript files say about a session right now. Never throws: a failure reads as "not found". */
    async readSession(cwd: string | null, sessionId: string): Promise<TranscriptSessionDetail> {
      const empty: TranscriptSessionDetail = { found: false, lastToolName: null, model: null, contextTokens: null, lastWriteAt: null, agents: [] };
      // The id comes from a file in the CLI's registry and becomes part of a path: only the CLI's own id shape is followed.
      if (!SAFE_SESSION_ID.test(sessionId)) return empty;
      try {
        const projectDirectory = await findProjectDirectory(cwd, sessionId);
        if (!projectDirectory) return empty;
        const at = now();
        const [tail, agents] = await Promise.all([
          readTailRecords(path.join(projectDirectory, `${sessionId}.jsonl`), MAIN_TAIL_BYTES),
          readAgents(projectDirectory, sessionId, at),
        ]);
        const activity = summariseTranscript(tail?.records ?? []);
        return {
          found: true,
          lastToolName: activity.pendingTool,
          model: activity.model,
          contextTokens: activity.contextTokens,
          lastWriteAt: tail?.mtimeMs ?? null,
          agents,
        };
      } catch {
        return empty;
      }
    },
  };
}

export type TranscriptReader = ReturnType<typeof createTranscriptReader>;
