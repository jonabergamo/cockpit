#!/usr/bin/env bash
# Builds the cockpit app from a plain Electron download and installs it.
# On a Mac it lands in ~/Applications, on Linux in the app menu.
#   ./install.sh https://your-server.example.com:8444
set -euo pipefail

ELECTRON=44.5.1
here="$(cd "$(dirname "$0")" && pwd)"
url="${1:-}"

if [[ "$(uname)" == Darwin ]]; then
  home="$HOME/Library/Application Support/cockpit"
  platform=darwin
else
  home="${XDG_CONFIG_HOME:-$HOME/.config}/cockpit"
  platform=linux
fi
arch="$(uname -m)"; case "$arch" in arm64|aarch64) arch=arm64 ;; *) arch=x64 ;; esac

name="electron-v$ELECTRON-$platform-$arch.zip"
zip="$home/cache/$name"
mkdir -p "$home/cache"
if [[ ! -f "$zip" ]]; then
  echo "Downloading Electron $ELECTRON (about 100 MB)"
  curl -fL --progress-bar "https://github.com/electron/electron/releases/download/v$ELECTRON/$name" -o "$zip.part"
  mv "$zip.part" "$zip"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && unzip -q "$zip")

[[ -n "$url" ]] && printf '{\n  "url": "%s"\n}\n' "${url%/}" > "$home/desktop.json"

if [[ $platform == darwin ]]; then
  bundle="$work/cockpit.app"
  mv "$work/Electron.app" "$bundle"
  res="$bundle/Contents/Resources"
  rm -f "$res/default_app.asar"
  mkdir -p "$res/app"
  cp "$here/"{package.json,main.js,preload.js,micwatch.swift,icon.png,trayTemplate.png,trayTemplate@2x.png} "$res/app/"
  # tells the app which apps are using the mic, so it can offer to record a meeting; the app builds it itself
  # later if the Swift compiler isn't here yet
  if xcrun --find swiftc >/dev/null 2>&1; then
    xcrun swiftc -O "$here/micwatch.swift" -o "$home/micwatch" 2>/dev/null || true
  fi

  icons="$work/icon.iconset"
  mkdir -p "$icons"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$here/icon.png" --out "$icons/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$here/icon.png" --out "$icons/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$icons" -o "$res/electron.icns"

  plist="$bundle/Contents/Info.plist"
  pb() { /usr/libexec/PlistBuddy -c "$1" "$plist" >/dev/null 2>&1 || true; }
  pb "Set :CFBundleName cockpit"
  pb "Add :CFBundleDisplayName string cockpit"
  pb "Set :CFBundleDisplayName cockpit"
  pb "Set :CFBundleIdentifier dev.cockpit.desktop"
  pb "Set :CFBundleShortVersionString $(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$here/package.json")"
  # changed inside, so it has to be signed again for this machine
  codesign --force --deep --sign - "$bundle" >/dev/null 2>&1
  xattr -cr "$bundle"

  osascript -e 'quit app "cockpit"' >/dev/null 2>&1 || true
  # the new copy would lose the single instance lock to one still closing
  for _ in $(seq 20); do pgrep -f "cockpit.app/Contents/MacOS" >/dev/null || break; sleep 0.5; done
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/cockpit.app"
  mv "$bundle" "$HOME/Applications/"
  echo "Installed ~/Applications/cockpit.app"
  open "$HOME/Applications/cockpit.app"
else
  dest="$home/desktop"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -r "$work/." "$dest/"
  mv "$dest/electron" "$dest/cockpit"
  rm -f "$dest/resources/default_app.asar"
  mkdir -p "$dest/resources/app"
  cp "$here/"{package.json,main.js,preload.js,micwatch.swift,icon.png,trayTemplate.png,trayTemplate@2x.png} "$dest/resources/app/"
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/cockpit.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=cockpit
Comment=My work, Claude sessions and sprint in one window
Exec="$dest/cockpit"
Icon=$dest/resources/app/icon.png
Terminal=false
Categories=Development;
StartupWMClass=cockpit
DESK
  echo "Installed $dest/cockpit"
fi
