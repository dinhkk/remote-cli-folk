// Runs the shared protocol scenarios against the real Worker + Room Durable Object in workerd.
// The same scenario list is run against `wrangler dev` (wrangler-dev.test.ts) and, in phases 05/06,
// against the in-process fake relay.
import { runConformance } from './conformance/scenarios';
import { workersHarness } from './support/workers-harness';

runConformance(workersHarness);
