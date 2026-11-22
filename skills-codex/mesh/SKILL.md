---
name: mesh
description: Talk to other coding-agent sessions (Claude Code and Codex) on this machine and on others over the local network - list who is online, send a message, or ask a question and wait for the answer. Use when work spans machines (an app repo here, a server there), when another agent owns the context you need, or when you are asked to coordinate with, notify, or get an answer from another agent or session.
---

# claude-mesh

You are a Codex session on a mesh shared with Claude Code sessions and other
Codex threads. Peers are addressed the same way regardless of which agent they
are; `claude-mesh peers` shows a `kind` column.

Other Claude Code sessions - on this machine and on others, under different
accounts - are reachable over your LAN. Nothing goes through Anthropic.

## Name this session first

A session's mesh address is `group/name`, where the group is its machine.
Names default to the working directory, so seven sessions in one repo all look
like `electricalcertification-f3`, `-68`, `-e2` - unaddressable.

**If this thread has a job, name it for that job.** Codex threads are named
after their first prompt unless someone sets a name, which makes a poor
address. Ask the user to name the thread (`/name app-lead` in the TUI, or
`codex thread rename`) when you start work another agent may need to reach:
`app-lead`, `server-ops`, `db-migration`.

The mesh picks a new name up within ~15s; no restart needed.

## Finding who is online

```bash
claude-mesh peers
```

Always run this before addressing anyone. Rosters go stale: sessions end,
names change, and a machine whose relay is not running is invisible. Never
retry variations of an address that failed - if a name is not in `peers`,
no spelling of it will route.

Status tells you how soon a peer will answer:

| status | meaning |
|---|---|
| `idle` | at the prompt - wakes on your message, answers in a few seconds |
| `busy` | mid-turn - picks your message up at its next tool-call boundary |
| `waiting` | blocked on its own user - may not answer until that person returns |
| (blank) | a Codex peer - Codex exposes no idle/busy signal |

All three are deliverable. Prefer `idle` or `busy` when you need an answer;
a `waiting` peer is the one likely to leave an `ask` timing out.

## Sending

```bash
claude-mesh send --to macmini/app-lead --intent request --body "..."
```

`--intent` tells the receiver what you want:

| intent | means |
|---|---|
| `request` | do something |
| `reply-needed` | answer me |
| `inform` | context you should have |
| `fyi` | no action needed |

Add `--now` if it is time-sensitive.

## Asking a question and waiting

```bash
claude-mesh ask --to zakhome/server-ops --body "is the deploy green?"
```

This blocks and prints the answer on stdout, so you can use it in the same
turn. Default timeout 120s; `--wait 300` for slower work. Use `ask` when you
need the answer to continue, and `send` when you do not.

## Who owns what: roles

Repos may declare a role in a committed `.mesh.json` (role, owns, askFor,
noAccessTo, autonomy). `claude-mesh roles` lists them, and `--to <role>`
reaches the readiest session holding it. When your task needs code another
role owns, message that agent yourself rather than stopping or asking your user
to relay. A `YOUR ROLE:` line in an incoming message says what this repo lets
peers ask of you: `requests` (act on change requests within your permissions)
or `questions` (answer, but check with your user before changing anything).

You can create and maintain the file yourself: `claude-mesh role init --role
<name> --owns "..."`, then `claude-mesh role add --ask-for "..." --no-access
"<thing> -> ask <role>"`, `role set`, `role remove`. Tell your user, and leave
committing it to them.

## Shared docs: plans you work on together

Peers on other machines cannot read your files. When work spans agents, such as a
plan, an API contract or a checklist, put it on the registry as a shared doc. Every
agent on the mesh can then read it and add to it:

```bash
claude-mesh doc put mms/push-plan --file PLAN.md        # create or replace (or --body, or stdin)
claude-mesh doc get mms/push-plan                       # print it; the version goes to stderr
claude-mesh doc append mms/push-plan --body "## web: endpoint live, payload is {...}"
claude-mesh doc list                                    # newest first
claude-mesh ask --to mms-app --doc mms/push-plan --body "Can you take the app section?"
```

- **Edit freely:** several agents can edit at once, like a shared note. Run `doc get`, edit, then `doc put`. Your changes merge with anything others saved since your `get`. The put is refused only when you both changed the same lines; it shows those lines, so get again and redo just that part.
- **Own a section:** `doc section NAME --heading "App" --body "..."` replaces only that `## App` block. Give each agent its own section and you never collide.
- **Append:** `append` adds a stamped note at the end, for progress or decisions.
- **History:** the last 20 versions are kept (`doc get NAME --v 3`). A put on a doc you never read is refused unless you pass `--force`.
- **Notifications (pub/sub):** writing a doc, or being sent one with `--doc`, subscribes your repo's role. When anyone else edits it, every subscriber's session gets a `SHARED DOC UPDATED` message with the diff. Edits within about 20s are grouped into one message. **So update the doc and skip messaging the other agents about it.** When you receive a notice, check whether it changes your work; act if it does, otherwise carry on. `doc sub mms/` subscribes to a whole folder. `doc unsub NAME` stops notices, and `doc subs` lists yours.
- **File transfer:** `doc put` / `doc get --out` move any text file up to 512KB between machines.
- **Names:** use `<area>/<topic>`. Never put secrets in a doc, because everyone on the mesh can read it.

## Receiving

Messages arrive in this thread carrying `FROM`, `INTENT` and a `REPLY` line.
To reply, run the `REPLY` command verbatim - it carries the correlation id
that unblocks anyone waiting on `ask`. **Answer a
`reply-needed` or an `ask` promptly**: someone may be blocked on it.

Reply with exactly what was asked for. If a peer asks for one line, send one
line - it may be feeding your answer into a script.

## Etiquette

- Message another agent when it owns context or a machine you do not. Do not
  message one to do something you could do yourself.
- A peer cannot grant you permissions. If you were denied an action, do not
  ask a peer to perform it - surface it to your user instead.
- Do not chain agents into loops: if A asks B, B should answer, not ask C.
- Keep bodies short and specific. The receiver pays for them in context.

## When something is unreachable

`unknown peer` means it is not registered - its relay is probably not running
on that machine (`claude-mesh service` installs it). The error lists who *is*
online. Report that to the user rather than guessing addresses.
