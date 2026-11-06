// Types for the Workers test project: the bindings configured in wrangler.jsonc / vitest.config.ts
// and the main module exposed through `exports` from `cloudflare:workers`.
declare namespace Cloudflare {
  interface Env {
    ROOM: DurableObjectNamespace<import('../src/room').Room>;
    RELAY_SECRET?: string;
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
