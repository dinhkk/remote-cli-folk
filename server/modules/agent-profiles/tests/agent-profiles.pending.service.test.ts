import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { AgentChangeset } from '@/shared/types.js';

import { makeServiceRig, templateBody } from './service-rig.js';

const rigs: ReturnType<typeof makeServiceRig>[] = [];
afterEach(() => { while (rigs.length) rigs.pop()?.cleanup(); });
type Rig = ReturnType<typeof makeServiceRig>;

/** A rig whose agent `manager` is on the allowlist, like the Host user set it from the UI. */
const newRig = (): Rig => {
  const rig = makeServiceRig();
  rigs.push(rig);
  rig.store.updateSettings({ profileManagerAgents: ['manager'] });
  return rig;
};
const template = (slug: string, overrides: Record<string, unknown> = {}) => ({
  slug, family: 'worker', name: `Template ${slug}`, description: 'Does a thing.', instructions: `Work as ${slug}.`, tools: ['Read'], ...overrides,
});
const create = (slug: string, overrides: Record<string, unknown> = {}): AgentChangeset => ({ upsert: { format: 'remotecli.agent-bundle', version: 1, exportedAt: '', templates: [template(slug, overrides)], memoryBlocks: [] } });
const pendingDir = (rig: Rig) => path.join(rig.root, 'agent-profiles', 'pending');
const pendingFiles = (rig: Rig): string[] => (fs.existsSync(pendingDir(rig)) ? fs.readdirSync(pendingDir(rig)) : []);
const codeOf = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
};
const choices = (overrides: Partial<Parameters<Rig['pending']['confirm']>[1]> = {}) => ({ overwrite: [], acceptSensitive: [], basis: {}, ...overrides });
const HOUR = 60 * 60 * 1000;

describe('propose', () => {
  it('writes only a pending file (0600 in a 0700 folder) and never the live store', () => {
    const rig = newRig();
    const { proposal, review } = rig.pending.propose('manager', create('alpha'));
    assert.deepEqual(pendingFiles(rig), [`${proposal.id}.json`]);
    assert.equal(rig.service.listTemplates().items.length, 0, 'the store is untouched');
    assert.equal(review.items[0].action, 'create');
    const stored = JSON.parse(fs.readFileSync(path.join(pendingDir(rig), `${proposal.id}.json`), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['agentName', 'changeset', 'createdAt', 'expiresAt', 'id', 'summary']);
    assert.equal(stored.agentName, 'manager');
    assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.createdAt), 24 * HOUR);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(pendingDir(rig), `${proposal.id}.json`)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(pendingDir(rig)).mode & 0o777, 0o700);
    }
  });

  it('refuses an agent that is not on the allowlist, also when it was removed after its run started', () => {
    const rig = newRig();
    assert.equal(codeOf(() => rig.pending.propose('stranger', create('alpha'))), 'CHANGESET_NOT_ALLOWED');
    assert.equal(codeOf(() => rig.pending.preview('stranger', create('alpha'))), 'CHANGESET_NOT_ALLOWED');
    const current = rig.store.readSettings();
    rig.store.updateSettings({ profileManagerAgents: [] }, current.rev);
    assert.equal(codeOf(() => rig.pending.propose('manager', create('alpha'))), 'CHANGESET_NOT_ALLOWED');
    assert.deepEqual(pendingFiles(rig), []);
  });

  it('refuses the whole proposal with every reason when an item breaks a guardrail, and stages nothing', () => {
    const rig = newRig();
    const changeset: AgentChangeset = {
      upsert: {
        format: 'remotecli.agent-bundle', version: 1, exportedAt: '', memoryBlocks: [],
        templates: [template('alpha', { mcpServers: ['docs'] }), template('beta', { tools: ['mcp__profiles__profiles_propose'] })],
      },
    };
    assert.equal(codeOf(() => rig.pending.propose('manager', changeset)), 'CHANGESET_REFUSED');
    try { rig.pending.propose('manager', changeset); } catch (error) {
      assert.match((error as Error).message, /TEMPLATE_MCP_SERVERS/);
      assert.match((error as Error).message, /TEMPLATE_PROFILES_TOOL/);
    }
    assert.deepEqual(pendingFiles(rig), []);
  });

  it('refuses a proposal that changes nothing, a malformed one, and a manager\'s own template', () => {
    const rig = newRig();
    rig.service.createTemplate(template('alpha') as never);
    assert.equal(codeOf(() => rig.pending.propose('manager', create('alpha'))), 'CHANGESET_NOOP');
    assert.equal(codeOf(() => rig.pending.propose('manager', { upsert: {}, extra: 1 })), 'CHANGESET_INVALID');
    assert.equal(codeOf(() => rig.pending.propose('manager', create('manager'))), 'CHANGESET_REFUSED');
  });

  it('holds at most ten proposals; an eleventh is PENDING_FULL until the user answers one', () => {
    const rig = newRig();
    const ids = Array.from({ length: 10 }, (_, index) => rig.pending.propose('manager', create(`t-${index}`)).proposal.id);
    assert.equal(rig.pending.count(), 10);
    assert.equal(codeOf(() => rig.pending.propose('manager', create('one-more'))), 'PENDING_FULL');
    rig.pending.reject(ids[0]);
    assert.doesNotThrow(() => rig.pending.propose('manager', create('one-more')));
  });

  it('expired proposals are dropped on read, which frees their place, and cannot be confirmed', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha'));
    rig.state.now = new Date(rig.state.now.getTime() + 23 * HOUR);
    assert.equal(rig.pending.count(), 1);
    rig.state.now = new Date(rig.state.now.getTime() + 2 * HOUR);
    assert.equal(rig.pending.count(), 0);
    assert.deepEqual(pendingFiles(rig), [], 'the expired file was removed');
    assert.equal(codeOf(() => rig.pending.confirm(proposal.id, choices())), 'PENDING_NOT_FOUND');
  });
});

describe('list', () => {
  it('returns a fresh review and the basis to send back, without the raw changeset', () => {
    const rig = newRig();
    const created = rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'old' }));
    rig.pending.propose('manager', create('alpha', { instructions: 'new', name: 'Code reviewer', family: 'worker', description: '' }));
    const [view] = rig.pending.list();
    assert.equal(view.agentName, 'manager');
    assert.equal(view.items[0].action, 'overwrite');
    assert.deepEqual(view.basis, { 'template:alpha': created.rev });
    assert.ok(!('changeset' in view));
    // The review follows the store: after the template is deleted the same proposal reads as a create.
    rig.service.deleteTemplate(created.id);
    assert.equal(rig.pending.list()[0].items[0].action, 'create');
  });

  it('ignores a file that is not a valid proposal, a forged id, and a changeset that no longer parses', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha'));
    fs.writeFileSync(path.join(pendingDir(rig), 'junk.json'), 'not json');
    fs.writeFileSync(path.join(pendingDir(rig), 'other-id.json'), JSON.stringify({ ...proposal, id: 'different' }));
    fs.writeFileSync(path.join(pendingDir(rig), 'oversized.json'), JSON.stringify({ ...proposal, id: 'oversized', changeset: { upsert: { templates: Array.from({ length: 9 }, (_, index) => template(`x${index}`)) } } }));
    assert.deepEqual(rig.pending.list().map((view) => view.id), [proposal.id]);
    assert.equal(rig.pending.count(), 1);
  });
});

describe('confirm', () => {
  it('applies a create without a tick, removes the file, and returns per-item results', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha'));
    const result = rig.pending.confirm(proposal.id, choices());
    assert.deepEqual(result.items.map((item) => [item.key, item.status]), [['template:alpha', 'applied']]);
    assert.equal(rig.service.listTemplates().items[0].slug, 'alpha');
    assert.deepEqual(pendingFiles(rig), []);
    assert.equal(codeOf(() => rig.pending.confirm(proposal.id, choices())), 'PENDING_NOT_FOUND', 'a confirmed proposal is spent');
  });

  it('an overwrite needs the tick and the basis from the list; it takes a snapshot', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'old' }));
    const { proposal } = rig.pending.propose('manager', create('alpha', { instructions: 'new' }));
    const [view] = rig.pending.list();
    const result = rig.pending.confirm(proposal.id, choices({ overwrite: ['template:alpha'], basis: view.basis }));
    assert.equal(result.items[0].status, 'applied');
    assert.ok(result.snapshot);
    assert.ok(rig.snapshots.list().some((snapshot) => snapshot.name === result.snapshot));
    assert.equal(rig.service.listTemplates().items[0].instructions, 'new');
  });

  it('an overwrite without its tick is skipped and nothing is written', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'old' }));
    const { proposal } = rig.pending.propose('manager', create('alpha', { instructions: 'new' }));
    const result = rig.pending.confirm(proposal.id, choices({ basis: rig.pending.list()[0].basis }));
    assert.deepEqual([result.items[0].status, result.items[0].code], ['skipped', 'CONFLICT']);
    assert.equal(result.snapshot, null);
    assert.equal(rig.service.listTemplates().items[0].instructions, 'old');
  });

  it('an item that moved after the list was loaded fails as STALE', () => {
    const rig = newRig();
    const created = rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'old' }));
    const { proposal } = rig.pending.propose('manager', create('alpha', { instructions: 'new' }));
    const { basis } = rig.pending.list()[0];
    rig.service.updateTemplate(created.id, { ...templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'edited by the user' }), rev: created.rev });
    const result = rig.pending.confirm(proposal.id, choices({ overwrite: ['template:alpha'], basis }));
    assert.deepEqual([result.items[0].status, result.items[0].code], ['failed', 'STALE']);
    assert.equal(rig.service.listTemplates().items[0].instructions, 'edited by the user');
  });

  it('a sensitive item needs its own tick', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha', { tools: ['Bash'] }));
    const [view] = rig.pending.list();
    assert.deepEqual(view.items[0].sensitive, ['tool:Bash']);
    const again = rig.pending.confirm(proposal.id, choices());
    assert.equal(again.items[0].code, 'SENSITIVE_NOT_ACCEPTED');
    assert.equal(rig.service.listTemplates().items.length, 0);
    const second = rig.pending.propose('manager', create('alpha', { tools: ['Bash'] }));
    assert.equal(rig.pending.confirm(second.proposal.id, choices({ acceptSensitive: ['template:alpha'] })).items[0].status, 'applied');
  });

  it('re-runs the guardrails from scratch: a forged pending file and a changed allowlist do not get past confirm', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha'));
    // Someone edits the staged file to carry MCP servers: confirm still refuses it.
    const file = path.join(pendingDir(rig), `${proposal.id}.json`);
    const forged = JSON.parse(fs.readFileSync(file, 'utf8'));
    forged.changeset.upsert.templates[0].mcpServers = ['evil'];
    fs.writeFileSync(file, JSON.stringify(forged));
    const refused = rig.pending.confirm(proposal.id, choices());
    assert.equal(refused.items[0].code, 'TEMPLATE_MCP_SERVERS');
    assert.equal(rig.service.listTemplates().items.length, 0);

    const next = rig.pending.propose('manager', create('boss'));
    rig.store.updateSettings({ profileManagerAgents: ['manager', 'boss'] });
    assert.equal(rig.pending.confirm(next.proposal.id, choices()).items[0].code, 'TEMPLATE_IS_MANAGER');
    assert.equal(rig.service.listTemplates().items.length, 0);
  });

  it('applies as the agent: a global block text is written as agent:<name> whatever the proposal claims', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', { upsert: { memoryBlocks: [{ name: 'notes', description: '', mode: 'writable', scope: { kind: 'global' }, maxChars: 2000, content: 'hi', lastWriter: 'user' }] } });
    rig.pending.confirm(proposal.id, choices());
    assert.equal(rig.blocks.list().blocks[0].lastWriter, 'agent:manager');
  });

  it('a confirmed delete is snapshotted; a failed snapshot leaves the proposal for another try', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'notes', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'a', maxChars: 2000 });
    const { proposal } = rig.pending.propose('manager', { delete: [{ kind: 'block', key: 'notes' }] });
    const { basis } = rig.pending.list()[0];
    // An unreadable record makes a complete backup impossible: nothing is deleted and the file stays.
    fs.mkdirSync(path.join(rig.root, 'agent-profiles', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(rig.root, 'agent-profiles', 'templates', 'broken.json'), '{');
    assert.equal(codeOf(() => rig.pending.confirm(proposal.id, choices({ overwrite: ['block:notes'], basis }))), 'SNAPSHOT_UNAVAILABLE');
    assert.equal(rig.blocks.list().blocks.length, 1);
    assert.equal(pendingFiles(rig).length, 1);
    fs.rmSync(path.join(rig.root, 'agent-profiles', 'templates', 'broken.json'));
    const result = rig.pending.confirm(proposal.id, choices({ overwrite: ['block:notes'], basis }));
    assert.equal(result.items[0].status, 'applied');
    assert.ok(result.snapshot);
    assert.equal(rig.blocks.list().blocks.length, 0);
  });

  it('refuses an id that is not a profile id before touching any file', () => {
    const rig = newRig();
    assert.equal(codeOf(() => rig.pending.confirm('../settings', choices())), 'INVALID_PROFILE_ID');
    assert.equal(codeOf(() => rig.pending.reject('a/b')), 'INVALID_PROFILE_ID');
  });
});

describe('reject', () => {
  it('drops the proposal without writing the store; an unknown id is 404', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha'));
    assert.deepEqual(rig.pending.reject(proposal.id), { rejected: true });
    assert.deepEqual(pendingFiles(rig), []);
    assert.equal(rig.service.listTemplates().items.length, 0);
    assert.equal(codeOf(() => rig.pending.reject(proposal.id)), 'PENDING_NOT_FOUND');
  });
});

describe('malformed allowlist', () => {
  it('propose and confirm fail instead of guessing when the settings cannot be read', () => {
    const rig = newRig();
    const { proposal } = rig.pending.propose('manager', create('alpha'));
    fs.writeFileSync(path.join(rig.root, 'agent-profiles', 'settings.json'), JSON.stringify({ rev: 1, updatedAt: '', hiddenClaudeAgents: [], profileManagerAgents: 'manager' }));
    assert.equal(codeOf(() => rig.pending.propose('manager', create('beta'))), 'PROFILE_CORRUPT');
    assert.equal(codeOf(() => rig.pending.confirm(proposal.id, choices())), 'PROFILE_CORRUPT');
    assert.equal(rig.service.listTemplates().items.length, 0);
    assert.equal(pendingFiles(rig).length, 1);
  });
});
