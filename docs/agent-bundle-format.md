# Agent bundle format

A **bundle** is one text file (YAML or JSON) that holds agent **templates** and **memory blocks**. You export one from a
host, edit it by hand, or ask an AI to write one, and import it on another host (or the same one). Two hosts stay fully
independent: there is no sync; each host imports and recreates its own copy.

This page is for people and for AIs that write bundles. Everything an importer checks is listed here.

- [Quick start](#quick-start)
- [Format](#format) · [Templates](#template-fields) · [Memory blocks](#memory-block-fields)
- [Minimal examples](#minimal-examples)
- [What an import does](#what-an-import-does)
- [Prompt for an AI](#prompt-for-an-ai)
- [Errors and warnings the importer reports](#errors-and-warnings-the-importer-reports)
- [Safety](#safety)

## Quick start

1. **Export**: Settings → Agent Profiles → *Export*. Pick templates and blocks, choose YAML (default) or JSON. Block text
   (including the text of every folder of a project block, with its folder path) is left out unless you tick *include
   block text*.
2. **Edit** the file in any editor if you like. YAML is easier by hand: a multi-line prompt is a readable `|` block.
3. **Import**: *Import*, choose the file or paste the text. You see a **preview** first (nothing is written), tick what
   you want, then *Apply*.

A bundle written by hand, or by another AI, is a normal input: it is treated as **untrusted** by design (see
[Safety](#safety)).

## Format

YAML and JSON are both accepted (JSON is valid YAML). The importer reads YAML with the *core* schema: `true`/`false`,
numbers and `null` are typed, everything else is text. **Quote text that looks like a number** (`name: "123"`).
Anchors and aliases (`&a`, `*a`) are refused, a duplicate key is an error, and a bundle may not nest deeper than 8 levels.

Top level:

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Always `remotecli.agent-bundle` |
| `version` | yes | Always `1`. Another version is refused as a whole |
| `exportedAt` | no | Text, informational |
| `templates` | no | List of [templates](#template-fields) (default: none) |
| `memoryBlocks` | no | List of [memory blocks](#memory-block-fields) (default: none) |

No ids, revisions or timestamps travel in a bundle; if a file has them (`id`, `rev`, `updatedAt`, `createdAt`) they are
ignored. Any other unknown field is reported as a **warning** and ignored; the item still imports.

### Template fields

| Field | Required | Type / rule |
| --- | --- | --- |
| `slug` | yes | 1-40 characters: lower-case letters and digits separated by single hyphens. Not a reserved system name (`con`, `nul`, `com1` ...). Unique in the bundle. **This is the key**: an existing template with the same slug is a conflict |
| `family` | yes | `orchestrator` (the main chat agent) or `worker` (a sub-agent) |
| `name` | yes | Text, at most 80 characters |
| `description` | no | When the orchestrator should pick this agent. At most 1000 characters |
| `instructions` | yes | The prompt, at most 20000 characters. Every `{{key}}` must be a declared parameter or `project_name` / `project_directory` |
| `params` | no | List (at most 30) of `{key, type, title, description, required, default}`. `key` starts with a letter, then letters, digits or `_` (at most 40, unique, not `project_name` / `project_directory`). `type`: `text` (default), `dir`, `file`, `url`. `required`: true/false (default false) |
| `bindings` | no | `{project: true/false, knowledge: true/false}` (defaults `true`, `false`) |
| `tools` | no | List of tool names the agent may use. **Leave it out and the agent inherits every tool** |
| `disallowedTools` | no | List of tool names the agent may not use |
| `mcpServers` | no | List of MCP server names |
| `skills` | no | List of skill names |
| `model` | no | Model name or alias |
| `memory` | no | `project`, `user` or `local` (Claude Code agent memory) |
| `usesBlocks` | no | `true` to let the agent work with memory blocks |
| `group` | no | Heading in the new-chat dropdown, at most 40 characters |

Lists (`tools`, `disallowedTools`, `mcpServers`, `skills`) hold at most 100 non-empty strings of at most 200 characters.

A template is **sensitive** (it needs its own tick when importing) when it has any of: `mcpServers`; no `tools` list
(or an empty one); a tool `Bash`, `Bash(...)`, `Write`, `Edit` or `NotebookEdit`; a tool starting with `mcp__`; or any
`skills`.

### Memory block fields

| Field | Required | Type / rule |
| --- | --- | --- |
| `name` | yes | 1-40 characters, lower-case letters and digits separated by single hyphens. **This is the key.** Names are unique across all scopes |
| `description` | no | At most 500 characters |
| `mode` | yes | `read-only` (only the user writes it) or `writable` (agents may replace or append) |
| `scope` | yes | `{kind: global}` or `{kind: project}`. Never put a folder here (`scope.directory` is ignored, with a warning) |
| `maxChars` | no | Whole number from 1 to 20000 (default 2000): the most text one block can hold |
| `content` | no | **Global block only.** The text. Leave it out to keep whatever text the target already has |
| `contents` | no | **Project block only.** List of `{directory, content, lastWriter}`: the text of the block in each folder it has text for (at most 200 per block, 500 per bundle) |
| `lastWriter` | no | Who wrote the text: `user` or `agent:<name>`. Text an agent wrote stays marked as agent text; anything else becomes `user` |

A **global** block applies to every chat. A **project** block is one definition with a separate text per folder: an agent
sees it only in a folder that has text for it, so a block imported without text is invisible until you add folders in
the *Memory* tab.

`directory` in a `contents` entry is the folder the text belonged to **on the source host** and is used only as a
*matching key*. It must be an absolute path (`/work/alpha`, `C:\work\alpha`). It is never used as a place to write:
on import you choose a **sidebar project** for each source folder, and that project's own folder is the target.

## Minimal examples

A worker template:

```yaml
format: remotecli.agent-bundle
version: 1
templates:
  - slug: alpha-reviewer
    family: worker
    name: Alpha reviewer
    description: Reviews a change before it is merged.
    tools: [Read, Grep, Glob]
    instructions: |
      Review the change in {{project_name}}.
      List problems first, then suggestions.
```

A global block with text, and a project block with text for one folder:

```yaml
format: remotecli.agent-bundle
version: 1
memoryBlocks:
  - name: house-style
    description: How we write.
    mode: read-only
    scope: {kind: global}
    maxChars: 2000
    content: |
      Keep sentences short.
      Prefer plain words.
  - name: beta-notes
    description: Running notes of this project.
    mode: writable
    scope: {kind: project}
    contents:
      - directory: /work/beta
        content: |
          Decisions so far:
          - use the shared logger
```

The same bundle as JSON works too: `{"format": "remotecli.agent-bundle", "version": 1, "templates": [...], "memoryBlocks": [...]}`.

## What an import does

**Preview first.** Pasting or choosing a file never writes anything. Every item (and every folder entry of a project
block) gets a status:

| Status | Meaning |
| --- | --- |
| `new` | Does not exist on this host; it will be created |
| `identical` | Exists and is the same; nothing to do |
| `conflict` | Exists and differs. It is **skipped** unless you tick *overwrite* for that item |
| `invalid` | Cannot be imported; the reason and the path in the file are shown |
| `skipped` | A folder entry with no target project (you did not map it) |

**Ticks.**

- Duplicates are skipped unless ticked. Each overwrite is its own tick.
- A *sensitive* template (see above) needs its own tick even when it is new. *Select all sensitive* ticks them at once;
  nothing is ticked by default.
- Items are independent: one failing never stops the others, and the result lists each one. A project block whose
  folder entry failed still keeps its definition (the item is shown as *partial*).

**Stale protection.** The preview tells which version of each item you saw. An overwrite is applied only if the item is
still that version; if an agent or another edit changed it since, that item fails with `STALE` and nothing is lost:
preview again.

**Blocks.**

- A bundle without text never wipes stored text: overwriting a global block without `content` changes only
  description, mode and `maxChars`; a project block's definition update never touches its folder text.
- A folder entry overwrites that folder's text only when its own key is ticked. An import never removes a folder's text.
- The scope of a block never changes. A name that exists with the other scope kind is a conflict that **cannot** be
  overwritten (delete or rename the existing block first).

**Snapshots and restore.** Before anything is overwritten the server writes a snapshot of all templates and blocks
(including all folder text) to `<agent-profiles folder>/backups/` (the file name is shown in the result). If a stored
file is unreadable, nothing is overwritten (a backup would be incomplete) until you repair or delete it. A snapshot is removed only
when it is both older than 14 days and not among the newest 50.
*Restore* (Settings → Agent Profiles → *Restore*) picks a snapshot by name on the server: overwritten items go back,
deleted ones are re-created, folder text returns to the folder it was stored for, and items created since are kept.
Restore takes its own snapshot first. A block that now has the other scope kind, or that an older version has not yet
moved to per-folder text, is skipped with its reason.

**Limits.** An import request is at most 5 MB of text. A bundle has at most 500 folder entries in total and a block at
most 200. A host holds at most 50 memory blocks.

## Prompt for an AI

Paste this to an AI, add what you want after the last line, and import what it writes (preview shows everything before
anything is written).

````text
Write one YAML file in the "remotecli.agent-bundle" format, version 1, and output only the YAML.

Top level keys: format (exactly "remotecli.agent-bundle"), version (exactly 1), templates (list), memoryBlocks (list).
No other top-level keys. Do not use YAML anchors or aliases and do not repeat a key. Quote any text that looks like a
number or a boolean. Use "|" block scalars for multi-line text.

Template fields: slug (lower-case letters, digits and single hyphens, at most 40, unique), family ("worker" or
"orchestrator"), name (at most 80), description (when to use it, at most 1000), instructions (the prompt, at most
20000; every {{key}} placeholder must be declared in params, except project_name and project_directory), params
(optional list of {key, type: text|dir|file|url, title, description, required}), tools (a list of the least tools the
agent needs, for example [Read, Grep, Glob]; never leave it out and avoid Bash, Write, Edit and mcp__ tools unless the
task needs them), optional model, optional group.

Memory block fields: name (same slug rule, unique), description (at most 500), mode ("read-only" or "writable"),
scope ({kind: global} or {kind: project}; never put a folder in scope), maxChars (1-20000, default 2000), and for a
global block optionally content (the text). For a project block do not write content: leave contents out (the user
adds folder text later) unless asked to supply text for a specific absolute folder, then use
contents: [{directory: <absolute path>, content: <text>}].

Use only neutral example names. Do not invent paths, secrets or credentials. The user will review everything in a
preview before importing.

What I want in the bundle:
````

## Errors and warnings the importer reports

The whole file is refused (nothing is read from it) when it is not valid YAML/JSON, when `format` or `version` is wrong,
when a list is not a list, when it nests too deep, uses anchors/aliases, repeats a key, or has more than 500 folder
entries. The message gives the **line, column and path** (for example `templates[2].tools`) and says what to change.

| Code | Where | Meaning and fix |
| --- | --- | --- |
| `BUNDLE_INVALID` | whole file | Not valid text or a wrong envelope: fix the line named in the message |
| `BUNDLE_VERSION_UNSUPPORTED` | whole file | `version` is not 1 |
| `INVALID_PROFILE_INPUT` | item | A field has the wrong type or is out of range; the path names it |
| `INVALID_ITEM` | item | The entry is not a mapping of fields |
| `DUPLICATE_KEY` | item or folder | The same slug / name / source folder appears twice in the file: keep one |
| `unknown-field` | warning | A field the importer does not know; ignored, the item still imports |
| `ignored-field` | warning | Allowed but ignored: `scope.directory`, `content` on a project block, `contents` on a global block |
| `INVALID_DIRECTORY` | folder entry | `directory` must be an absolute path without NUL, at most 4096 characters |
| `BLOCK_LIMIT_REACHED` | block | The host already has 50 blocks |
| `BLOCK_CONTENT_LIMIT_REACHED` | folder entry or block | A block holds text for at most 200 folders |
| `BLOCK_TOO_LARGE` | folder entry | The text is longer than the block's `maxChars` |
| `BLOCK_SCOPE_IMMUTABLE` | conflict | The name exists with the other scope kind; delete or rename it first |
| `BLOCK_NAME_AMBIGUOUS` | conflict | Two blocks on the host share that name; rename one |
| `BLOCK_NOT_MIGRATED` | conflict / folder | The block was saved by an older version and has not been moved to per-folder text; resolve it in the Memory tab first |
| `BLOCK_CONTENT_CORRUPT` | conflict / folder | A folder text file of that block is unreadable (it cannot be backed up); repair or remove it |
| `DUPLICATE_TARGET_FOLDER` | folder entry | Two source folders were mapped to the same project folder |
| `no-target-folder` | folder entry | No project was chosen for this source folder; the block's definition still imports |
| `CONFLICT` | result | Exists and differs; tick *overwrite* to replace it |
| `SENSITIVE_NOT_ACCEPTED` | result | A sensitive template needs its own tick |
| `BASIS_REQUIRED` / `STALE` | result | Preview again: the overwrite must match the version you previewed |
| `SNAPSHOT_UNAVAILABLE` | whole apply | A backup could not be written (or a stored file is unreadable): nothing was changed |

## Safety

- **The file is untrusted input.** The preview shows everything; each overwrite and each sensitive template needs a
  tick; folder paths in the file are only matching keys and the destination is always a project you pick.
- Prompts, block text and folder paths in an exported file may be private. Treat the file like the data it holds.
- Block text that an agent wrote is untrusted content (it keeps its `agent:<name>` label through export and import).
- Import and Restore are **Host-only** actions. A paired controller (the phone) cannot reach them. That denial stops
  accidents and prompt injection; it is not a security boundary against a hostile controller, because a paired
  controller is a full-trust grant of the Host (see `server/modules/remote/policy/route-rules.ts`).
