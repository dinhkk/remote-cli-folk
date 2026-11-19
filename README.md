Hướng dẫn bổ sung: [Cài và kết nối Host Linux mới](docs/connect-new-host.vi.md) · [Các thay đổi của fork](docs/fork-changes.vi.md).

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
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SERVER_PORT` | Port the web server listens on | `3001` |
| `DATABASE_PATH` | Path to the SQLite storage database | `~/.remotecli/data.db` (or application root) |
| `CLAUDE_CLI_PATH` | Custom path to the Claude Code CLI binary | `claude` |
| `CONTEXT_WINDOW` | Fallback context window token limit | `160000` |

---

## Features

### 🤖 Multi-Agent Orchestration
Work with **Claude Code**, **Cursor CLI**, or **OpenAI Codex** within a single dashboard. RemoteCLI dynamically fetches available models at runtime, allowing you to choose the best model for your task.

### 💬 Interactive Chat & Diff Inspection
Real-time response streaming, syntax-highlighted code blocks, unified diff viewers, and collapsible tool executions give you complete transparency into what the agent is doing.

### 💻 Integrated Terminal (xterm.js)
Open full terminal sessions directly in the browser to run builds, test suites, or git operations alongside your agent conversations.

### 📁 File & Git Explorer
- **File Explorer**: Browse project directories, view file contents with syntax highlighting, and make quick edits.
- **Git Integration**: View modified files, inspect side-by-side diffs, stage files, switch branches, and commit changes.

### 🛡️ Safe by Default Tool Permissions
All agent tools (such as Bash, Write, Edit, Glob, Grep) can be inspected, allowed, or blocked through the **Tools Settings** modal. Prevent unintended destructive commands from running automatically.

### 🧩 Extensible Plugin System
Add custom tabs with their own frontend components and backend services. Install community plugins or develop custom extensions for task queues, session intelligence, or custom dashboards.

---

## System Requirements

- **Node.js**: `>= 22.5.0` (with built-in `node:sqlite` support)
- **Operating System**: Windows 10/11, macOS, or Linux
- **AI CLI**: At least one supported CLI installed on your machine:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
  - [Cursor CLI](https://docs.cursor.com/en/cli/overview)
  - [Codex](https://developers.openai.com/codex)

---

## Security & Privacy

- **Local Execution**: RemoteCLI runs as a local web service on your machine.
- **Your Own Credentials**: RemoteCLI connects directly to your local CLI sessions; you use your own provider authentication.
- **Permission Safety**: Tool execution permissions match your security preferences and can be toggled per session or globally.

---

## Repository & Community

- 🐙 **GitHub Repository**: [https://github.com/tunghuynh/remote-cli](https://github.com/tunghuynh/remote-cli)
- 📦 **NPM Package**: [@tunghuynh/remotecli](https://www.npmjs.com/package/@tunghuynh/remotecli)
- 🐛 **Issue Tracker**: [Report issues or suggest features](https://github.com/tunghuynh/remote-cli/issues)

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)](LICENSE).

Author: **Tùng Huynh** ([@tunghuynh](https://github.com/tunghuynh))
