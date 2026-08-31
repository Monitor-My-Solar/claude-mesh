# claude-mesh

LAN inter-agent messaging for [Claude Code](https://claude.com/claude-code) sessions.

Claude Code ships cross-session messaging, but it relays through Anthropic and
requires every session to be signed into the **same** account with Remote Control
connected. `claude-mesh` does the same job on your own network: **account-agnostic,
cross-machine, and with no model inference per message.**

A message delivered by the mesh lands in the target session as a
`<cross-session-message>` — and if that session is idle, Claude Code starts a new
turn with it. Agents on different machines can therefore actually interrupt each
other, which is the whole point.

## How it works

```
  machine A                    registry CT                   machine B
┌──────────────┐              ┌───────────┐              ┌──────────────┐
│ claude session│             │  roster   │              │ claude session│
│   ↑ inbox sock│◄── relay ───┤ + message ├─── relay ───►│inbox sock ↑   │
│  SessionStart ├── register ►│   bank    │◄── register ─┤ SessionStart  │
└──────────────┘              └───────────┘              └──────────────┘
```

- **SessionStart hook** registers the session (name, socket, host, and its own
  inbox token) and injects the roster of who else is online.
- **Registry** is an HTTP directory plus a per-recipient message bank. Relays
  long-poll `/inbox`.
- **Relay** runs once per machine, and writes messages straight into the target
  session's Unix inbox socket. No subprocess, no model call.
- **SessionEnd hook** deregisters.

## Install

```bash
npm install -g git+https://github.com/Monitor-My-Solar/claude-mesh.git
```

### The server (once)

```bash
claude-mesh configure --gen-token --no-hooks    # prints the shared token
claude-mesh serve --port 8787
```

Or run it under systemd; see `docs/deploy.md`.

### Each machine with Claude sessions

```bash
claude-mesh configure --ip 192.168.186.209 --token <shared-token> --group homelab
claude-mesh relay &
```

`configure` writes `~/.claude-mesh/config.json` and installs the SessionStart /
SessionEnd hooks into `~/.claude/settings.json` (existing hooks are preserved, and
the file is backed up to `.mesh-backup`). New sessions register automatically.

## Use

```bash
claude-mesh peers                       # who's online
claude-mesh local                       # sessions on this machine
claude-mesh send --to app-box/12345 --intent request --body "deploy is green, pull latest"
claude-mesh status                      # resolved config + server reachability
```

Messages arrive with a small envelope so the receiving agent knows what to do:

```
FROM: server-ops
INTENT: request
REPLY: claude-mesh send --to server-ops --re 0fabe67d-450

deploy is green, pull latest
```

`INTENT` is one of `request`, `inform`, `reply-needed`, `fyi`.

## Security

Read this before exposing it anywhere.

- **The registry injects prompts into live Claude Code sessions.** Anyone holding
  `MESH_TOKEN` can send a message that becomes a turn in any registered session.
  Treat the token like an SSH key.
- **It refuses to start without a token**, and binds to loopback unless you set
  `MESH_BIND`. Override with `MESH_ALLOW_INSECURE=1` only on a trusted host.
- **The token is symmetric and spoofable**: any holder can claim any `from` name
  and can drain any relay's banked messages. Single-tenant LAN use only.
- **Plain HTTP** — the token is sniffable on the wire. Put it behind TLS before it
  ever leaves your LAN.
- Sessions publish their own inbox token, so registering is an explicit opt-in;
  `/peers` never returns those tokens.

## Requirements

Node 18+, and Claude Code on macOS or Linux (the inbox socket is a Unix domain
socket; Windows named pipes are not supported yet).

## Licence

MIT
