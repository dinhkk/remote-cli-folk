# Process control

Shared operating-system primitives used by the Claude runtime and agent monitor.
Import the public `index.ts`; this module does not initialize routes or provider state.

- `process-reader.ts`: abortable process-table reads (POSIX ps / Windows PowerShell).
- `process-usage.ts`: samples, process trees, resource usage and child groups.
- `process-kill.ts`: exact-pid command construction, root verification, protected trees,
  guarded kills and verification of the result from a fresh process table.

The monitor retains its existing root/start-time checks and limits. Claude replacement
uses `claude-process-lifecycle.ts` to bind cleanup to its own spawned child, capture
its descendants before cooperative stop, wait 2 seconds, then force-stop verified
survivors within a 12-second budget. Linux identities use procfs start ticks (zombies
count as exited); macOS uses ps start timestamps; Windows uses creation timestamps.
Unverifiable identities and protected session trees fail closed. Cleanup errors keep
ownership for a retry and prevent the replacement query from starting.

Tests for the extracted primitives remain under `agent-monitor/tests`; lifecycle tests
under `providers/tests` use disposable local Node process trees, never real CLI sessions.
