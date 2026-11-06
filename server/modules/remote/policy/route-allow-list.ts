/**
 * Route allow-list of the Host (FR-37, AC-13, contracts section 7): decides which HTTP routes and
 * WebSocket endpoints a remote Controller may reach. Default deny; the Host decides, the Controller is
 * never trusted (a modified Controller is refused here exactly like an honest one). The tables are in
 * `route-rules.ts` (exact allow list + deny families) and are surface reduction, not a boundary against
 * a hostile paired Controller; see the note there.
 *
 * Decision order for an HTTP request:
 *   1. the method must be one of GET/POST/PUT/PATCH/DELETE (exact, upper-case; no HEAD/OPTIONS/
 *      TRACE/CONNECT, no method-case guessing);
 *   2. the target is canonicalized (`path-canonicalizer`); a hostile target is refused;
 *   3. an explicit DENY rule wins over everything;
 *   4. an ALLOW rule must match both the path and the method;
 *   5. nothing matched: refused (`route-unknown`).
 *
 * Matching runs on the ASCII lower-cased decoded segments (Express matches routes case-insensitively,
 * ASCII only) but the path that is forwarded keeps the Controller's case (`Report.PDF` stays
 * `Report.PDF`). The route inventory test sweeps every mounted route through `classifyRoute` and
 * requires `allow` or `deny` ("unknown" would mean a route nobody classified).
 */

import type {
  RemoteCanonicalTarget,
  RemoteRouteDecision,
  RemoteWsChannel,
  RemoteWsTargetDecision,
} from '@/shared/types.js';

import { canonicalizeRequestTarget } from './path-canonicalizer.js';
import { ALLOWED_HTTP_METHODS, REMOTE_ALLOW_RULES, REMOTE_DENY_RULES, type RouteRule } from './route-rules.js';

export { ALLOWED_HTTP_METHODS, REMOTE_ALLOW_RULES, REMOTE_DENY_RULES, type RouteRule };

/**
 * Verdict of the table for one (method, path): `unknown` = no rule at all (still refused). A `deny`
 * says why: an explicit deny rule (`route-denied`) or an allow rule that does not list the method.
 * Consumed by: `classifyRoute` callers (`evaluateRemoteHttpRequest`, the route inventory sweep).
 */
export type RouteClassification =
  | { verdict: 'allow'; rule: string }
  | { verdict: 'deny'; rule: string; reason: 'route-denied' | 'method-not-allowed' }
  | { verdict: 'unknown'; rule: null };

/** Decides one HTTP request (method + request target). Consumed by: the Host bridge, the Controller proxy, tests. */
export type RemoteHttpPolicy = (method: string, target: string) => RemoteRouteDecision;

type CompiledRule = { rule: RouteRule; segments: readonly string[]; rest: boolean };

const compile = (rule: RouteRule): CompiledRule => {
  const parts = rule.pattern.split('/').filter((part) => part !== '');
  const rest = parts[parts.length - 1] === '**';
  return { rule, segments: rest ? parts.slice(0, -1) : parts, rest };
};

/** ASCII-only lower-casing: exactly the folding Express's case-insensitive route matching applies. */
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

const matches = (compiled: CompiledRule, lowered: readonly string[]): boolean => {
  const { segments, rest } = compiled;
  if (rest ? lowered.length < segments.length : lowered.length !== segments.length) return false;
  return segments.every((part, index) => part === '*' || part === lowered[index]);
};

const buildClassifier = (denyRules: readonly RouteRule[], allowRules: readonly RouteRule[]) => {
  const deny = denyRules.map(compile);
  const allow = allowRules.map(compile);
  return (method: string, segments: readonly string[]): RouteClassification => {
    const lowered = segments.map(asciiLower);
    for (const compiled of deny) {
      const { methods } = compiled.rule;
      if (matches(compiled, lowered) && (methods === undefined || methods.includes(method))) {
        return { verdict: 'deny', rule: compiled.rule.pattern, reason: 'route-denied' };
      }
    }
    let pathMatched: string | null = null;
    for (const compiled of allow) {
      if (!matches(compiled, lowered)) continue;
      if (compiled.rule.methods?.includes(method)) return { verdict: 'allow', rule: compiled.rule.pattern };
      pathMatched ??= compiled.rule.pattern;
    }
    // A path an allow rule covers but not for this method is a method refusal, not an unknown route.
    return pathMatched === null
      ? { verdict: 'unknown', rule: null }
      : { verdict: 'deny', rule: pathMatched, reason: 'method-not-allowed' };
  };
};

const evaluateWith = (classify: ReturnType<typeof buildClassifier>): RemoteHttpPolicy => (method, target) => {
  if (!ALLOWED_HTTP_METHODS.includes(method)) return { allowed: false, reason: 'method-not-allowed' };
  const canonicalized = canonicalizeRequestTarget(target);
  if (!canonicalized.ok) return { allowed: false, reason: 'invalid-target', detail: canonicalized.reason };
  const { canonical } = canonicalized;
  const classification = classify(method, canonical.segments);
  if (classification.verdict === 'allow') return { allowed: true, canonical, rule: classification.rule };
  if (classification.verdict === 'unknown') return { allowed: false, reason: 'route-unknown' };
  return { allowed: false, reason: classification.reason };
};

const defaultClassifier = buildClassifier(REMOTE_DENY_RULES, REMOTE_ALLOW_RULES);

/**
 * Looks a (method, decoded segments) pair up in the production table. Consumed by: the route
 * inventory sweep and the policy tests.
 */
export function classifyRoute(method: string, segments: readonly string[]): RouteClassification {
  return defaultClassifier(method, segments);
}

/**
 * Full policy for one HTTP request from the Controller (the production table). Consumed by: the Host
 * bridge (authoritative) and the Controller proxy for an early 403 (the Host always re-checks).
 */
export const evaluateRemoteHttpRequest: RemoteHttpPolicy = evaluateWith(defaultClassifier);

/**
 * A policy with extra ALLOW rules on top of the production table (the deny rules still win). The
 * production wiring never calls this: it exists so tests that drive the bridge or the proxy with
 * synthetic paths can say so explicitly instead of widening the production table.
 */
export function createRemoteHttpPolicy(options: { extraAllow?: readonly RouteRule[] } = {}): RemoteHttpPolicy {
  return evaluateWith(buildClassifier(REMOTE_DENY_RULES, [...REMOTE_ALLOW_RULES, ...(options.extraAllow ?? [])]));
}

const WS_ENDPOINTS = new Map<string, { channel: RemoteWsChannel; path: '/ws' | '/shell' }>([
  ['ws', { channel: 'chat', path: '/ws' }],
  ['shell', { channel: 'shell', path: '/shell' }],
]);

/**
 * Policy for one WebSocket open: only `/ws` (chat) and `/shell` (terminal), matched exactly (the Host
 * dispatches on the exact pathname). The query is dropped entirely: neither socket takes parameters
 * and `?token` is what the stock authentication reads first. Consumed by: the Host bridge.
 */
export function evaluateRemoteWebSocketTarget(target: string): RemoteWsTargetDecision {
  const canonicalized = canonicalizeRequestTarget(target);
  if (!canonicalized.ok) return { allowed: false, reason: 'invalid-target', detail: canonicalized.reason };
  const { segments }: RemoteCanonicalTarget = canonicalized.canonical;
  const endpoint = segments.length === 1 ? WS_ENDPOINTS.get(segments[0]) : undefined;
  if (!endpoint) return { allowed: false, reason: 'websocket-path' };
  return { allowed: true, channel: endpoint.channel, path: endpoint.path };
}
