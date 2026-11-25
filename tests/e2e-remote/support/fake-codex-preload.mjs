// Test-process preload only: no production provider hooks or external model calls.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Codex } from '@openai/codex-sdk';

if (process.env.NODE_ENV !== 'test') throw new Error('Fake Codex requires a test process');
function thread(id = randomUUID()) {
  return {
    id,
    async runStreamed(prompt, options = {}) {
      appendFileSync(process.env.E2E_FAKE_PROVIDER_LOG, JSON.stringify({ event: 'prompt', provider: 'codex', text: prompt }) + '\n');
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: id };
        for (let i = 0; i < 12; i++) {
          await setTimeout(100);
          if (options.signal?.aborted) throw new Error('Fake Codex turn aborted');
          yield { type: 'item.completed', item: { id: `item-${i}`, type: 'agent_message', text: `chunk-${i}` } };
        }
        yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 12 } };
      })() };
    },
  };
}
Codex.prototype.startThread = () => thread();
Codex.prototype.resumeThread = id => thread(id);
