<div align="center">
  <img src="https://cdn.jsdelivr.net/npm/@tunghuynh/remotecli/dist/logo.svg" alt="RemoteCLI Logo" width="80" height="80">
  <h1>RemoteCLI</h1>
  <p><b>A modern web-based remote UI for Claude Code, Cursor CLI, and OpenAI Codex.</b><br>
  <i>Customized fork adapted from <a href="https://cloudcli.ai">CloudCLI</a>.</i><br>
  Access, manage, and collaborate with your coding agents from any device, anywhere.</p>

  <p>
    <a href="https://www.npmjs.com/package/@tunghuynh/remotecli"><img src="https://img.shields.io/npm/v/@tunghuynh/remotecli.svg?style=flat-square&color=2563eb" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@tunghuynh/remotecli"><img src="https://img.shields.io/npm/dm/@tunghuynh/remotecli.svg?style=flat-square&color=blue" alt="npm downloads"></a>
    <a href="https://github.com/tunghuynh/remote-cli"><img src="https://img.shields.io/github/stars/tunghuynh/remote-cli?style=flat-square&color=yellow" alt="GitHub Stars"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg?style=flat-square" alt="Node.js Version"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="License"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square" alt="Platform">
  </p>
</div>

---

## Overview

**RemoteCLI** provides an intuitive, responsive web interface for local AI coding CLI tools like [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor CLI](https://docs.cursor.com/en/cli/overview), and [OpenAI Codex](https://developers.openai.com/codex).

> **Note:** RemoteCLI is an enhanced and customized fork built upon the foundation of [CloudCLI (cloudcli.ai)](https://cloudcli.ai), adding full zero-C++ build requirements (using pure Node.js `node:sqlite` & `bcryptjs`), deep branding, optimized mobile controls, and customized multi-agent workflows.

Instead of being tethered to a single terminal window, RemoteCLI lets you monitor agent executions, edit files, inspect diffs, approve permissions, and run shell commands from any desktop browser, laptop, tablet, or mobile phone.

### ✨ Highlights

- ⚡ **Zero C++ Build Tools Needed**: Powered entirely by Node.js built-in `node:sqlite` and pure-JavaScript `bcryptjs`. No Visual Studio C++ Build Tools on Windows, no Xcode on macOS, and no `node-gyp` compilation errors.
- 🔄 **Direct CLI & Config Sync**: Reads and writes directly to your local configuration (`~/.claude`). Your existing projects, session history, and MCP tools are discovered automatically.
- 📱 **Mobile & PWA Ready**: Fully responsive mobile UI with touch navigation, virtual quick-keys, and iOS/Android home screen installation support.
- 🤖 **Multi-Agent Support**: Switch between Claude Code, Cursor CLI, and Codex within the same unified dashboard.
- 🔒 **100% Local & Private**: All data, sessions, and databases remain strictly on your own hardware. No external telemetry or cloud lock-in.

---

## Screenshots

<div align="center">

<table>
<tr>
<td align="center">
<h3>Desktop Interface</h3>
<img src="https://cdn.jsdelivr.net/npm/@tunghuynh/remotecli/dist/screenshots/desktop-main.png" alt="Desktop Interface" width="480">
<br>
<em>Full workspace with project explorer, active sessions, interactive chat, and tool execution logs</em>
</td>
<td align="center">
<h3>Mobile Experience</h3>
<img src="https://cdn.jsdelivr.net/npm/@tunghuynh/remotecli/dist/screenshots/mobile-chat.png" alt="Mobile Interface" width="280">
<br>
<em>Responsive mobile design with touch controls, live diff views, and tool details</em>
</td>
</tr>
<tr>
<td align="center">
<h3>CLI & Model Selection</h3>
<img src="https://cdn.jsdelivr.net/npm/@tunghuynh/remotecli/dist/screenshots/cli-selection.png" alt="CLI Selection" width="400">
<br>
<em>Switch seamlessly between Claude Code, Cursor CLI, and Codex</em>
</td>
<td align="center">
<h3>Safe Tool Permission Controls</h3>
<img src="https://cdn.jsdelivr.net/npm/@tunghuynh/remotecli/dist/screenshots/tools-modal.png" alt="Tools Settings Modal" width="400">
<br>
<em>Fine-grained control over allowed and disallowed agent tools</em>
</td>
</tr>
</table>

</div>

---

## Quick Start

### Prerequisites

- **Node.js**: `>= 22.5.0` (with built-in `node:sqlite`, zero C++ build tools required)
- **AI CLI**: At least one supported AI CLI installed and authenticated on your machine:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
  - [Cursor CLI](https://docs.cursor.com/en/cli/overview)
  - [OpenAI Codex](https://developers.openai.com/codex)

### Method 1: Instant Run with npx (No Installation Needed)

Run RemoteCLI directly from npm with a single command:

```bash
npx @tunghuynh/remotecli@latest
```

To run on a specific port:

```bash
npx @tunghuynh/remotecli@latest --port 8080
```

### Method 2: Global Installation via npm (Recommended)

Install RemoteCLI globally on your machine for daily use:

```bash
npm install -g @tunghuynh/remotecli
```

Then start RemoteCLI anytime simply by running:

```bash
remotecli
```

Or start on a custom port:

```bash
remotecli --port 8080
```

### Accessing the Web UI

Once started, open your browser and navigate to:

👉 **`http://localhost:3001`**

- **First Launch**: Create your owner password to secure your local dashboard.
- **Sync**: RemoteCLI automatically discovers and syncs your local projects, sessions, git status, and MCP tools from `~/.claude`.

---

## Access From Mobile or LAN

To use RemoteCLI from your smartphone, tablet, or another laptop on your local network:

1. Start RemoteCLI on your host machine:
   ```bash
   remotecli
   ```
2. Find your host machine's local IP address (e.g., `192.168.1.50`).
3. Open `http://<YOUR_LOCAL_IP>:3001` in your mobile browser.
4. *(Optional)* Tap **"Add to Home Screen"** in Safari / Chrome for a standalone full-screen mobile app experience.

> **Security:** Before opening RemoteCLI to other devices, turn on two-factor sign-in under **Settings → Sessions**.

> **Tip:** You can also use secure mesh networks like [Tailscale](https://tailscale.com/) or WireGuard to access your coding agents securely from anywhere outside your local network.

---

## 🌐 Remote Work (End-to-End Encrypted Cloudflare Relay)

RemoteCLI features a built-in **Remote Work** architecture that allows you to access and control your coding agents from anywhere (via smartphone, tablet, or another laptop on 4G/5G or external Wi-Fi) **without** exposing public ports, setting up port-forwarding, configuring dynamic DNS, or running a VPN.

### 🔒 Security & Privacy Architecture

```
[ Controller (Phone / Laptop) ]
               │
               │  wss:// (End-to-End Encrypted binary frames - AES-256-GCM)
               ▼
   [ Cloudflare Worker Relay ]  (Dumb pipe: forwards opaque ciphertext, zero access to keys/data)
               ▲
               │  wss:// (End-to-End Encrypted binary frames - AES-256-GCM)
               │
   [ Host (Your Workstation) ] ──▶ Claude Code / Cursor / Codex CLI
```

- **Zero-Knowledge & End-to-End Encrypted**: All communication between your Host (workstation) and Controller (remote device) is encrypted end-to-end using **AES-256-GCM**.
- **Dumb Pipe Relay**: The relay only forwards encrypted binary frames between paired rooms. It never sees encryption keys, authentication tokens, prompts, codebase contents, or credentials.
- **Cost**: Runs 100% within the Cloudflare Workers **Free tier** (100,000 requests/day, zero maintenance cost).

### 🚀 Deploying Your Own Cloudflare Relay in 2 Minutes

The relay server code is open-source and included in this repository:
📁 **Relay Source Code**: [`relay/`](https://github.com/tunghuynh/remote-cli/tree/main/relay) (Detailed spec: [`relay/README.md`](https://github.com/tunghuynh/remote-cli/blob/main/relay/README.md))

#### Step 1: Clone the relay source and authenticate with Cloudflare

```bash
# Clone the repository
git clone https://github.com/tunghuynh/remote-cli.git
cd remote-cli/relay

# Install dependencies
npm ci --ignore-scripts

# Authenticate with Cloudflare (opens browser)
npx wrangler login
```

*(On headless VPS servers without a browser, you can alternatively set `export CLOUDFLARE_API_TOKEN=<your-token>`)*

#### Step 2: Deploy the Cloudflare Worker

```bash
npx wrangler deploy
```

#### Step 3: Generate and set your `RELAY_SECRET`

The relay requires a strong shared secret (at least 32 characters) to guard against unauthorized access to your worker:

```bash
# Generate a cryptographically secure 43-character base64url secret
RELAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")

# Store the secret in your Cloudflare Worker
echo "$RELAY_SECRET" | npx wrangler secret put RELAY_SECRET
```

> **Save your Relay URL & Secret**:
> - **Relay URL**: `wss://<your-worker-name>.<your-subdomain>.workers.dev`
> - **Relay Secret**: The generated `$RELAY_SECRET` string above.
>
> *(You can verify that the relay is healthy by visiting `https://<your-worker-name>.<your-subdomain>.workers.dev/healthz`, which will return HTTP 200)*

---

### 📱 Connecting RemoteCLI to Your Relay

#### On Your Host (Your Coding Workstation)

1. Start RemoteCLI:
   ```bash
   remotecli
   ```
2. Open `http://localhost:3001` and navigate to **Settings** ➔ **Remote work**.
3. Under the **Relay** section:
   - Enter your **Relay URL**: `wss://<your-worker-name>.<your-subdomain>.workers.dev`
   - Enter your **Relay secret**.
   - Click **Save relay**.
4. Under **Host settings**:
   - Toggle on **Accept remote connections**.
   - Click **Generate pairing code** (a secure, single-use 6-digit or QR pairing code).

#### On Your Controller (Mobile Phone / Tablet / Remote Browser)

1. Open your RemoteCLI web UI or desktop app on your remote device.
2. In **Settings** ➔ **Remote work**, ensure the same **Relay URL** and **Relay secret** are saved.
3. In the **Hosts** sidebar/tab, tap **Pair host** and enter the pairing code from your Host machine.
4. 🎉 **Connected!** Your workstation will appear as an active host tab. You can now chat with Claude Code, approve permissions, inspect diffs, edit files, and run commands from anywhere in the world.

---

## CLI Commands & Options

```
RemoteCLI - Command Line Tool

Usage:
  remotecli [command] [options]

Commands:
  start            Start the RemoteCLI server (default)
  status           Show current configuration, paths, and database status
  update           Check and update RemoteCLI to the latest version
  version          Show installed package version
  help             Show CLI help and usage information
  sandbox          Manage Docker sandbox environments (experimental)
  browser-use-mcp  Run Browser MCP stdio server
  reset-totp       Turn two-factor sign-in off and sign out every browser

Options:
  -p, --port <port>        Set server port (default: 3001)
  --database-path <path>   Set custom SQLite database path
  -h, --help               Show this help information
  -v, --version            Show version information
```

### Examples

```bash
# Start on default port 3001
remotecli

# Start on a custom port
remotecli --port 8080

# Inspect configuration and database storage location
remotecli status

# Update to latest version
remotecli update

# Lost your authenticator? Stop the server first, then:
remotecli reset-totp
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SERVER_PORT` | Port the web server listens on | `3001` |
| `DATABASE_PATH` | Path to the SQLite storage database | `~/.remotecli/data.db` (or application root) |
| `CLAUDE_CLI_PATH` | Custom path to the Claude Code CLI binary | `claude` |
| `CONTEXT_WINDOW` | Fallback context window token limit | `160000` |
| `REMOTECLI_PLUGINS_DISABLED` | `1` turns the plugin feature off: no plugin is installed, updated, started or served, and the UI shows no plugin tabs. Read at startup; installed plugins stay on disk and work again once the variable is removed. Recommended on a server used only as a Remote Controller. | unset (plugins on) |
| `REMOTECLI_ALLOWED_ORIGINS` | Comma-separated extra origins that may use the sign-in cookie, for example a reverse proxy's public `https://` origin. Write each origin in full. A wildcard stops the server at startup. | unset (own origin only) |
| `REMOTECLI_MASTER_KEY_FILE` | Key file that encrypts authenticator seeds and Remote data. Back it up with the database. | `~/.remotecli/remote-master.key` |
| `AGENT_PROFILES_DIR` | Folder of the agent templates, the hidden Claude agents, the parameter values remembered per folder and the memory blocks (Settings → Agent Profiles) | `~/.claude-code-ui/agent-profiles` |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | Set to `0` by default for Claude runs so Anthropic-compatible gateways accept requests that use agent definitions; set it yourself to override | `0` |

---

## Features

### 🤖 Multi-Agent Orchestration
Work with **Claude Code**, **Cursor CLI**, or **OpenAI Codex** within a single dashboard. RemoteCLI dynamically fetches available models at runtime, allowing you to choose the best model for your task.

### 🧑‍🤝‍🧑 Agent Profiles (a team of specialist agents per chat)
Define agent templates (code review, coding, testing, reporting, business analysis, Q&A) and generate them into a project's `.claude/agents/` folder (or `~/.claude/agents/`) from **Settings → Agent Profiles** (a setup guide walks you through it). The generated files are native Claude Code agents, so the CLI sees them too. A new Claude chat can be opened with one of the project's agents as its main agent; that agent takes the request and delegates to the others. Agent files apply from the next run on. Claude's own agents can be hidden from the chat. Remote controllers can only see the main-agent names of a project. The **Memory** tab of the same settings holds shared memory blocks (named text, `read-only` or `writable`, global or per project: a project block has separate content per folder, and agents see it only in folders you add it to) that agents read and write in this app's chats; it is Host only. Details: [docs/architecture/07-agent-profiles.md](docs/architecture/07-agent-profiles.md).

### 📊 Agent Monitor (the Running tab of the sidebar)
A live picture of what is running **anywhere on the machine**, in the sidebar's **Running** tab on desktop and phone. The tab is a monitoring centre: on the left a tree, Project → Session → Main agent → its sub-agents and process groups (each with a state dot, running time and tokens); on the right the main pane. With nothing selected the pane shows the overview: KPI strip, the live graph of every running session, tokens per minute and today, and CPU and memory per session (the Claude process and the tools it started) and for the server. Click a session, its main agent, a sub-agent or a process group (in the tree or in the graph) to see that session's graph with it highlighted and its numbers beside it (click again to let go); a click never opens a chat (use the Projects tab, or "view in chat" in a sub-agent's Activity); click a box in the graph to select the same row in the tree. Claude sessions started in a terminal are listed too (marked "terminal"), under the project of the same folder: they are read from the CLI's own session files and transcripts, so they are approximate and can lag a few seconds; one without a chat in the app shows its graph. There is no per-agent CPU or memory, because the agents of one chat share one process. A highlighted box has a **kill button** (two presses): a sub-agent is asked to stop (and can then be force-killed with its session), the main agent ends the whole Claude session, a process group ends those child processes. Polling, CPU, memory and transcript reading only happen while the Running tab is open. Motion (spinners, pulse, flowing dots) follows your system's reduced-motion setting. Remote controllers can read it too and can press kill (a phone can chat and monitor; the Remote audit log records each kill), which means a paired Remote device sees the Host's project folder paths and process names. Details: [docs/architecture/08-agent-monitor.md](docs/architecture/08-agent-monitor.md).

### 💬 Interactive Chat & Diff Inspection
Real-time response streaming, syntax-highlighted code blocks, unified diff viewers, and collapsible tool executions give you complete transparency into what the agent is doing.

### 💻 Integrated Terminal (xterm.js)
Open full terminal sessions directly in the browser to run builds, test suites, or git operations alongside your agent conversations.

### 📁 File & Git Explorer
- **File Explorer**: Browse project directories, view file contents with syntax highlighting, and make quick edits.
- **Git Integration**: View modified files, inspect side-by-side diffs, stage files, switch branches, and commit changes.

### 🛡️ Safe by Default Tool Permissions
All agent tools (such as Bash, Write, Edit, Glob, Grep) can be inspected, allowed, or blocked through the **Tools Settings** modal. Prevent unintended destructive commands from running automatically.

### 🔐 Two-Factor Sign-in & Session Lock
Protect sign-in with an authenticator app (TOTP) and 10 single-use recovery codes. While two-factor sign-in is on, a session locks after 24 hours without web activity (you can set 1 to 168 hours). The **Lock session** button locks it at once. Only an authenticator code unlocks it. **Settings → Sessions** lists every signed-in browser and signs out one device or all of them.

### 🧩 Extensible Plugin System
Add custom tabs with their own frontend components and backend services. Install community plugins or develop custom extensions for task queues, session intelligence, or custom dashboards. Set `REMOTECLI_PLUGINS_DISABLED=1` to turn plugins off on a server (recommended on a Controller-only server).

---

## System Requirements

- **Node.js**: `>= 22.5.0` (with built-in `node:sqlite` support)
- **Operating System**: Windows 10/11, macOS, or Linux
- **AI CLI**: At least one supported CLI installed on your machine:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
  - [Cursor CLI](https://docs.cursor.com/en/cli/overview)
  - [Codex](https://developers.openai.com/codex)

---

## Running Tests From a Source Checkout

Use Node.js 22.5 or newer. Install both packages before running the server suite:

```bash
# From the repository root
npm ci
cd relay
npm ci
cd ..
npm test
```

The server suite imports the relay package's conformance scenarios, so installing only
the root dependencies is insufficient. Missing relay dependencies fail this guard with
setup instructions. Set `SKIP_RELAY_CONFORMANCE=1` only to explicitly skip that guard;
it is not a substitute for running conformance before review.

The 12 parent-workspace documentation checks require `docs/deployment-guide.md`,
`docs/system-architecture.md`, `docs/project-roadmap.md`, and
`project/cloud-cli-remote/claudecodeui/relay/README.md` relative to the directory three
levels above this checkout. These checks are skipped with the missing paths listed
when all four files are absent, as in a standalone public checkout. If any is present,
the checks run normally and report missing or invalid documentation.

---

## Security & Privacy

- **Local Execution**: RemoteCLI runs as a local web service on your machine.
- **Your Own Credentials**: RemoteCLI connects directly to your local CLI sessions; you use your own provider authentication.
- **Permission Safety**: Tool execution permissions match your security preferences and can be toggled per session or globally.
- **Browser Sessions**: RemoteCLI keeps sign-in in an `HttpOnly`, `SameSite=Strict` cookie. The cookie expires 7 days after sign-in. When you sign out a device, its open tabs and terminals close too.
- **Two-Factor Sign-in**: TOTP is optional. RemoteCLI encrypts authenticator seeds on disk. When you change the password or turn two-factor sign-in on or off, every other device is signed out. While two-factor sign-in is on, these actions also need a new authenticator code.
- **HTML Preview Isolation**: When you preview a saved HTML file in the editor, its scripts run in an isolated frame with no network access and no access to RemoteCLI or your sign-in. In a Remote tab the Controller sets the policy of the preview page, and the Host cannot change it.

---

## Repository & Community

- 🐙 **GitHub Repository**: [https://github.com/tunghuynh/remote-cli](https://github.com/tunghuynh/remote-cli)
- 📦 **NPM Package**: [@tunghuynh/remotecli](https://www.npmjs.com/package/@tunghuynh/remotecli)
- 🐛 **Issue Tracker**: [Report issues or suggest features](https://github.com/tunghuynh/remote-cli/issues)

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)](LICENSE).

Author: **Tùng Huynh** ([@tunghuynh](https://github.com/tunghuynh))
