#!/usr/bin/env bash
# Installs cockpit, or updates one installed before, on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/jonabergamo/cockpit/main/install.sh | bash
#
# or ./install.sh from a checkout. It checks for git, Node.js, pnpm and tmux and installs what's missing (Homebrew
# on a Mac), sets up Codex or Claude Code, builds cockpit, points it at your project, starts it at login and opens it.
# Run it again to update. Options:
#   --dir <folder>            where cockpit goes (default ~/cockpit, or the checkout it's run from)
#   --repo <folder>           the project you work in
#   --agent codex|claude      the coding agent cockpit hands work to
#   --port <n>                default 8770
#   --yes                     take every default without asking
#   --no-service              don't start it at login, only now
#   --no-desktop              skip the desktop app (macOS)
#   --plugins <file.tgz>      add plugins someone packed for you with `cockpit plugins pack` (found by itself in
#                             ~/Downloads or next to this script when it's called cockpit-plugins.tgz)
#   --uninstall               stop it and remove the login item and the desktop app; your files stay
# Written for the bash 3.2 a Mac ships with.
set -uo pipefail

REPO_URL="${COCKPIT_REPO_URL:-https://github.com/jonabergamo/cockpit.git}"
NODE_MIN=22
PNPM_VERSION=11.1.2

dir=""; project=""; agent=""; port=""; yes=0; service=1; desktop=""; uninstall=0; bundle=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift ;;
    --repo) project="$2"; shift ;;
    --agent) agent="$2"; shift ;;
    --port) port="$2"; shift ;;
    --yes|-y) yes=1 ;;
    --no-service) service=0 ;;
    --no-desktop) desktop=no ;;
    --uninstall) uninstall=1 ;;
    --plugins) bundle="$2"; shift ;;
    -h|--help) sed -n '2,21p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# ── looks ────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; I=$'\033[3m'
  ACC=$'\033[38;5;111m'; OK=$'\033[38;5;114m'; WARN=$'\033[38;5;179m'; BAD=$'\033[38;5;203m'; MUTE=$'\033[38;5;245m'
else
  B=""; D=""; R=""; I=""; ACC=""; OK=""; WARN=""; BAD=""; MUTE=""
fi
# back over the spinner's line; nothing when the output goes to a file
CL=""
[ -t 1 ] && CL=$'\r\033[K'
# prompts read the keyboard even when the script itself comes in on stdin (curl | bash)
TTY=/dev/tty
interactive=1
{ [ "$yes" = 1 ] || ! : >/dev/tty; } 2>/dev/null && interactive=0

LOG="$(mktemp -t cockpit-install.XXXXXX)"
step_no=0
STEPS=7

say() { printf '%s\n' "$*"; }
note() { printf '    %s%s%s\n' "$MUTE" "$*" "$R"; }
ok() { printf '%s  %s✓%s %s%s\n' "$CL" "$OK" "$R" "$1" "${2:-}"; }
warn() { printf '%s  %s!%s %s\n' "$CL" "$WARN" "$R" "$*"; }
fail() {
  printf '%s  %s✗%s %s\n' "$CL" "$BAD" "$R" "$1"
  [ -n "${2:-}" ] && printf '    %s\n' "$2"
  printf '\n    %sThe full log is in %s%s\n' "$MUTE" "$LOG" "$R"
  tail -n 12 "$LOG" 2>/dev/null | sed "s/^/    ${MUTE}│${R} /"
  printf '\n'
  exit 1
}
step() {
  step_no=$((step_no + 1))
  printf '\n%s%s%s %s%s%s\n' "$ACC" "$(printf '%s/%s' "$step_no" "$STEPS")" "$R" "$B" "$1" "$R"
}

# runs a command with a spinner, its output into the log; ok or fail after
spin() {
  local label="$1"; shift
  printf '\n$ %s\n' "$*" >>"$LOG"
  "$@" >>"$LOG" 2>&1 &
  local pid=$! i=0 frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' start=$SECONDS
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      i=$(((i + 1) % 10))
      printf '\r\033[K  %s%s%s %s %s%ss%s' "$ACC" "${frames:$i:1}" "$R" "$label" "$MUTE" "$((SECONDS - start))" "$R"
      sleep 0.1
    done
  fi
  wait "$pid"
}

ask() { # ask <question> <default> -> $REPLY
  local q="$1" def="${2:-}"
  if [ "$interactive" = 0 ]; then REPLY="$def"; return; fi
  printf '  %s?%s %s %s%s%s ' "$ACC" "$R" "$q" "$MUTE" "${def:+($def)}" "$R" >"$TTY"
  IFS= read -r REPLY <"$TTY" || REPLY=""
  [ -z "$REPLY" ] && REPLY="$def"
  return 0
}

confirm() { # confirm <question> <y|n>
  local def="${2:-y}" hint="Y/n"
  [ "$def" = n ] && hint="y/N"
  if [ "$interactive" = 0 ]; then [ "$def" = y ]; return; fi
  printf '  %s?%s %s %s%s%s ' "$ACC" "$R" "$1" "$MUTE" "$hint" "$R" >"$TTY"
  local a; IFS= read -r a <"$TTY" || a=""
  [ -z "$a" ] && a="$def"
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

choose() { # choose <question> <option>... -> $CHOICE (0-based), arrows and enter
  local q="$1"; shift
  local n=$# sel=0 i key rest
  CHOICE=0
  [ "$interactive" = 0 ] && return
  printf '  %s?%s %s %s(↑/↓, enter)%s\n' "$ACC" "$R" "$q" "$MUTE" "$R" >"$TTY"
  printf '\033[?25l' >"$TTY"
  while :; do
    i=0
    for opt in "$@"; do
      if [ $i = $sel ]; then printf '\r\033[K    %s❯ %s%s\n' "$ACC" "$opt" "$R" >"$TTY"
      else printf '\r\033[K      %s%s%s\n' "$MUTE" "$opt" "$R" >"$TTY"; fi
      i=$((i + 1))
    done
    IFS= read -rsn1 key <"$TTY"
    if [ "$key" = $'\033' ]; then
      IFS= read -rsn2 rest <"$TTY"
      case "$rest" in '[A') sel=$(((sel + n - 1) % n)) ;; '[B') sel=$(((sel + 1) % n)) ;; esac
    elif [ -z "$key" ]; then break
    else case "$key" in k) sel=$(((sel + n - 1) % n)) ;; j) sel=$(((sel + 1) % n)) ;; [1-9]) [ "$key" -le "$n" ] && sel=$((key - 1)) ;; esac
    fi
    printf '\033[%sA' "$n" >"$TTY"
  done
  printf '\033[?25h' >"$TTY"
  # leave only the answer on screen
  printf '\033[%sA' "$((n + 1))" >"$TTY"
  i=0; for opt in "$@"; do [ $i = $sel ] && picked="$opt"; i=$((i + 1)); done
  printf '\r\033[K  %s?%s %s %s%s%s\n' "$ACC" "$R" "$q" "$ACC" "$picked" "$R" >"$TTY"
  for _ in $(seq "$n"); do printf '\033[K\n' >"$TTY"; done
  printf '\033[%sA' "$n" >"$TTY"
  CHOICE=$sel
}
trap '{ printf "\033[?25h" >/dev/tty; } 2>/dev/null' EXIT

has() { command -v "$1" >/dev/null 2>&1; }
os="$(uname -s)"
mac=0; [ "$os" = Darwin ] && mac=1

# a box of lines: style then text, padded to one width (bash counts characters, so ◆ and → line up)
box() {
  local color="$1" w=0 l t; shift
  for l in "$@"; do t="${l#*|}"; [ ${#t} -gt $w ] && w=${#t}; done
  printf '  %s╭%s╮%s\n' "$color" "$(printf '─%.0s' $(seq $((w + 4))))" "$R"
  for l in "$@"; do
    t="${l#*|}"
    printf '  %s│%s  %s%s%s%*s  %s│%s\n' "$color" "$R" "${l%%|*}" "$t" "$R" $((w - ${#t})) "" "$color" "$R"
  done
  printf '  %s╰%s╯%s\n' "$color" "$(printf '─%.0s' $(seq $((w + 4))))" "$R"
}
banner() {
  printf '\n'
  box "$ACC" "$B|◆ cockpit" "$MUTE|Your coding agents, terminals and worktrees" "$MUTE|in one tab, on your own machine."
}

# ── uninstall ────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$uninstall" = 1 ]; then
  banner
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
  [ -z "$dir" ] && { [ -f "$here/bin/cockpit" ] && dir="$here" || dir="$HOME/cockpit"; }
  say ""
  if [ -f "$dir/bin/cockpit" ] && has node; then
    for r in all hub node; do node "$dir/bin/cockpit" service uninstall --role "$r" >>"$LOG" 2>&1; done
    ok "Stopped cockpit and removed it from your login items"
  fi
  if [ "$mac" = 1 ] && [ -d "$HOME/Applications/cockpit.app" ]; then
    osascript -e 'quit app "cockpit"' >/dev/null 2>&1
    rm -rf "$HOME/Applications/cockpit.app" && ok "Removed ~/Applications/cockpit.app"
  fi
  [ -f "$HOME/.local/share/applications/cockpit.desktop" ] && rm -f "$HOME/.local/share/applications/cockpit.desktop" && ok "Removed the desktop entry"
  say ""
  note "Your cockpit folder ($dir) and its data are still there. Delete the folder to remove everything."
  say ""
  exit 0
fi

banner
say ""
note "Sets up cockpit on this $( [ "$mac" = 1 ] && echo Mac || echo machine ). Nothing leaves your computer; cockpit only"
note "listens on 127.0.0.1. It takes 2 to 5 minutes."

# ── 1. this machine ──────────────────────────────────────────────────────────────────────────────────────────────
step "Checking this machine"
case "$os" in
  Darwin) ok "macOS $(sw_vers -productVersion 2>/dev/null) on $( [ "$(uname -m)" = arm64 ] && echo "Apple silicon" || echo Intel)" ;;
  Linux) ok "Linux $(uname -r | cut -d- -f1) on $(uname -m)" ;;
  *) fail "cockpit runs on macOS and Linux, not $os." ;;
esac

if [ "$mac" = 1 ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "Apple's command line tools are missing. git and the build need them."
    xcode-select --install >/dev/null 2>&1
    note "A window opened to install them. Click Install and wait for it to finish."
    printf '    %swaiting%s' "$MUTE" "$R"
    until xcode-select -p >/dev/null 2>&1; do printf '.'; sleep 5; done
    printf '\n'
  fi
  ok "Apple command line tools"
  for b in /opt/homebrew/bin /usr/local/bin; do [ -x "$b/brew" ] && PATH="$b:$PATH"; done
  if ! has brew; then
    warn "Homebrew isn't installed. It's how this installs git, Node.js and tmux."
    confirm "Install Homebrew now? It asks for your Mac password." y || fail "cockpit needs Homebrew here." "Install it from https://brew.sh and run this again."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty || fail "Homebrew didn't install."
    for b in /opt/homebrew/bin /usr/local/bin; do [ -x "$b/brew" ] && PATH="$b:$PATH"; done
  fi
  ok "Homebrew $(brew --version 2>/dev/null | head -1 | awk '{print $2}')"
fi
export PATH

pkg() { # pkg <brew name> <apt name>
  if [ "$mac" = 1 ]; then spin "Installing $1" env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install "$1"
  elif has apt-get; then spin "Installing $2" sudo -n apt-get install -y "$2" || { note "Installing $2 needs your password:"; sudo apt-get install -y "$2" </dev/tty >>"$LOG" 2>&1; }
  elif has dnf; then spin "Installing $2" sudo dnf install -y "$2"
  else return 1
  fi
}

# ── 2. tools ─────────────────────────────────────────────────────────────────────────────────────────────────────
step "Tools cockpit needs"
has git || pkg git git || fail "Couldn't install git."
ok "git $(git --version | awk '{print $3}')"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! has node || [ "$(node_major)" -lt "$NODE_MIN" ]; then
  if [ "$mac" = 1 ]; then
    pkg node@22 || fail "Couldn't install Node.js."
    PATH="$(brew --prefix node@22)/bin:$PATH"
  else
    # fnm, without touching the shell profile; cockpit's service remembers where node is
    export FNM_DIR="$HOME/.local/share/fnm"
    spin "Installing Node.js 22" bash -c 'curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell --install-dir "$FNM_DIR" && "$FNM_DIR/fnm" install 22' || fail "Couldn't install Node.js."
    PATH="$(dirname "$("$FNM_DIR/fnm" exec --using=22 which node)"):$PATH"
  fi
fi
ok "Node.js $(node -v)"

if ! has pnpm; then
  spin "Installing pnpm" npm install -g "pnpm@$PNPM_VERSION" || spin "Installing pnpm" bash -c "curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=$PNPM_VERSION SHELL=/bin/bash sh -" || fail "Couldn't install pnpm."
  [ -d "$HOME/.local/share/pnpm" ] && PATH="$HOME/.local/share/pnpm:$PATH"
  [ -d "$HOME/Library/pnpm" ] && PATH="$HOME/Library/pnpm:$PATH"
  has pnpm || fail "pnpm installed but isn't on the PATH."
fi
ok "pnpm $(pnpm -v 2>/dev/null)"

has tmux || pkg tmux tmux || warn "tmux didn't install; terminals won't survive a restart."
has tmux && ok "tmux $(tmux -V | awk '{print $2}')" "  ${MUTE}keeps terminals alive across restarts${R}"

# ── 3. coding agent ──────────────────────────────────────────────────────────────────────────────────────────────
step "Your coding agent"
if [ -z "$agent" ]; then
  if has codex && ! has claude; then def=0; elif has claude && ! has codex; then def=1; else def=0; fi
  if [ "$interactive" = 1 ]; then
    if [ $def = 0 ]; then choose "Which coding agent should cockpit hand work to?" "Codex (OpenAI)" "Claude Code (Anthropic)"
    else choose "Which coding agent should cockpit hand work to?" "Claude Code (Anthropic)" "Codex (OpenAI)"; CHOICE=$((1 - CHOICE)); fi
  else CHOICE=$def; fi
  [ "$CHOICE" = 0 ] && agent=codex || agent=claude
fi
case "$agent" in codex|claude) ;; *) fail "--agent is codex or claude" ;; esac

if [ "$agent" = codex ]; then
  if ! has codex; then
    spin "Installing Codex" npm install -g @openai/codex
    has codex || fail "Codex didn't install." "Install it with: npm install -g @openai/codex"
  fi
  ok "Codex $(codex --version 2>/dev/null | awk '{print $NF}')"
  if codex login status >/dev/null 2>&1; then
    ok "Signed in to Codex"
  elif [ "$interactive" = 1 ] && confirm "Sign in to Codex now? A browser window opens (ChatGPT or an API key)." y; then
    # Ctrl-C here gives up on the sign-in, not on the install
    trap 'printf "\n"' INT
    codex login </dev/tty >/dev/tty 2>&1 || true
    trap - INT
    codex login status >/dev/null 2>&1 && ok "Signed in to Codex" || warn "Not signed in yet. Settings → Setup in cockpit can do it later."
  elif [ "$interactive" = 1 ]; then
    warn "Not signed in yet. Settings → Setup in cockpit can do it later."
  else
    warn "Codex isn't signed in. Run 'codex login', or use Settings → Setup in cockpit."
  fi
else
  if ! has claude; then
    spin "Installing Claude Code" bash -c 'curl -fsSL https://claude.ai/install.sh | bash' || spin "Installing Claude Code" npm install -g @anthropic-ai/claude-code
    PATH="$HOME/.local/bin:$PATH"
    has claude || fail "Claude Code didn't install." "See https://docs.anthropic.com/en/docs/claude-code"
  fi
  ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
  note "If you haven't signed in yet, run 'claude' once in a terminal, or use Settings → Setup in cockpit."
fi

# ── 4. cockpit itself ────────────────────────────────────────────────────────────────────────────────────────────
step "Getting cockpit"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [ -z "$dir" ]; then
  if [ -f "$here/bin/cockpit" ] && [ -f "$here/pnpm-workspace.yaml" ]; then dir="$here"
  else ask "Where should cockpit live?" "~/cockpit"; dir="$REPLY"; fi
fi
case "$dir" in "~"*) dir="$HOME${dir#\~}" ;; esac
if [ -d "$dir/.git" ]; then
  if [ "$dir" != "$here" ] || [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    spin "Updating" git -C "$dir" pull --ff-only && ok "Updated $dir to $(git -C "$dir" rev-parse --short HEAD)" || warn "Couldn't update $dir (local changes?), building it as it is."
  else
    ok "Using this checkout, $dir"
  fi
elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  fail "$dir already exists and isn't cockpit." "Pick another folder with --dir."
else
  spin "Downloading cockpit" git clone --depth 1 "$REPO_URL" "$dir" || fail "Couldn't download cockpit from $REPO_URL."
  ok "Downloaded to $dir"
fi
cd "$dir" || fail "Can't open $dir."

spin "Installing packages" pnpm install --frozen-lockfile || spin "Installing packages" pnpm install || fail "pnpm install failed."
ok "Packages installed"
spin "Building" pnpm -r build || fail "The build failed."
ok "Built"

# plugins a teammate packed: named with --plugins, or a cockpit-plugins.tgz lying where downloads land
if [ -z "$bundle" ]; then
  for f in "$here/cockpit-plugins.tgz" "$HOME/Downloads/cockpit-plugins.tgz" "$OLDPWD/cockpit-plugins.tgz"; do
    [ -f "$f" ] && { bundle="$f"; break; }
  done
  [ -n "$bundle" ] && ! confirm "Add the plugins in ${bundle/#$HOME/~}?" y && bundle=""
fi
if [ -n "$bundle" ]; then
  case "$bundle" in "~"*) bundle="$HOME${bundle#\~}" ;; esac
  [ -f "$bundle" ] || fail "There's no $bundle."
  added="$(tar -tzf "$bundle" 2>/dev/null | sed -n 's#^\([^/]*\)/plugin.json$#\1#p' | tr '\n' ' ')"
  set -- $added
  spin "Adding plugins" node bin/cockpit plugins add "$bundle" --replace && ok "Added $# plugins" "  ${MUTE}they start off; turn them on in Settings → Plugins${R}" || warn "Couldn't add the plugins in $bundle."
  [ $# -gt 0 ] && note "${added% }"
fi

# ── 5. your project ──────────────────────────────────────────────────────────────────────────────────────────────
step "Your project"
cfg="$dir/config.local.toml"
if [ -f "$cfg" ]; then
  ok "Keeping your settings in config.local.toml"
  [ -z "$port" ] && port="$(sed -n 's/^port *= *\([0-9]*\).*/\1/p' "$cfg" | head -1)"
else
  # a guess: the git repo you were in, else the most recently changed one in the usual places
  guess=""
  if [ -n "$project" ]; then guess="$project"
  elif git -C "$OLDPWD" rev-parse --show-toplevel >/dev/null 2>&1 && [ "$(git -C "$OLDPWD" rev-parse --show-toplevel)" != "$dir" ]; then guess="$(git -C "$OLDPWD" rev-parse --show-toplevel)"
  else
    for d in $(ls -dt "$HOME"/{projects,code,dev,src,Developer,repos,work,Documents}/*/.git 2>/dev/null | head -1); do guess="$(dirname "$d")"; done
  fi
  guess="${guess/#\/private$HOME/~}"; guess="${guess/#$HOME/~}"
  while :; do
    ask "Which project do you work in? (a git repo, empty to set it later)" "$guess"
    project="$REPLY"
    [ -z "$project" ] && break
    full="$project"; case "$full" in "~"*) full="$HOME${full#\~}" ;; esac
    if git -C "$full" rev-parse --show-toplevel >/dev/null 2>&1; then full="$(git -C "$full" rev-parse --show-toplevel)"; break; fi
    warn "$project isn't a git repo."
    [ "$interactive" = 0 ] && { project=""; break; }
  done
  [ -z "$port" ] && port=8770
  # a new cockpit takes the first free port; something already on 8770 could be anything
  while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do port=$((port + 1)); done
  base="main"
  if [ -n "$project" ]; then
    base="$(git -C "$full" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    [ -z "$base" ] && base="$(git -C "$full" branch --show-current 2>/dev/null)"
    [ -z "$base" ] && base=main
  fi
  tilde() { printf '%s' "${1/#$HOME/~}"; }
  {
    say "# Made by install.sh. config.example.toml explains every setting."
    say ""
    say "port = $port"
    say "host = \"127.0.0.1\""
    [ -n "$project" ] && say "extraRoots = [\"$(tilde "$(dirname "$full")")\"]"
    say ""
    say "[repo]"
    say "path = \"$( [ -n "$project" ] && tilde "$full")\""
    say "name = \"$( [ -n "$project" ] && basename "$full")\""
    say "worktreesDir = \"~/.cockpit/worktrees\""
    say "baseBranch = \"$base\""
    say "branchTemplate = \"feat/{key}/{slug}\""
    say "createCommand = \"git -C {repo} worktree add -b {branch} {worktreesDir}/{key}/{name} origin/{base}\""
    say "deleteCommand = \"git -C {repo} worktree remove {path}\""
    say "openCommand = \"code {path}\""
  } >"$cfg"
  if [ -n "$project" ]; then ok "Project: $(tilde "$full") ${MUTE}(new work branches off $base)${R}"
  else ok "No project yet ${MUTE}(set repo.path in config.local.toml later)${R}"; fi
fi
[ -z "$port" ] && port=8770
URL="http://127.0.0.1:$port"

# ── 6. start it ──────────────────────────────────────────────────────────────────────────────────────────────────
step "Starting cockpit"
started=0
if [ "$service" = 1 ] && { [ "$interactive" = 0 ] || confirm "Start cockpit now and every time you log in?" y; }; then
  spin "Starting" node bin/cockpit service install && started=1
  [ "$started" = 1 ] && ok "Runs in the background, and at every login" || warn "Couldn't set it up to start at login."
fi
if [ "$started" = 0 ]; then
  mkdir -p data
  (cd server && nohup node_modules/.bin/tsx src/index.ts >>../data/server.log 2>&1 &)
fi
for _ in $(seq 60); do curl -fs --max-time 2 "$URL/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs --max-time 2 "$URL/api/health" >/dev/null 2>&1 || fail "cockpit didn't start." "Its log is $dir/data/server.log"
ok "Running on $URL"

# the main agent is a setting in the app, so it goes in through the API
if [ "$agent" = codex ]; then
  node -e '
    const url = process.argv[1];
    (async () => {
      const { settings } = await (await fetch(url + "/api/settings")).json();
      const r = await fetch(url + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: { ...settings.tasks, defaultAgent: "codex" } }) });
      process.exit(r.ok ? 0 : 1);
    })().catch(() => process.exit(1));
  ' "$URL" >>"$LOG" 2>&1 && ok "Codex is the main agent" || warn "Couldn't make Codex the main agent; pick it in Settings → Board and automation."
  # cockpit's tools (an MCP server, so Codex can see the Board and run work) and its skills, the way Setup adds them
  if ! codex mcp get cockpit >/dev/null 2>&1; then
    codex mcp add cockpit --env "COCKPIT_URL=$URL" -- "$dir/server/node_modules/.bin/tsx" "$dir/server/mcp/cockpit-mcp.ts" >>"$LOG" 2>&1 && ok "Gave Codex cockpit's tools" || warn "Couldn't add cockpit's tools to Codex; Settings → Setup can."
  fi
  for s in "$dir"/skills/*/; do
    s="$(basename "$s")"
    curl -fs -X POST "$URL/api/setup/core/skills/$s" >>"$LOG" 2>&1 || true
  done
  ok "Gave Codex cockpit's skills" "  ${MUTE}in ${CODEX_HOME:-~/.codex}/skills${R}"
fi

# ── 7. desktop app ───────────────────────────────────────────────────────────────────────────────────────────────
step "Desktop app"
if [ "$mac" = 1 ] && [ "$desktop" != no ] && confirm "Add cockpit to Applications, with a menu bar count? (downloads ~100 MB)" y; then
  spin "Building the app" bash desktop/install.sh "$URL" && ok "Installed ~/Applications/cockpit.app" || warn "The desktop app didn't build; cockpit still works in the browser."
  opened=1
else
  ok "Skipped ${MUTE}(the browser works just as well)${R}"
fi

# ── done ─────────────────────────────────────────────────────────────────────────────────────────────────────────
[ "${opened:-0}" = 0 ] && { if [ "$mac" = 1 ]; then open "$URL" >/dev/null 2>&1; elif has xdg-open; then xdg-open "$URL" >/dev/null 2>&1 & fi; }
short="${dir/#$HOME/~}"
who="$( [ "$agent" = codex ] && echo Codex || echo Claude)"
printf '\n'
box "$OK" \
  "$B|cockpit is ready at $URL" \
  "|" \
  "$B|First, in the app" \
  "|  1. Settings → Setup shows anything still missing" \
  "|  2. Settings → Plugins turns on GitHub, Jira and yours" \
  "|  3. Work → New task hands a job to $who" \
  "|" \
  "$MUTE|Update   bash $short/install.sh" \
  "$MUTE|Remove   bash $short/install.sh --uninstall" \
  "$MUTE|Status   node $short/bin/cockpit service status" \
  "$MUTE|Log      $short/data/server.log"
printf '\n'
rm -f "$LOG"
