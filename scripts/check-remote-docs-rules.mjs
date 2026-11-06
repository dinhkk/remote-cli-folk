// Data for check-remote-docs.mjs: which files must exist and which words each must contain.
// Paths in REQUIRED_FILES are relative to the repo root unless they start with "app:" (relative to the fork root).

export const MAX_DOC_LINES = 800;

export const DEPLOYMENT_GUIDE = 'docs/deployment-guide.md';
export const SYSTEM_ARCHITECTURE = 'docs/system-architecture.md';
export const PROJECT_ROADMAP = 'docs/project-roadmap.md';
export const RELAY_README = 'app:relay/README.md';

export const REQUIRED_FILES = [DEPLOYMENT_GUIDE, SYSTEM_ARCHITECTURE, PROJECT_ROADMAP, RELAY_README];

// Variables the docs must name even when the code that reads them is not merged yet.
const QUOTA_AND_RETENTION_VARS = [
  'CLOUDCLI_REMOTE_QUOTA_STREAMS',
  'CLOUDCLI_REMOTE_QUOTA_PTY',
  'CLOUDCLI_REMOTE_QUOTA_WS',
  'CLOUDCLI_REMOTE_QUOTA_NEW_STREAMS_PER_SECOND',
  'CLOUDCLI_REMOTE_QUOTA_VIOLATIONS_PER_MINUTE',
  'CLOUDCLI_REMOTE_QUOTA_SUSPEND_SECONDS',
  'CLOUDCLI_REMOTE_PAIRING_IDLE_DAYS',
  'CLOUDCLI_REMOTE_AUDIT_RETENTION_DAYS',
];

// Defaults the guide's environment table must agree with the code. Each entry: variable -> [source file inside the
// fork, regex whose first group is the default number in that file]. A source file that is not there (a partial
// checkout) is skipped; a regex that no longer matches is reported, so a refactor cannot silently drop the check.
// Variables not listed here (receive budgets, refused-upload limits) are only checked for being documented.
export const DOCUMENTED_DEFAULTS = {
  CLOUDCLI_REMOTE_QUOTA_STREAMS: ['server/modules/remote/quota/pairing-quota.service.ts', /maxStreams:\s*(\d+)/],
  CLOUDCLI_REMOTE_QUOTA_PTY: ['server/modules/remote/quota/pairing-quota.service.ts', /maxPty:\s*(\d+)/],
  CLOUDCLI_REMOTE_QUOTA_WS: ['server/modules/remote/quota/pairing-quota.service.ts', /maxWs:\s*(\d+)/],
  CLOUDCLI_REMOTE_QUOTA_NEW_STREAMS_PER_SECOND: ['server/modules/remote/quota/pairing-quota.service.ts', /newStreamsPerSecond:\s*(\d+)/],
  CLOUDCLI_REMOTE_QUOTA_VIOLATIONS_PER_MINUTE: ['server/modules/remote/quota/pairing-quota.service.ts', /violationsPerMinute:\s*(\d+)/],
  CLOUDCLI_REMOTE_QUOTA_SUSPEND_SECONDS: ['server/modules/remote/runtime/remote-hardening-config.ts', /DEFAULT_SUSPEND_SECONDS\s*=\s*(\d+)/],
  CLOUDCLI_REMOTE_PAIRING_IDLE_DAYS: ['server/modules/remote/pairing/pairing-expiry.service.ts', /DEFAULT_PAIRING_IDLE_DAYS\s*=\s*(\d+)/],
  CLOUDCLI_REMOTE_AUDIT_RETENTION_DAYS: ['server/modules/remote/audit/audit.service.ts', /DEFAULT_AUDIT_RETENTION_DAYS\s*=\s*(\d+)/],
};

const literal = (text) => ({ label: text, test: (doc) => doc.includes(text) });
const pattern = (label, regex) => ({ label, test: (doc) => regex.test(doc) });
const heading = (text) => pattern(`heading "${text}"`, new RegExp(`^#{1,6}\\s+${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi'));

// Each entry: [file, requirement]. A requirement is { label, test(docText) => boolean }.
export const REQUIRED_CONTENT = [
  [DEPLOYMENT_GUIDE, heading('Remote work (Controller / Host / relay)')],
  [DEPLOYMENT_GUIDE, heading('Operator runbook')],
  [DEPLOYMENT_GUIDE, heading('Security headers')],
  [DEPLOYMENT_GUIDE, heading('Quotas, expiry and audit')],
  [DEPLOYMENT_GUIDE, literal('HOST=127.0.0.1')],
  [DEPLOYMENT_GUIDE, literal('TRUST_PROXY')],
  [DEPLOYMENT_GUIDE, literal('CLOUDCLI_SETUP_TOKEN')],
  [DEPLOYMENT_GUIDE, literal('JWT_SECRET')],
  [DEPLOYMENT_GUIDE, pattern('warning: do not put Cloudflare Access in front of the Controller', /do not put Cloudflare Access/i)],
  [DEPLOYMENT_GUIDE, literal('CLOUDCLI_REMOTE_MASTER_KEY')],
  [DEPLOYMENT_GUIDE, literal('MASTER_KEY_MISMATCH')],
  [DEPLOYMENT_GUIDE, literal('CLAUDE_TOOL_APPROVAL_TIMEOUT_MS')],
  [DEPLOYMENT_GUIDE, literal('OPENCODE_TOOL_APPROVAL_TIMEOUT_MS')],
  [DEPLOYMENT_GUIDE, literal('CLOUDCLI_REMOTE_DISABLED')],
  [DEPLOYMENT_GUIDE, literal('RELAY_SECRET')],
  [DEPLOYMENT_GUIDE, literal('wrangler deploy')],
  [DEPLOYMENT_GUIDE, literal('workers.dev')],
  [DEPLOYMENT_GUIDE, pattern('rate-limiting rule note', /rate.limit/i)],
  [DEPLOYMENT_GUIDE, pattern('random worker name', /random[^.\n]*worker name/i)],
  [DEPLOYMENT_GUIDE, pattern('separate scoped Cloudflare API token', /scoped[^.\n]*token/i)],
  [DEPLOYMENT_GUIDE, pattern('phone test checklist', /phone test checklist/i)],
  [DEPLOYMENT_GUIDE, pattern('best-effort audit wording', /best-effort/i)],
  [DEPLOYMENT_GUIDE, literal('remote_audit')],
  [DEPLOYMENT_GUIDE, literal('frame-ancestors')],
  [DEPLOYMENT_GUIDE, pattern('log out everywhere', /log out everywhere/i)],
  ...QUOTA_AND_RETENTION_VARS.map((name) => [DEPLOYMENT_GUIDE, literal(name)]),
  [SYSTEM_ARCHITECTURE, pattern('full-trust Controller', /full-trust/i)],
  [SYSTEM_ARCHITECTURE, pattern('residual risks', /residual risks/i)],
  [SYSTEM_ARCHITECTURE, pattern('forward secrecy', /forward secrecy/i)],
  [SYSTEM_ARCHITECTURE, pattern('pairing code 40-bit risk', /40 bits/i)],
  [SYSTEM_ARCHITECTURE, pattern('pending user decision on a Host path denylist', /USER DECISION[\s\S]*path denylist/)],
  [SYSTEM_ARCHITECTURE, pattern('Cloudflare metadata', /metadata/i)],
  [SYSTEM_ARCHITECTURE, pattern('audit is best-effort', /best-effort/i)],
  [PROJECT_ROADMAP, literal('CloudCLI Remote Work')],
  [PROJECT_ROADMAP, pattern('milestones', /M1[\s\S]*M2[\s\S]*M3/)],
  [PROJECT_ROADMAP, literal('wrangler deploy')],
  [PROJECT_ROADMAP, pattern('30-minute soak', /soak/i)],
  [PROJECT_ROADMAP, literal('/ck:security')],
  [RELAY_README, literal('RELAY_SECRET')],
  [RELAY_README, pattern('random worker name', /random[^.\n]*worker name|worker name[^.\n]*random/i)],
  [RELAY_README, pattern('rate-limit note', /rate.limit/i)],
  [RELAY_README, literal('workers.dev')],
  [RELAY_README, literal('deployment-guide.md')],
  [RELAY_README, heading('Limits')],
  [RELAY_README, heading('What the relay can and cannot see')],
];
