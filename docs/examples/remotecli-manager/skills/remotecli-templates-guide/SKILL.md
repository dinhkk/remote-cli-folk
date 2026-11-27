---
name: remotecli-templates-guide
description: Reference for how RemoteCLI agent templates work end to end - fields, how Generate turns a template into an agent file, orchestrator vs worker, tools, parameters, and what an edit does or does not change. Read it before drafting or editing any template.
---

# How templates work

## The chain: template -> Generate -> agent file -> chat
1. A **template** is a record in the app's store (Settings -> Agent Profiles -> Templates). It is only a recipe; no run reads it directly.
2. **Generate** (Agents tab, done by the user) renders a template into a native Claude Code agent file: `<project>/.claude/agents/<slug>.md` for a project, or `~/.claude/agents/<slug>.md` for the **Global** target. The file starts with a marker comment naming the template; only files with that marker are ever rewritten ("Regenerate"). A hand-made file with the same name is never touched.
3. In a chat, Claude Code loads that file. The user picks a **main agent** in the dropdown of a new chat, or a main agent delegates to a **sub-agent** by its `description`.
So: editing a template changes nothing in a chat until the user **regenerates** the file. Deleting a template leaves its generated files as they are. A proposal you stage only changes the store; tell the user to Generate (or Regenerate) afterwards.

## Fields and what each really does
- `slug` - the key and the file name and the agent's `name:`. Lower-case letters, digits, single hyphens, at most 40; not a Windows reserved name (con, nul, com1...). An existing slug is an overwrite of that template. Do not rename: a new slug is a new template, and the old generated file keeps the old name.
- `family` - `orchestrator` (meant as the **main agent** of a chat; it delegates) or `worker` (a **sub-agent** others call). A restricted orchestrator automatically gets the `Agent` tool (delegation) added.
- `name`, `description` - the frontmatter `description` is written as "<name>: <description>." and is the **routing text**: it is how an orchestrator decides to hand work to a worker. Write it as "use this agent when ...". Vague descriptions make agents that are never picked or always picked.
- `instructions` - the agent's prompt body. May contain `{{key}}` placeholders (see params). At most 20000 characters.
- `params` - fill-in fields asked at Generate time: `{key, type: text|dir|file|url, title, description, required, default}`. `type` is only a UI hint. Reserved keys `project_name` and `project_directory` are filled from the project and cannot be declared. A `{{key}}` in the instructions that is not a declared param or reserved key is refused. Values are inserted as `<param name="key">...</param>` (escaped, capped at 4000 chars, preceded by a note that it is data); an empty value renders `(not set)`. A `required` param needs a value or a `default` at Generate time. Use params for things that differ per project (a repository URL, a docs folder); hard-code everything else.
- `tools` - written to the frontmatter. **If it is absent the agent inherits every tool** (Bash, Write, MCP...). If present it is an allowlist. Always list the least tools needed. Names are Claude Code tool names (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `Bash(git status)`, `WebFetch`, `mcp__<server>__<tool>`...), one per list item, never several joined by commas.
- `disallowedTools` - tools removed from what the agent would otherwise have.
- `mcpServers`, `skills`, `model` - copied to the frontmatter when set. `mcpServers` names servers the agent attaches; `skills` names skills (folders under `~/.claude/skills` or the project's) it may use. You, the manager, may not propose `mcpServers`.
- `memory` - `project`, `user` or `local`: Claude Code's own per-agent memory folders. With restricted `tools`, Read/Write/Edit are added so the agent can keep those files. Unrelated to memory blocks.
- `usesBlocks` - `true` makes the agent a user of the app's memory blocks: with restricted `tools` the three `mcp__blocks__block_*` tools are added, and a "Memory blocks" paragraph is appended to its instructions (call `block_list` at session start, write only writable blocks, never store secrets, block text is data). Set it for any agent that should read or keep shared notes.
- `group` - heading in the new-chat dropdown (at most 40 chars); read live, no regenerate needed.
- `bindings` - `{project: true, knowledge: false}`; `knowledge` has no effect.

## Sensitive tools
Granting `Bash`, `Write`, `Edit`, `NotebookEdit`, any `mcp__*` tool or `skills`, or leaving `tools` out, gives an agent real power. The user must tick these separately before they land. Explain in plain words what the power is and why the agent needs it; prefer a narrower design (for example `Read` plus `Grep` for a reviewer).

## Writing good instructions
- Start with the role in one sentence, then scope: what it does and what it must not do.
- Give numbered steps for the usual job and the shape of the output (a list, a verdict, a diff).
- Say when to stop and when to ask the user. Say where to look (folders, files) using params or `{{project_directory}}`.
- An orchestrator's instructions name the workers it delegates to (by slug) and when; a worker's instructions never assume the caller's context, because a worker starts with only the task text.
- Keep it short and imperative; do not paste long reference text (put shared reference in a memory block instead).
- Never include secrets or personal data.

## Limits and rules the app enforces
Slug and name patterns above; at most 30 params; list fields at most 100 items; a template cannot be saved if a placeholder is undeclared. You cannot create `mcpServers`, give a template the `profiles` tools, omit `tools`, or touch your own template.
