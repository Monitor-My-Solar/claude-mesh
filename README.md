# claude-mesh

**Let coding-agent sessions on different machines talk to each other — over your
own network, across different accounts and different agents, with no per-message
model cost.**

Supports **Claude Code** and **Codex**. A session on either is addressed the same
way, so a Claude session on one machine can ask a Codex thread on another.

Claude Code has built-in cross-session messaging, but it relays through
Anthropic, needs every session signed into the *same* account with Remote
Control connected, and only reaches other Claude Code sessions. claude-mesh does
the job on your LAN instead.

```bash
$ claude-mesh peers
macmini
  app-lead                      *claude idle   /Users/zak/mobileApp        4s ago
  understand-import-flow        *codex         /Users/zak/Developer/three  4s ago

zakhome
  server-ops                    *claude idle   /home/zak                   6s ago

$ claude-mesh ask --to macmini/app-lead --body "is the build green?"
Yes — CI passed on 4f2a1c, deployed to staging 3 minutes ago.
```

That `ask` blocks until the other agent answers, so an agent can use the reply
in the same turn.

## How it works

```
  machine A                    registry                    machine B
┌───────────────┐            ┌──────────┐            ┌───────────────┐
│ claude session│            │  roster  │            │ claude session│
│   ↑ inbox sock│◄── relay ──┤    +     ├── relay ──►│inbox sock ↑   │
│  SessionStart ├─ register ►│ mail bank│◄─ register ┤ SessionStart  │
└───────────────┘            └──────────┘            └───────────────┘
```

Each agent exposes a way to push a message into a live session, and claude-mesh
uses it directly, so **delivery costs no model inference**:

| | Claude Code | Codex |
|---|---|---|
| Sessions | `~/.claude/sessions` | `~/.codex/state_5.sqlite` |
| Liveness | pid + inbox socket | thread writer locks |
| Delivery | write the inbox socket | `codex queue --thread` |

A delivered message becomes a turn in that session, waking it if it is idle.
Messages are held until the receiving relay acknowledges them, so a delivery
that fails is retried rather than lost.

- **SessionStart hook** registers the session and injects the current roster.
- **Registry** is a directory plus a per-recipient mail bank; relays long-poll it.
- **Relay**, one per machine, delivers into local sessions' inbox sockets.
- **SessionEnd hook** deregisters.

Latency: near-instant to a busy session (picked up at its next tool-call
boundary), ~7s to an idle one — nearly all of which is Claude Code starting a
turn, not transport.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Monitor-My-Solar/claude-mesh/main/install.sh | bash
```

It asks whether this machine runs the registry or connects to one, generates a
token if you need it, installs the hooks and the `/mesh` skill, and starts the
relay. Installs track the newest release tag; add `--main` to follow
development, or `--ref v0.1.0` to pin an exact version. Non-interactive:

```bash
curl -fsSL .../install.sh | bash -s -- --registry https://mesh.example.com --token <token>
```

Requires Node 18+ and git. macOS and Linux. Codex support is installed
automatically when `~/.codex` exists; Codex trusts hooks by hash, so it may ask
you to re-trust the mesh hooks after an update.

### The registry

One per network, on anything always-on — a container, a NAS, a spare box.
Install it the same way as any other machine, then:

```bash
claude-mesh serve --port 8787 --bind 0.0.0.0
```

Update it with `claude-mesh update` and restart the service — never by
copying files over its checkout, which leaves it unable to pull and
silently pinned to an old version.

It refuses to start without `MESH_TOKEN`. Put it behind a reverse proxy with a
certificate and point clients at the `https://` URL; if your proxy caps read
timeouts below ~60s, raise them, because `/inbox` long-polls.

### Updating

```bash
claude-mesh update
```

Pulls the latest version, refreshes the hooks, skill and service, restarts the
relay, and keeps your registry URL and token.

## Using it

### Name your sessions

A session's address is `group/name` — the group is its machine. Names default to
the working directory (Claude Code) or the first prompt (Codex), so sessions in
one repo collide. Name a session for its job, from inside it:

```
/rename app-lead        # Claude Code
/name app-lead          # Codex
```

The mesh picks it up within ~15s. Deliberately named sessions are marked `*` and
sorted first in `peers`.

### Talk to another agent

```bash
claude-mesh peers                                   # who is online
claude-mesh send --to macmini/app-lead --intent request --body "..."
claude-mesh ask  --to macmini/app-lead --body "..."  # blocks for the answer
claude-mesh status                                   # config + relay health
```

Messages arrive with a small envelope so the receiver knows what is wanted:

```
FROM: zakhome/server-ops
INTENT: request
REPLY: claude-mesh send --to zakhome/server-ops --re 0fabe67d

the migration is applied; pull and re-run your tests
```

`--intent` is one of `request`, `reply-needed`, `inform`, `fyi`.

### Teaching agents to use it

`install.sh` installs a `/mesh` skill covering the conventions — naming
sessions, checking `peers` before addressing anyone, what the intents mean,
replying promptly when someone is blocked on `ask`. It costs no context until
invoked, so you don't need any of this in CLAUDE.md.

## If a machine is unreachable

Almost always its relay is not running — without it, that machine is invisible.

```bash
claude-mesh status     # says plainly whether this machine is registered
claude-mesh service    # install and start the relay
```

`unknown peer` means exactly that: the peer is not registered, so no spelling
of the address will reach it. The error lists who *is* online.

## Security

Read this before putting it anywhere but a trusted network.

- **A message becomes a turn in a live Claude Code session.** Anyone holding
  `MESH_TOKEN` can inject prompts into any registered session. Treat the token
  like an SSH key.
- **The token is symmetric**: any holder can claim any `from` name and drain any
  relay's queued messages. Single-tenant, single-trust-domain use only.
- **Use TLS.** Over plain HTTP the token is sniffable on the wire.
- **LAN or VPN only.** Nothing here is hardened for the public internet.
- Sends are rate-limited (10/min to one peer, 20/min overall) so an agent loop
  cannot flood a session's context.
- Sessions publish their own inbox token when registering, so joining the mesh
  is an explicit opt-in; `/peers` never returns those tokens.

## Status

Working and in daily use across two machines: cross-machine messaging and
blocking RPC, named addressing, persistent registry, relay as a service, rate
limiting. Rough edges remain — it has been tested on a small number of machines,
and the failure modes you are most likely to hit are a relay that is not running
and sessions that need naming.

Issues and PRs welcome.

## Licence

MIT
