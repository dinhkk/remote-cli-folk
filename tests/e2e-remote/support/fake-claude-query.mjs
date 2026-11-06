// Scripted stand-in for the Claude SDK `query` function, loaded by the Host server child process through
// the NODE_ENV=test seam (CLOUDCLI_TEST_CLAUDE_QUERY_MODULE). The REAL Claude runtime, permission cards,
// run registry and WebSocket code run around it; only the model is scripted.
//
// The first user prompt picks the scenario:
//   e2e:permission          one Bash approval
//   e2e:permission-twice    two Bash approvals in one run (a leaked "always allow" would skip the second card)
//   e2e:ask                 AskUserQuestion with two options
//   e2e:plan                ExitPlanMode with a plan
//   e2e:stream <n> <ms>     n assistant text chunks, <ms> apart
// Everything a scenario learns (what the approval callback returned) is appended as JSON lines to the file
// named by E2E_FAKE_PROVIDER_LOG, which is how the test reads "what the provider received".
//
// Plain .mjs on purpose: it must load under tsx (dev) and under plain node (the built dist-server).
import { appendFileSync } from 'node:fs';

const logFile = process.env.E2E_FAKE_PROVIDER_LOG;

const record = (entry) => {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};

const textOf = (message) => {
  const content = message?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

const assistantText = (sessionId, text) => ({
  type: 'assistant',
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'assistant', model: 'fake-e2e-model', content: [{ type: 'text', text }] },
});

export function createQuery({ prompt, options }) {
  const sessionId = `native-${Math.random().toString(16).slice(2, 10)}`;
  const aborted = new AbortController();

  const askApproval = async (toolName, input) => {
    const decision = await options.canUseTool(toolName, input, { signal: aborted.signal });
    record({ event: 'approval', toolName, input, decision, allowedTools: options.allowedTools ?? [] });
    return decision;
  };

  const script = async function* () {
    const iterator = prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    const text = first.done ? '' : textOf(first.value);
    record({ event: 'prompt', text });

    yield { type: 'system', subtype: 'init', session_id: sessionId };
    const [scenario, ...args] = text.trim().split(/\s+/);

    if (scenario === 'e2e:permission' || scenario === 'e2e:permission-twice') {
      const rounds = scenario === 'e2e:permission-twice' ? 2 : 1;
      for (let round = 1; round <= rounds && !aborted.signal.aborted; round += 1) {
        const decision = await askApproval('Bash', { command: `echo e2e-${round}` });
        const verdict = decision?.behavior === 'allow' ? 'allow' : `deny:${decision?.message ?? ''}`;
        yield assistantText(sessionId, `RESULT round ${round}: ${verdict}`);
      }
    } else if (scenario === 'e2e:ask') {
      const input = {
        questions: [
          {
            question: 'Pick one',
            header: 'Pick',
            multiSelect: false,
            options: [
              { label: 'Alpha', description: 'first' },
              { label: 'Beta', description: 'second' },
            ],
          },
        ],
      };
      const decision = await askApproval('AskUserQuestion', input);
      yield assistantText(sessionId, `RESULT ask: ${decision?.behavior ?? 'none'}`);
    } else if (scenario === 'e2e:plan') {
      const decision = await askApproval('ExitPlanMode', { plan: '# Plan\n- step one\n- step two' });
      yield assistantText(sessionId, `RESULT plan: ${decision?.behavior === 'allow' ? 'approved' : `rejected:${decision?.message ?? ''}`}`);
    } else if (scenario === 'e2e:stream') {
      const count = Number.parseInt(args[0] ?? '5', 10);
      const gapMs = Number.parseInt(args[1] ?? '20', 10);
      for (let index = 1; index <= count && !aborted.signal.aborted; index += 1) {
        yield assistantText(sessionId, `chunk-${index}`);
        await sleep(gapMs, aborted.signal);
      }
    } else {
      yield assistantText(sessionId, `echo: ${text}`);
    }

    yield { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'done' };
    // The runtime closes the held prompt when the turn is over; draining it lets the "CLI" exit like the real one.
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
    }
  };

  return Object.assign(script(), {
    interrupt: async () => { aborted.abort(); },
    stopTask: async () => undefined,
  });
}
