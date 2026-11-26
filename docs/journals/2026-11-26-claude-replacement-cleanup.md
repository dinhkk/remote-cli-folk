# Claude replacement process cleanup

## Problem

Sending a replacement turn could clear background-task tracking while the old Claude
process and its child tools remained alive. Running also collapsed multiple roots with
the same provider session id, so an older root could not be targeted independently.

## Changes

- Capture the SDK child and await cooperative stop followed by bounded, verified process
  cleanup before constructing a replacement query. Retain tasks and ownership on failure.
- Keep old query events from clearing task state or emitting terminal events during cleanup.
- List earlier roots separately in Running with their own child groups. Resolve an earlier
  kill against its exact registry identity and protect other roots, including newer turns.
- Share process primitives in process-control without initializing the monitor from providers.
- Explain destructive Send anyway behavior and the non-destructive Queue alternative.

## Verification

Disposable local Node process trees exercise repeated replacement, orphan descendants,
protected sessions and retry after failed kill. Runtime tests verify tracking survives
until process exit; monitor fixtures verify distinct roots, child groups and kill targeting.
The runtime/monitor regressions fail on the preceding revision and pass with the change.
Real Claude task timing and UI acceptance require a separate Host verification; local
fixtures do not claim to cover the CLI's platform-specific task launcher behavior.
