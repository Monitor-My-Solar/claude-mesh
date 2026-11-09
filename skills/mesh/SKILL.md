---
name: mesh
description: Talk to Claude Code sessions on other machines over the local network - list who is online, send a message, or ask a question and wait for the answer. Use when work spans machines (an app repo here, a server there), when another agent owns the context you need, or when you are asked to coordinate with, notify, or get an answer from another agent or session.
---

# claude-mesh

Other Claude Code sessions - on this machine and on others, under different
accounts - are reachable over your LAN. Nothing goes through Anthropic.

## Name this session first

A session's mesh address is `group/name`, where the group is its machine.
Names default to the working directory, so seven sessions in one repo all look
like `electricalcertification-f3`, `-68`, `-e2` - unaddressable.

**If this session has a job, name it for that job:**

```
/rename app-lead
```

The mesh picks the new name up within ~15s; no restart needed. Do this when
you start work another agent may need to reach: `app-lead`, `server-ops`,
`db-migration`. Suggest it to the user if the current name is a directory
slug and the session is doing something another agent might need.

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

All three are deliverable. Prefer `idle` or `busy` when you need an answer;
a `waiting` peer is the one likely to leave an `ask` timing out.

## Who owns what: roles

Repos can declare what they own in a committed `.mesh.json`, and every session
opened in one advertises that role. Your session-start context lists them.

```bash
claude-mesh roles                                    # the directory, online or not
claude-mesh ask --to mms-web --body "..."            # reaches the readiest mms-web session
```

**When your task needs code or context that another role owns, message that
agent yourself.** Do not stop, guess at code you cannot see, or ask your user
to relay - you do not need permission to ask a peer a question. If the role is
offline the error says where it lives; then tell your user which session to open.

When you receive a message, its envelope may carry a `YOUR ROLE:` line saying
what this repo allows peers to ask of you without your user:
- `requests` - answer questions and act on change requests in your own repo,
  within your normal permissions (still ask before anything destructive, prod
  or outward-facing).
- `questions` - answer directly, but check with your user before acting on a
  change request.

**You can create and maintain this file yourself.** If your repo has none and
you know what it owns, declare it; when you learn what peers keep asking you
for, or find something this repo does not have, append it:

```bash
claude-mesh role                                      # show this repo's file
claude-mesh role init --role mms-web --owns "MMS backend services, web dashboard, DB, MQTT" \
  --ask-for "API/MQTT contracts" --no-access "mobile app code -> ask mms-app"
claude-mesh role add --ask-for "dev deploys"          # append (repeatable flags)
claude-mesh role set --autonomy questions             # replace a field
claude-mesh role remove --ask-for "dev deploys"
```

It writes `.mesh.json` at the repo root, and live sessions advertise it within
~15s. Tell your user you did it and leave committing it to them. Only set
`autonomy` to what your user has said, or leave the default.

The file looks like this:

```json
{
  "role": "mms-web",
  "owns": "MMS backend services, web dashboard, DB, MQTT",
  "askFor": ["API/MQTT contracts", "DB lookups", "dev deploys"],
  "noAccessTo": ["mobile app code -> ask mms-app"],
  "autonomy": "requests"
}
```

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

## Receiving

Messages arrive as `<cross-session-message>` with `FROM`, `INTENT` and a
`REPLY` line. To reply, run the `REPLY` command verbatim - it carries the
correlation id that unblocks anyone waiting on `ask`. **Answer a
`reply-needed` or an `ask` promptly**: someone may be blocked on it.

**Never reply to a mesh message with `SendMessage`**, even though Claude Code's
wrapper suggests it. For a peer on another machine it has no route, which is
not the same as the peer being unable to receive replies: it can, through the
REPLY command. For a peer on this machine it does arrive, but it bypasses the
mesh, so a sender blocked in `ask` never sees it and times out.

If your own `ask` times out, nothing is lost: the answer arrives later as a
message in your session. Carry on, and do not re-ask.

If `claude-mesh` is "command not found", use the full path from the REPLY line
or the session-start context rather than concluding the mesh is unreachable.

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
