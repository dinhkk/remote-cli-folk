---
name: remotecli-create-template
description: Draft a new agent template and propose it for the user to confirm. Use when the user wants a new agent (a main orchestrator or a worker sub-agent).
---

# Create a template

You propose; the user confirms in the app. Never write anything yourself.

## 1. Interview (one question at a time)
- What should the agent do, and when should another agent pick it? (becomes `description`)
- `family`: `worker` (a sub-agent others call) or `orchestrator` (the main chat agent that delegates).
- Which tools does it really need? Start from the least: `Read`, `Grep`, `Glob`. Add `Bash`, `Write`, `Edit` or `mcp__*` only if the task needs them, and say why.
- Does it need values per project (`params`)? Each is `{key, type: text|dir|file|url, title, description, required}`.

## 2. Draft
- `slug`: lower-case letters, digits, single hyphens, at most 40; not a system name (`con`, `nul`, `com1` ...). It must not exist yet: check `profiles_list`.
- `name` (at most 80), `description` (at most 1000), `instructions` (at most 20000, imperative and short).
- Every `{{key}}` in the instructions must be a declared param or one of the reserved `project_name`, `project_directory`. Never name a param with a reserved key.
- **Always list `tools` explicitly.** A template without `tools` is refused. Never add `mcpServers`, and never put `mcp__profiles__*` in `tools`.
- Do not put secrets or personal data in the instructions.

## 3. Check, then propose
1. Build the changeset: `{"upsert": {"templates": [ {...} ]}}`.
2. Call `profiles_preview` and show the user the result in plain words (what is created, which tools are sensitive: `Bash`, `Write`, `Edit`, `mcp__*`, skills). Fix any problem and preview again.
3. When the user agrees, call `profiles_propose` with the same changeset.
4. Tell the user in your reply: a proposal is waiting, confirm it under Settings -> Agent Profiles -> Pending (the Settings entry shows a badge). Sensitive tools need their own tick there. The agent file appears only after the user also runs Generate for it.

One template per proposal unless the user asks for a small set (5 items at most).
