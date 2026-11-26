---
name: remotecli-edit-or-delete
description: Edit or delete an existing template or memory block by proposing the change for the user to confirm. Use when the user wants to change or remove something that already exists.
---

# Edit or delete

You propose; the user confirms in the app. Never write anything yourself.

## Edit
1. `profiles_list` to find it, then `profiles_get` to read the **current** version. Edit from that, never from memory.
2. Change only what the user asked for. Keep everything else as it is.
3. A template is matched by its `slug` and a block by its `name`: do not rename (a changed slug or name is a different item). A block's scope kind cannot change.
4. A template keeps an explicit `tools` list; never add `mcpServers` or the profiles tools. You cannot change your own template.
5. A `read-only` block cannot be changed by a proposal. Say so and let the user edit it in the app.
6. For a global block, a bundle without `content` keeps the current text: leave `content` out unless the text really changes.
7. Changeset: `{"upsert": {"templates": [ {full template} ]}}` (the whole item, not a patch).

## Delete
1. Changeset: `{"delete": [{"kind": "template", "key": "<slug>"}]}` or `{"kind": "block", "key": "<name>"}`.
2. State plainly what is lost: for a global block its text, for a project block its folders and their text. A snapshot is taken first and can be restored by the user, but say it anyway.
3. A template's generated agent files are plain files and stay where they are.
4. The same key cannot be in both `upsert` and `delete`.

## Then
`profiles_preview`, show the user what it would change (and the loss for a delete), fix problems, and only after the user agrees `profiles_propose`. Tell the user in your reply: a proposal is waiting, confirm it under Settings -> Agent Profiles -> Pending (the Settings entry shows a badge). Overwrites and deletes need their own tick there.

One small proposal at a time (5 items at most).
