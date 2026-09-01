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
# Track releases by default. MESH_CHANNEL=main follows the development branch;
# MESH_REF=v0.1.0 pins an exact tag.
CHANNEL="${MESH_CHANNEL:-stable}"
REF="${MESH_REF:-}"
APP="$HOME/.claude-mesh/app"
BINDIR="${MESH_BINDIR:-$HOME/.local/bin}"

REGISTRY=""; TOKEN=""; GROUP=""; RELAY_ID=""; NO_SERVICE=0; MODE=""; JOIN=""

# Interactive prompts need a real terminal. Piping the script through bash
# leaves stdin as the pipe, so read from /dev/tty when one exists.
TTY=""
if [ -e /dev/tty ] && [ -r /dev/tty ]; then TTY=/dev/tty; fi

ask() {  # ask <prompt> <default> [secret] -> echoes the answer
  local prompt="$1" default="${2:-}" secret="${3:-}" reply=""
  if [ -z "$TTY" ]; then echo "$default"; return; fi
  if [ -n "$default" ]; then printf '  %s %s[%s]%s: ' "$prompt" "$DIM" "$default" "$R" > "$TTY"
  else printf '  %s: ' "$prompt" > "$TTY"; fi
  if [ -n "$secret" ]; then
    read -rs reply < "$TTY" || true          # a shared secret should not be echoed
    printf '\n' > "$TTY"
  else
    read -r reply < "$TTY" || true
  fi
  echo "${reply:-$default}"
}

if [ -t 1 ] && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RED=$(printf '\033[31m')
  CYN=$(printf '\033[36m')
else
  B=""; DIM=""; R=""; GRN=""; YEL=""; RED=""; CYN=""
fi

die()  { printf '\n  %s%s%s\n' "$RED" "$1" "$R" >&2; exit 1; }
info() { printf '  %s✓%s %s\n' "$GRN" "$R" "$1"; }
step() { printf '  %s→%s %s\n' "$CYN" "$R" "$1"; }
rule() { printf '  %s────────────────────────────────────────────────────────%s\n' "$DIM" "$R"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --registry|--ip) REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --token)         TOKEN="${2:?--token needs a value}";       shift 2 ;;
    --join)          JOIN="${2:?--join needs a value}";         shift 2 ;;
    --group)         GROUP="${2:?--group needs a value}";       shift 2 ;;
    --relay-id)      RELAY_ID="${2:?--relay-id needs a value}"; shift 2 ;;
    --no-service)    NO_SERVICE=1; shift ;;
    --ref)           REF="${2:?--ref needs a value}"; shift 2 ;;
    --main)          CHANNEL="main"; shift ;;
    --ref)           REF="${2:?--ref needs a value}"; shift 2 ;;
    --main)          CHANNEL="main"; shift ;;
    --server)        MODE="server"; shift ;;
    --client)        MODE="client"; shift ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1'" ;;
  esac
done

printf '\n  %sclaude-mesh%s %sinter-agent messaging for Claude Code%s\n\n' "$B" "$R" "$DIM" "$R" 

command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node 18+ is required (https://nodejs.org)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 18+ is required (found $(node --version))"
info "node $(node --version)"

# --- fetch ------------------------------------------------------------------
# Resolve what to check out: an explicit ref, the newest release tag, or main.
resolve_ref() {
  if [ -n "$REF" ]; then echo "$REF"; return; fi
  if [ "$CHANNEL" = "main" ]; then echo "origin/main"; return; fi
  tag="$(git -C "$1" tag -l 'v*' --sort=-v:refname 2>/dev/null | head -1)"
  if [ -n "$tag" ]; then echo "$tag"; else echo "origin/main"; fi
}

if [ -d "$APP/.git" ]; then
  step "updating $APP"
  git -C "$APP" fetch --quiet --tags --force origin main
  git -C "$APP" reset --quiet --hard "$(resolve_ref "$APP")"
else
  step "cloning into $APP"
  rm -rf "$APP"
  mkdir -p "$(dirname "$APP")"
  if ! git clone --quiet "$REPO" "$APP" 2>/dev/null; then
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
  git -C "$APP" fetch --quiet --tags origin 2>/dev/null || true
  git -C "$APP" checkout --quiet "$(resolve_ref "$APP")" 2>/dev/null || true
fi
info "version $(git -C "$APP" describe --tags --always 2>/dev/null || git -C "$APP" rev-parse --short HEAD)"

# --- launcher ---------------------------------------------------------------
mkdir -p "$BINDIR"
cat > "$BINDIR/claude-mesh" <<LAUNCHER
#!/usr/bin/env bash
exec "$(command -v node)" "$APP/bin/claude-mesh" "\$@"
LAUNCHER
chmod +x "$BINDIR/claude-mesh"
info "launcher $BINDIR/claude-mesh"

# Persist BINDIR on PATH. A note is not enough: agents run in non-interactive
# shells they did not configure, so a CLI that is only findable after a manual
# export is a CLI they cannot use at all.
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *)
    added=""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -e "$rc" ] || continue
      grep -qF "$BINDIR" "$rc" 2>/dev/null && { added="$rc"; continue; }
      printf '\n# added by claude-mesh\nexport PATH="%s:$PATH"\n' "$BINDIR" >> "$rc"
      added="$rc"
    done
    if [ -z "$added" ]; then
      printf '\n# added by claude-mesh\nexport PATH="%s:$PATH"\n' "$BINDIR" >> "$HOME/.profile"
      added="$HOME/.profile"
    fi
    info "added $BINDIR to PATH in $added"
    printf '  %s(open a new shell, or: export PATH="%s:$PATH")%s\n' "$DIM" "$BINDIR" "$R"
    ;;
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

  if [ "$MODE" = "client" ] && [ -z "$JOIN" ] && [ -z "$TOKEN" ]; then
    printf '\n  On a machine that is already on the mesh, run %sclaude-mesh invite%s\n' "$B" "$R"
    printf '  to get a short-lived join code, or paste the shared token.\n\n'
  fi

  if [ "$MODE" = "server" ]; then
    PORT="$(ask 'Port to listen on' '8787')"
    TOKEN="$(ask 'Shared token (blank to generate one)' '' secret)"
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
    JOIN="$(ask 'Join code (blank to paste the token instead)' '')"
    if [ -z "$JOIN" ]; then
      TOKEN="$(ask 'Shared token' '' secret)"
      [ -n "$TOKEN" ] || die "a join code or the shared token is required"
    fi
  fi
  GROUP="${GROUP:-$(ask 'Name for this machine' "$(hostname -s 2>/dev/null || hostname)")}"
  RELAY_ID="${RELAY_ID:-$GROUP}"
fi

# --- configure --------------------------------------------------------------
# A join code is redeemed into the real token first, so the rest of this block
# only ever deals with a token.
if [ -n "$JOIN" ] && [ -z "$TOKEN" ]; then
  [ -n "$REGISTRY" ] || die "--join needs --registry"
  step "redeeming join code"
  TOKEN="$(node -e '
    const [url, code] = process.argv.slice(1);
    fetch(url.replace(/\/+$/, "") + "/join/redeem", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.token) { console.error(b.error || r.status); process.exit(1); }
      console.log(b.token);
    }).catch((e) => { console.error(e.message); process.exit(1); });
  ' "$REGISTRY" "$JOIN")" || die "could not redeem the join code (expired or already used?)"
  info "join code accepted"
fi

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
  printf '\n  Not configured yet. Finish with:\n    claude-mesh configure --ip https://<registry-host> --token <token>\n\n'
  exit 0
fi

# --- service ----------------------------------------------------------------
if [ "$NO_SERVICE" -eq 1 ]; then
  info "skipping service (--no-service)"
else
  if "$BINDIR/claude-mesh" service >/dev/null 2>&1; then
    info "relay service installed and started"
    # The relay registers on its first cycle; without this the status block
    # below races it and reports a healthy install as broken.
    printf '  %s→%s waiting for the relay to register' "$CYN" "$R"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1; printf '.'
      "$BINDIR/claude-mesh" status 2>/dev/null | grep -q '^relay    running' && break
    done
    printf '\n'
  else
    printf '  %s!%s relay service could not be started; run: claude-mesh service\n' "$YEL" "$R"
  fi
fi

printf '\n'
rule
"$BINDIR/claude-mesh" status 2>&1 | sed 's/^/  /' || true
rule

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
