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

REGISTRY=""; TOKEN=""; GROUP=""; RELAY_ID=""; NO_SERVICE=0

die()  { printf '\nerror: %s\n' "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --registry|--ip) REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --token)         TOKEN="${2:?--token needs a value}";       shift 2 ;;
    --group)         GROUP="${2:?--group needs a value}";       shift 2 ;;
    --relay-id)      RELAY_ID="${2:?--relay-id needs a value}"; shift 2 ;;
    --no-service)    NO_SERVICE=1; shift ;;
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

printf '\n'
"$BINDIR/claude-mesh" status || true
printf '\nDone. Name a session for its job with /rename, then: claude-mesh peers\n\n'
