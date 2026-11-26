---
name: remotecli-create-memory
description: Draft a new memory block and propose it for the user to confirm. Use when the user wants shared notes or rules that agents read (and sometimes write).
---

# Create a memory block

You propose; the user confirms in the app. Never write anything yourself.

## 1. Interview (one question at a time)
- What is it for, and who reads it? (becomes `description`)
- Scope: `global` (every chat) or `project` (a separate text per folder).
- `read-only` (only the user writes it) or `writable` (agents may replace or append). Prefer `read-only` for rules, `writable` for running notes.
- How much text? `maxChars` is 1 to 20000 (default 2000).

## 2. Draft
- `name`: lower-case letters, digits, single hyphens, at most 40. Block names are unique across **all** scopes: check `profiles_list` first, and if the name exists with the other scope kind it cannot be changed (pick another name).
- `description` (at most 500), `mode`, `scope: {"kind": "global"}` or `{"kind": "project"}`, `maxChars`.
- A **global** block may carry `content` (the text, within `maxChars`). Never store secrets, tokens or personal data.
- A **project** block is a definition only: do **not** add `contents` or any folder or `scope.directory`. Tell the user that agents see a project block only in folders that have text, and that they add folders in the Memory tab.

## 3. Check, then propose
1. Changeset: `{"upsert": {"memoryBlocks": [ {...} ]}}`.
2. `profiles_preview`, show the result in plain words, fix problems, preview again.
3. When the user agrees, `profiles_propose` with the same changeset.
4. Tell the user in your reply: a proposal is waiting, confirm it under Settings -> Agent Profiles -> Pending (the Settings entry shows a badge).

One small proposal at a time (5 items at most).
