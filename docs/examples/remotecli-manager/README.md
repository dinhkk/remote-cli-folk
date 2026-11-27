# remotecli-manager (example)

An example agent that helps you create, edit and delete **agent templates** and **memory blocks** from a chat. It never
changes anything itself: it **proposes**, and you confirm in the app (Settings → Agent Profiles → Pending).

A new install already contains this template and copies the six skills to `~/.claude/skills/` once (a template you delete
is not brought back). On such a host skip steps 1 and 2 below and start at step 3. The files here are the same content for
reading, editing or importing on a host that was set up before. Hosts are independent; repeat the steps per host.

## Files

| File | What |
| --- | --- |
| `remotecli-manager.bundle.json` | One template (`orchestrator`) with explicit tools, including the four `profiles` tools, and the six skills |
| `skills/remotecli-templates-guide/SKILL.md` | How templates work: Generate, fields, tools, params, what an edit changes |
| `skills/remotecli-memory-guide/SKILL.md` | How memory blocks work: scopes, per-folder text, block tools, limits |
| `skills/remotecli-proposal-flow/SKILL.md` | How the profiles tools, guardrails and the Pending confirmation work |
| `skills/remotecli-create-template/SKILL.md` | Interview, draft, preview, propose for a template |
| `skills/remotecli-create-memory/SKILL.md` | Same for a memory block |
| `skills/remotecli-edit-or-delete/SKILL.md` | Edit or delete something that exists |

## Setup on a host

1. **Import the template.** Settings → Agent Profiles → *Import*, choose `remotecli-manager.bundle.json`. It is a
   *sensitive* template (it lists `mcp__*` tools and skills), so tick it in the preview before *Apply*. See
   [agent-bundle-format.md](../../agent-bundle-format.md).
2. **Copy the skills** to the Host user's skills folder: copy the six folders under `skills/` to `~/.claude/skills/`.
3. **Generate the agent globally.** Agents tab → *Generate agents* → target **Global** (`~/.claude/agents`) → tick
   *RemoteCLI manager*. It must be the **user-level** file: a project-level agent with the same name does not get the tools.
4. **Switch it on.** In the Agents tab turn on *Profile manager* for `remotecli-manager`.
5. **Chat with it.** Start a new chat on the Host with `remotecli-manager` as the main agent. Ask for one template or
   one block. It shows you a preview, proposes, and tells you a proposal is waiting.
6. **Confirm.** Settings → Agent Profiles → Pending (the Settings entry shows a badge). Read the diff, tick what needs a
   tick (overwrites, deletes, sensitive tools), *Confirm*. The result is listed per item, with the snapshot taken first.

## Good to know

- The `profiles` tools exist only in a chat started on the Host itself. A Controller (phone) tab, a scheduled
  message, and an agent that is not switched on as a profile manager have no such tools. A message you type in the Host browser while the agent is busy is queued and keeps the tools.
- Proposals wait 24 hours, at most 10 at a time, at most 5 items each.
- The manager refuses what the app refuses: templates without a `tools` list, `mcpServers`, folder text for project
  blocks (you add folders in the Memory tab), read-only blocks, its own template.
- Everything is private to your host: skills and bundle contain no project or customer names; add your own rules to the
  template's instructions if you want them.
