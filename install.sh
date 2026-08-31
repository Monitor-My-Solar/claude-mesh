#!/usr/bin/env bash
# claude-mesh installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Monitor-My-Solar/claude-mesh/main/install.sh | bash -s -- \
#     --registry https://mesh.example.com --token <shared-token>
#
# Installs to ~/.claude-mesh/app, links a launcher onto PATH, writes config,
# installs the Claude Code hooks and skill, then starts the relay service.
set -euo pipefail

REPO="${MESH_REPO:-https://github.com/Monitor-My-Solar/claude-mesh.git}"
BRANCH="${MESH_BRANCH:-main}"
APP="$HOME/.claude-mesh/app"
BINDIR="${MESH_BINDIR:-$HOME/.local/bin}"

REGISTRY=""; TOKEN=""; GROUP=""; RELAY_ID=""; NO_SERVICE=0; MODE=""

# Interactive prompts need a real terminal. Piping the script through bash
# leaves stdin as the pipe, so read from /dev/tty when one exists.
TTY=""
if [ -e /dev/tty ] && [ -r /dev/tty ]; then TTY=/dev/tty; fi

ask() {  # ask <prompt> <default> -> echoes the answer
  local prompt="$1" default="${2:-}" reply=""
  if [ -z "$TTY" ]; then echo "$default"; return; fi
  if [ -n "$default" ]; then printf '  %s [%s]: ' "$prompt" "$default" > "$TTY"
  else printf '  %s: ' "$prompt" > "$TTY"; fi
  read -r reply < "$TTY" || true
  echo "${reply:-$default}"
}

die()  { printf '\nerror: %s\n' "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --registry|--ip) REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --token)         TOKEN="${2:?--token needs a value}";       shift 2 ;;
    --group)         GROUP="${2:?--group needs a value}";       shift 2 ;;
    --relay-id)      RELAY_ID="${2:?--relay-id needs a value}"; shift 2 ;;
    --no-service)    NO_SERVICE=1; shift ;;
    --server)        MODE="server"; shift ;;
    --client)        MODE="client"; shift ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1'" ;;
  esac
done

printf '\nclaude-mesh installer\n\n'

command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node 18+ is required (https://nodejs.org)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 18+ is required (found $(node --version))"
info "node $(node --version)"

# --- fetch ------------------------------------------------------------------
if [ -d "$APP/.git" ]; then
  info "updating $APP"
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" reset --quiet --hard "origin/$BRANCH"
else
  info "cloning into $APP"
  rm -rf "$APP"
  mkdir -p "$(dirname "$APP")"
  if ! git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP" 2>/dev/null; then
    cat >&2 <<'HINT'

  Could not clone the repository anonymously.

  If it is private, authenticate first (any one of these):
    gh auth login                       # GitHub CLI
    ssh-add ~/.ssh/id_ed25519           # then: MESH_REPO=git@github.com:OWNER/REPO.git
    git config --global credential.helper store

  Then re-run this installer.
HINT
    exit 1
  fi
fi
info "version $(git -C "$APP" rev-parse --short HEAD)"

# --- launcher ---------------------------------------------------------------
mkdir -p "$BINDIR"
cat > "$BINDIR/claude-mesh" <<LAUNCHER
#!/usr/bin/env bash
exec "$(command -v node)" "$APP/bin/claude-mesh" "\$@"
LAUNCHER
chmod +x "$BINDIR/claude-mesh"
info "launcher $BINDIR/claude-mesh"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) printf '\n  NOTE: %s is not on your PATH. Add it:\n    export PATH="%s:$PATH"\n' "$BINDIR" "$BINDIR" ;;
esac

# --- interactive setup ------------------------------------------------------
# Ask only for what was not supplied on the command line, and only if there is
# a terminal to ask on: an unattended install must never block.
if [ -n "$TTY" ] && [ -z "$REGISTRY" ] && [ ! -f "$HOME/.claude-mesh/config.json" ]; then
  printf '\n  This machine can either RUN the registry (one per network) or\n'
  printf '  CONNECT to an existing one.\n\n'
  if [ -z "$MODE" ]; then
    case "$(ask 'Run the registry here? (y/N)' 'N')" in
      [Yy]*) MODE="server" ;;
      *)     MODE="client" ;;
    esac
  fi

  if [ "$MODE" = "server" ]; then
    PORT="$(ask 'Port to listen on' '8787')"
    TOKEN="$(ask 'Shared token (blank to generate one)' '')"
    if [ -z "$TOKEN" ]; then
      TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
      printf '\n  Generated token - every machine on this mesh needs it:\n\n    %s\n\n' "$TOKEN"
      printf '  Save it now; it is not shown again.\n'
      [ -n "$TTY" ] && { printf '  Press enter to continue. ' > "$TTY"; read -r _ < "$TTY" || true; }
    fi
    REGISTRY="http://127.0.0.1:$PORT"
    RUN_SERVER=1
  else
    REGISTRY="$(ask 'Registry URL (e.g. https://mesh.example.com)' '')"
    [ -n "$REGISTRY" ] || die "a registry URL is required"
    TOKEN="$(ask 'Shared token' '')"
    [ -n "$TOKEN" ] || die "the shared token is required"
  fi
  GROUP="${GROUP:-$(ask 'Name for this machine' "$(hostname -s 2>/dev/null || hostname)")}"
  RELAY_ID="${RELAY_ID:-$GROUP}"
fi

# --- configure --------------------------------------------------------------
CFG_ARGS=()
[ -n "$REGISTRY" ] && CFG_ARGS+=(--ip "$REGISTRY")
[ -n "$TOKEN" ]    && CFG_ARGS+=(--token "$TOKEN")
[ -n "$GROUP" ]    && CFG_ARGS+=(--group "$GROUP")
[ -n "$RELAY_ID" ] && CFG_ARGS+=(--relay-id "$RELAY_ID")

if [ ${#CFG_ARGS[@]} -gt 0 ]; then
  "$BINDIR/claude-mesh" configure "${CFG_ARGS[@]}" >/dev/null
  info "configured"
elif [ -f "$HOME/.claude-mesh/config.json" ]; then
  "$BINDIR/claude-mesh" upgrade >/dev/null
  info "kept existing config; hooks and skill refreshed"
else
  printf '\n  No registry configured yet. Finish with:\n    claude-mesh configure --ip https://<registry-host> --token <token>\n\n'
  exit 0
fi

# --- service ----------------------------------------------------------------
if [ "$NO_SERVICE" -eq 1 ]; then
  info "skipping service (--no-service)"
else
  if "$BINDIR/claude-mesh" service >/dev/null 2>&1; then
    info "relay service installed and started"
  else
    info "relay service could not be started; run: claude-mesh service"
  fi
fi

printf '\n  ------------------------------------------------------------\n'
"$BINDIR/claude-mesh" status || true
printf '  ------------------------------------------------------------\n'

if [ "${RUN_SERVER:-0}" = "1" ]; then
  cat <<EOF

  You chose to run the registry here. Start it with:

    claude-mesh serve --port ${PORT:-8787} --bind 0.0.0.0

  Keep it running (systemd, docker, tmux) and point other machines at it.
  Other machines join with:

    curl -fsSL https://raw.githubusercontent.com/Monitor-My-Solar/claude-mesh/main/install.sh | bash

EOF
else
  cat <<'EOF'

  Next:
    /rename <job>          name a session for what it does (inside Claude Code)
    claude-mesh peers      see who is online across the mesh
    claude-mesh ask --to <group>/<name> --body "..."   ask another agent
    claude-mesh update     pull the latest version

EOF
fi
