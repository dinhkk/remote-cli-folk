/**
 * Policy for tests that drive the bridge or the Controller proxy with SYNTHETIC paths (`/api/projects/echo`,
 * `/api/projects/sse`, ...) served by a fake Host. The production table is an exact list of real routes, so
 * those paths would be refused as `route-unknown`; this policy keeps the production deny rules and adds the
 * old family prefixes on top. Production code never uses it.
 */

import { createRemoteHttpPolicy } from '../../policy/route-allow-list.js';

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const syntheticPathPolicy = createRemoteHttpPolicy({
  extraAllow: ['/api/projects/**', '/api/file-tree/**', '/api/git/**', '/api/assets/**', '/api/providers/**', '/api/commands/**'].map((pattern) => ({
    pattern,
    methods: ALL_METHODS,
    note: 'test-only family prefix for synthetic fake-Host paths',
  })),
});
