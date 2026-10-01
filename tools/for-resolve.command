#!/bin/bash
# Turn ChartGauge recordings into files DaVinci Resolve will open.
#
# Double-click this. With no arguments it converts EVERY recording in
# ~/Downloads that does not already have a converted copy, so there is
# nothing to remember and nothing to select.
#
#   double-click, or:  bash tools/for-resolve.command
#   bash tools/for-resolve.command --watch          # convert new ones as they land
#   bash tools/for-resolve.command clip.mp4 [fps] [prores|h264] [narration.wav]
#
# Why a conversion is needed at all: the browser's MediaRecorder writes a
# fragmented container -- ftyp, an empty moov, then moof/mdat repeating --
# whose sample table holds zero entries, so the header claims about a second
# for a thirty-five second clip. It is also variable frame rate at a nominal
# 29.02fps with no audio track. Resolve will not take that. Remuxing cannot
# fix frame timing, so for-resolve.swift decodes and re-encodes onto an exact
# 1/fps grid, writing ProRes 422 in a QuickTime .mov -- which Resolve decodes
# on every build, where an H.264 mp4 imports on one machine and not the next.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_SWIFT="$HERE/for-resolve.swift"
BIN="$HERE/.for-resolve-bin"
DL="$HOME/Downloads"

[ -f "$SRC_SWIFT" ] || { echo "Missing $SRC_SWIFT"; exit 1; }

# Only one converter at a time. Two runs over the same Downloads folder write
# the same output file at once and leave a few hundred bytes of wreckage --
# which happened here, from a batch that outlived a restart meeting a new one.
LOCK="${TMPDIR:-/tmp}/chartgauge-for-resolve.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "Another conversion is already running (pid $(cat "$LOCK/pid"))."
    echo "Let it finish, or stop it, then run this again."
    exit 1
  fi
  rm -rf "$LOCK"; mkdir -p "$LOCK"      # stale lock from a killed run
fi
echo $$ > "$LOCK/pid"
cleanup() { rm -rf "$LOCK"; }
trap cleanup EXIT INT TERM
if [ ! -x "$BIN" ] || [ "$SRC_SWIFT" -nt "$BIN" ]; then
  echo "Building the converter (once)…"
  swiftc -O -o "$BIN" "$SRC_SWIFT" 2>/dev/null || {
    echo "Could not compile $SRC_SWIFT."
    echo "Xcode Command Line Tools are needed:  xcode-select --install"; exit 1; }
fi

FPS=60
CODEC=prores
AUDIO=""   # optional narration track; silence when empty

# Convert one file. Skips anything already done, and anything still being
# written -- a download in progress would otherwise convert to a short clip.
# A finished ProRes file is always much larger than the H.264 it came from.
# Anything smaller is a stub from a run that was interrupted -- a shut lid, a
# Control-C -- and must be redone, not skipped.
done_already() {
  local src="$1" out="$2"
  [ -f "$out" ] || return 1
  [ "$out" -nt "$src" ] || return 1
  local so oo
  so=$(stat -f %z "$src" 2>/dev/null || echo 0)
  oo=$(stat -f %z "$out" 2>/dev/null || echo 0)
  if [ "$CODEC" = h264 ]; then [ "$oo" -gt 100000 ]; else [ "$oo" -gt "$so" ]; fi
}

convert_one() {
  local src="$1" out
  case "$src" in
    *-resolve.mov|*-resolve.mp4) return 0 ;;
    *.webm) echo "  skip: $(basename "$src") is webm; macOS cannot decode VP9. Record in Chrome."; return 0 ;;
  esac
  if [ "$CODEC" = h264 ]; then out="${src%.*}-resolve.mp4"; else out="${src%.*}-resolve.mov"; fi
  done_already "$src" "$out" && return 0
  # an unfinished leftover from a killed run
  [ -f "$out" ] && { echo "  $(basename "$out") is incomplete; redoing it."; rm -f "$out"; }
  local a b
  a=$(stat -f %z "$src" 2>/dev/null || echo 0); sleep 1
  b=$(stat -f %z "$src" 2>/dev/null || echo 0)
  [ "$a" != "$b" ] && { echo "  $(basename "$src") is still downloading; leaving it."; return 0; }
  echo "  $(basename "$src")"
  if "$BIN" "$src" "$out" "$FPS" "$CODEC" "$AUDIO"; then
    echo "     -> $(basename "$out")"
  else
    echo "     conversion failed."; rm -f "$out"; return 1
  fi
}

convert_all() {
  local found=0 f
  for f in "$DL"/chartgauge-*.mp4; do
    [ -e "$f" ] || continue
    case "$f" in *-resolve.mp4) continue ;; esac
    done_already "$f" "${f%.*}-resolve.mov" && continue
    found=1
    convert_one "$f"
  done
  [ "$found" = 0 ] && echo "  everything in Downloads is already converted."
  return 0
}

hold_window() { if [ -t 1 ]; then echo; read -r -p "Press return to close." _ || true; fi; }

# ---- watch mode: convert each recording as it appears ----
if [ "${1:-}" = "--watch" ]; then
  echo "Watching ~/Downloads. Record from the exporter and the .mov appears here."
  echo "Leave this window open. Control-C to stop."
  echo
  convert_all
  while true; do
    sleep 4
    for f in "$DL"/chartgauge-*.mp4; do
      [ -e "$f" ] || continue
      case "$f" in *-resolve.mp4) continue ;; esac
      done_already "$f" "${f%.*}-resolve.mov" && continue
      convert_one "$f"
    done
  done
fi

# ---- one named file ----
if [ -n "${1:-}" ]; then
  [ -f "$1" ] || { echo "No such file: $1"; exit 1; }
  FPS="${2:-60}"; CODEC="${3:-prores}"; AUDIO="${4:-}"
  echo "Converting for Resolve"
  convert_one "$1" || exit 1
  echo; echo "Import the -resolve file, not the original."
  hold_window
  exit 0
fi

# ---- default: everything not yet done ----
echo "Converting every ChartGauge recording in Downloads that needs it."
echo
convert_all
echo
echo "Import the -resolve.mov files. The plain .mp4 originals are the raw"
echo "recordings and Resolve will refuse them."
echo
echo "If Resolve still shows nothing after dragging one in, it is almost"
echo "certainly macOS file permissions rather than the file: give DaVinci"
echo "Resolve access under System Settings > Privacy & Security > Files and"
echo "Folders (or Full Disk Access), then restart Resolve."
hold_window
