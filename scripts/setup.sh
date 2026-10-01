#!/bin/bash
# Video Studio — one-step setup for a Mac (works on a brand-new one: no Homebrew, no Xcode tools, no git).
#
#   curl -fsSL https://raw.githubusercontent.com/gamingflexer/video-studio/main/scripts/setup.sh | bash
#   …or, from a copy of the repo:  bash scripts/setup.sh
#
# What it does, and only if it is missing:
#   1. the app          -> ~/VideoStudio                  (downloaded as a tarball; skipped when run from a copy)
#   2. Node.js 22       -> ~/.video-studio/node           (official build from nodejs.org, checksum verified)
#   3. pnpm             -> ~/.video-studio/tools
#   4. ffmpeg + ffprobe -> ~/.video-studio/bin            (static build from evermeet.cx, the one ffmpeg.org links to)
#   5. app packages + production build
#   6. the video folder -> ~/Movies/Video Studio          (new-media/ videos/ "newly transferred videos and B-rolls"/ luts/)
#   7. "Video Studio.app" in ~/Applications               (Spotlight: ⌘Space, type "Video Studio")
# Nothing needs an administrator password, except Rosetta on Apple-silicon Macs that do not have it yet.
#
# Options (environment variables):
#   STUDIO_APP_DIR=/path        where the app goes                 (default ~/VideoStudio)
#   STUDIO_WORKSPACE=/path      the video folder to use            (default ~/Movies/Video Studio)
#   STUDIO_NO_APP=1             do not create the .app launcher
#   STUDIO_NO_OPEN=1            do not open the app at the end
set -euo pipefail

REPO="gamingflexer/video-studio"
BRANCH="main"
HOME_DIR="$HOME/.video-studio"
APP_DIR="${STUDIO_APP_DIR:-$HOME/VideoStudio}"
DEFAULT_WORKSPACE="$HOME/Movies/Video Studio"
ARCH="$(uname -m)"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This setup is for macOS."
mkdir -p "$HOME_DIR/bin"
export PATH="$HOME_DIR/node/bin:$HOME_DIR/tools/bin:$HOME_DIR/bin:$PATH"

# ---------------------------------------------------------------- 1. the app
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$(cd "$(dirname "$SELF")/.." 2>/dev/null && pwd)/package.json" ]; then
  APP_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
  say "Using the copy of the app in $APP_DIR"
else
  say "Downloading the app to $APP_DIR"
  mkdir -p "$APP_DIR"
  # a tarball, so a new Mac does not need git (which would pull in the multi-GB Xcode tools)
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$APP_DIR" --strip-components=1
  note "done (your projects/ and .cache/ folders, if any, were left alone)"
fi

# ---------------------------------------------------------------- 2. Node.js
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if node_ok; then
  say "Node.js $(node -v) found"
else
  say "Installing Node.js 22 into $HOME_DIR/node"
  case "$ARCH" in arm64) NARCH=arm64 ;; x86_64) NARCH=x64 ;; *) die "Unsupported processor: $ARCH" ;; esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  FILE="$(printf '%s\n' "$SUMS" | awk -v a="darwin-$NARCH.tar.gz" '$2 ~ a"$" {print $2; exit}')"
  [ -n "$FILE" ] || die "Could not find a Node.js build for darwin-$NARCH."
  TMP="$(mktemp -d)"
  curl -fL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"
  WANT="$(printf '%s\n' "$SUMS" | awk -v f="$FILE" '$2 == f {print $1}')"
  GOT="$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')"
  [ "$WANT" = "$GOT" ] || die "Node.js download failed its checksum — try again."
  rm -rf "$HOME_DIR/node"; mkdir -p "$HOME_DIR/node"
  tar -xzf "$TMP/$FILE" -C "$HOME_DIR/node" --strip-components=1
  rm -rf "$TMP" "$HOME_DIR/node/include" "$HOME_DIR/node/share" "$HOME_DIR/node"/{CHANGELOG.md,README.md}   # headers and docs are not needed
  node_ok || die "Node.js did not install correctly."
  note "Node.js $(node -v) installed"
fi

# ---------------------------------------------------------------- 3. pnpm
if command -v pnpm >/dev/null 2>&1; then
  say "pnpm $(pnpm -v) found"
else
  say "Installing pnpm into $HOME_DIR/tools"
  npm install --global --prefix "$HOME_DIR/tools" --no-fund --no-audit --loglevel=error pnpm@9
  command -v pnpm >/dev/null 2>&1 || die "pnpm did not install correctly."
  note "pnpm $(pnpm -v) installed"
fi

# ---------------------------------------------------------------- 4. ffmpeg + ffprobe
ff_ok() { command -v "$1" >/dev/null 2>&1 && "$1" -version >/dev/null 2>&1; }
# (output is captured first: with pipefail, `ffmpeg | grep -q` fails when grep stops reading early)
ff_full() {
  ff_ok ffmpeg && ff_ok ffprobe || return 1
  local filters encoders
  filters="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"; encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  case "$filters" in *" lut3d "*) ;; *) return 1 ;; esac
  case "$encoders" in *libx264*) ;; *) return 1 ;; esac
}
if ff_full; then
  say "ffmpeg found ($(command -v ffmpeg))"
else
  say "Installing ffmpeg and ffprobe into $HOME_DIR/bin"
  if [ "$ARCH" = "arm64" ] && ! /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null; then
    note "These builds are Intel programs; Apple-silicon Macs run them through Rosetta, which is not installed yet."
    note "Installing Rosetta (macOS may ask for your password)…"
    softwareupdate --install-rosetta --agree-to-license || die "Rosetta could not be installed. Install it, or install ffmpeg with Homebrew (brew install ffmpeg), then run this again."
  fi
  TMP="$(mktemp -d)"
  for tool in ffmpeg ffprobe; do
    URL="https://evermeet.cx/ffmpeg/getrelease/zip"; [ "$tool" = ffprobe ] && URL="https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
    curl -fL --progress-bar "$URL" -o "$TMP/$tool.zip"
    unzip -oq "$TMP/$tool.zip" -d "$TMP/$tool"
    mv -f "$TMP/$tool/$tool" "$HOME_DIR/bin/$tool"
    chmod +x "$HOME_DIR/bin/$tool"
  done
  rm -rf "$TMP"
  ff_full || die "ffmpeg did not install correctly. As a fallback: install Homebrew (https://brew.sh), run 'brew install ffmpeg', then run this again."
  note "$(ffmpeg -version | head -1)"
fi

# ---------------------------------------------------------------- 5. packages + build
say "Installing the app's packages"
cd "$APP_DIR"
pnpm install --frozen-lockfile --reporter=append-only 2>&1 | tail -3
say "Building the app (about a minute)"
pnpm build >"$HOME_DIR/build.log" 2>&1 || { tail -20 "$HOME_DIR/build.log"; die "The build failed — the full log is $HOME_DIR/build.log"; }
rm -rf "$APP_DIR/.next/dev" "$APP_DIR/.next/cache"   # only needed while developing
pnpm store prune >/dev/null 2>&1 || true
note "done"

# ---------------------------------------------------------------- 6. the video folder
CONFIG="$HOME_DIR/config.json"
PARENT="$(dirname "$APP_DIR")"
if [ -n "${STUDIO_WORKSPACE:-}" ]; then WS="$STUDIO_WORKSPACE"
elif [ -f "$CONFIG" ]; then WS="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workspace || ""' "$CONFIG")"
elif [ -f "$PARENT/start.md" ] && { [ -d "$PARENT/videos" ] || [ -d "$PARENT/new-media" ]; }; then WS="$PARENT"   # the app already sits inside a video workspace
else WS="$DEFAULT_WORKSPACE"; fi
[ -n "$WS" ] || WS="$DEFAULT_WORKSPACE"
say "Video folder: $WS"
mkdir -p "$WS/new-media" "$WS/videos" "$WS/newly transferred videos and B-rolls" "$WS/luts"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({workspace: process.argv[2]}, null, 2))' "$CONFIG" "$WS"
note "sub-folders: new-media/  videos/  newly transferred videos and B-rolls/  luts/"

# ---------------------------------------------------------------- 7. the app icon
if [ -z "${STUDIO_NO_APP:-}" ]; then
  say "Creating the Video Studio app"
  bash "$APP_DIR/scripts/make-app.sh" | sed 's/^/  /'
fi

say "Ready."
note "Open it:   Spotlight (⌘Space) → “Video Studio”   — or —   open \"$HOME/Applications/Video Studio.app\""
note "It runs at http://localhost:3210. Put footage in:  $WS"
note "Disk used: app $(du -sh "$APP_DIR" 2>/dev/null | cut -f1), tools $(du -sh "$HOME_DIR" 2>/dev/null | cut -f1)"
if [ -z "${STUDIO_NO_OPEN:-}" ] && [ -z "${STUDIO_NO_APP:-}" ]; then open "$HOME/Applications/Video Studio.app" || true; fi
