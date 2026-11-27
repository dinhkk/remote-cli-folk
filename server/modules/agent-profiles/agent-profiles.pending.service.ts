import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError, assertValidProfileId, isValidAgentProfileName, isValidProfileId } from '@/shared/utils.js';
import type { ChangesetReview, ImportBasis, ImportResult, PendingProposal, PendingProposalView } from '@/shared/types.js';

import type { BundleService } from './agent-profiles.bundle.service.js';
import { parseChangeset, refusalText } from './agent-profiles.changeset.js';

/** A proposal waits this long for the user (then it is dropped when next read). */
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/** At most this many proposals wait at once; a new one is refused until the user answers some. */
const MAX_PENDING = 10;

type Dependencies = {
  /** `<root>/pending`: one `<id>.json` per proposal (folder 0700, files 0600). */
  directory: string;
  bundle: BundleService;
  /** Names allowed to use the `profiles` tools, read fresh on every call; throws when the settings are unreadable (nothing is then proposed or confirmed). */
  getManagers: () => string[];
  now?: () => Date;
  newId?: () => string;
};

const notFound = (): AppError => new AppError('No such pending proposal (it may have expired or been handled already)', { code: 'PENDING_NOT_FOUND', statusCode: 404 });

/**
 * Proposals an allowlisted agent staged and the Host user confirms or rejects. A proposal is only a file: staging never
 * touches the live store. Confirm re-checks everything from the store as it is then (guardrails, plan, revisions) and applies
 * through the bundle service with the agent as the actor and a snapshot first; the staged summary is never trusted. A pending
 * file is plain JSON that anyone with file access could write, so every read validates it from scratch (an unreadable file
 * is ignored, never applied). Synchronous like the other stores, so confirm and reject cannot interleave.
 * Consumed by: agent-profiles.routes.ts, agent-profiles.profiles.mcp.ts (via agent-profiles.module.ts).
 */
export function createPendingService(dependencies: Dependencies) {
  const { directory, bundle } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  const fileOf = (id: string): string => path.join(directory, `${id}.json`);

  /** A proposal read from `file`, or null when it is absent, unreadable or not a proposal this version wrote (never throws). */
  function readFile(file: string, id: string): PendingProposal | null {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.id !== id || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt))
      || !isValidAgentProfileName(record.agentName) || !Array.isArray(record.summary)) return null;
    try {
      return { ...(record as unknown as PendingProposal), changeset: parseChangeset(record.changeset) };
    } catch {
      return null;
    }
  }

  /** One proposal by id; an expired one is removed and reads as absent. */
  function readOne(id: string): PendingProposal | null {
    assertValidProfileId(id);
    const proposal = readFile(fileOf(id), id);
    if (!proposal) return null;
    if (Date.parse(proposal.expiresAt) <= now().getTime()) {
      fs.rmSync(fileOf(id), { force: true });
      return null;
    }
    return proposal;
  }

  /** Every valid, unexpired proposal, oldest first; expired files are removed on the way. */
  function readAll(): PendingProposal[] {
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const proposals: PendingProposal[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
      if (!isValidProfileId(id)) continue;
      const proposal = readOne(id);
      if (proposal) proposals.push(proposal);
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function write(proposal: PendingProposal): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort (Windows) */ }
    const temp = `${fileOf(proposal.id)}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, fileOf(proposal.id));
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  /** The agent must still be on the allowlist when it asks (the user may have removed it while its run was open). */
  function requireManager(agentName: string): string[] {
    const managers = dependencies.getManagers();
    if (!managers.includes(agentName)) {
      throw new AppError('This agent is not allowed to manage profiles', { code: 'CHANGESET_NOT_ALLOWED', statusCode: 403 });
    }
    return managers;
  }

  return {
    /** Guardrails and summary of a changeset for `agentName`; writes nothing. Errors are `CHANGESET_*`. */
    preview(agentName: string, rawChangeset: unknown): ChangesetReview {
      const managers = requireManager(agentName);
      return bundle.reviewChangeset(parseChangeset(rawChangeset), managers);
    },

    /**
     * Stages a changeset for the user. Refused as a whole (`CHANGESET_REFUSED`, with every reason) when any item breaks a
     * guardrail, `CHANGESET_NOOP` when nothing would change, `PENDING_FULL` (409) at ten waiting proposals. Writes only the
     * pending file.
     */
    propose(agentName: string, rawChangeset: unknown): { proposal: PendingProposal; review: ChangesetReview } {
      const managers = requireManager(agentName);
      const changeset = parseChangeset(rawChangeset);
      const review = bundle.reviewChangeset(changeset, managers);
      if (review.refused) throw new AppError(`The proposal was refused:\n${refusalText(review.items)}`, { code: 'CHANGESET_REFUSED', statusCode: 400 });
      if (review.items.every((item) => item.action === 'identical')) {
        throw new AppError('Everything in this proposal already exists as written; there is nothing to propose.', { code: 'CHANGESET_NOOP', statusCode: 400 });
      }
      if (readAll().length >= MAX_PENDING) {
        throw new AppError(`${MAX_PENDING} proposals are already waiting for the user. Ask the user to confirm or reject some first.`, { code: 'PENDING_FULL', statusCode: 409 });
      }
      const createdAt = now();
      const proposal: PendingProposal = {
        id: newId(), createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PROPOSAL_TTL_MS).toISOString(), agentName, changeset, summary: review.items,
      };
      write(proposal);
      return { proposal, review };
    },

    /** Waiting proposals, each with a fresh review against the store now and the `basis` map to send back at confirm. */
    list(): PendingProposalView[] {
      const proposals = readAll();
      if (proposals.length === 0) return [];
      const managers = dependencies.getManagers();
      return proposals.map((proposal) => {
        const { items } = bundle.reviewChangeset(proposal.changeset, managers);
        const basis: Record<string, ImportBasis> = {};
        for (const item of items) basis[item.key] = item.basis;
        return { id: proposal.id, createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, agentName: proposal.agentName, items, basis };
      });
    },

    /** How many proposals wait (for the badge). */
    count: (): number => readAll().length,

    /**
     * Applies what the user ticked (see `BundleService.applyChangeset`), then removes the pending file: a confirmed proposal is
     * spent whatever the per-item results were. An error thrown before anything was applied (such as `SNAPSHOT_UNAVAILABLE`)
     * leaves the file for another try.
     */
    confirm(id: string, choices: { overwrite: string[]; acceptSensitive: string[]; basis: Record<string, ImportBasis> }): ImportResult {
      const proposal = readOne(id);
      if (!proposal) throw notFound();
      const result = bundle.applyChangeset(proposal.changeset, { agentName: proposal.agentName, managers: dependencies.getManagers(), ...choices });
      fs.rmSync(fileOf(id), { force: true });
      return result;
    },

    /** Drops a proposal without applying anything. */
    reject(id: string): { rejected: true } {
      if (!readOne(id)) throw notFound();
      fs.rmSync(fileOf(id), { force: true });
      return { rejected: true };
    },
  };
}

/** Pending service type the routes and the `profiles` tools depend on. Consumed by: agent-profiles.routes.ts, agent-profiles.profiles.mcp.ts. */
export type PendingService = ReturnType<typeof createPendingService>;
