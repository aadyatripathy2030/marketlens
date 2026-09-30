#!/bin/bash
# Convert a ChartGauge recording into a file DaVinci Resolve will accept.
#
# The exporter records through the browser's MediaRecorder, which produces four
# things Resolve dislikes:
#   - a fragmented container (moof/mdat rather than one moov)
#   - variable frame rate, every frame carrying its own duration
#   - a non-standard nominal rate (29.02fps, not 24/25/30/50/60)
#   - no audio track at all
#
# Remuxing cannot fix frame timing, so for-resolve.swift decodes and re-encodes
# onto an exact 1/fps grid and adds a silent track. AVFoundation only — nothing
# to install. The Swift is compiled once and the binary cached beside it.
#
# Output is ProRes 422 in a .mov at 60fps. Resolve decodes ProRes on every
# build; an H.264 mp4 imports on one machine and fails on the next.
#
#   double-click this file in Finder            # newest in ~/Downloads
#   bash tools/for-resolve.command
#   bash tools/for-resolve.command path/to/clip.mp4 [fps] [prores|h264]

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_SWIFT="$HERE/for-resolve.swift"
BIN="$HERE/.for-resolve-bin"

if [ ! -f "$SRC_SWIFT" ]; then
  echo "Missing $SRC_SWIFT"; exit 1
fi

# rebuild only when the source is newer than the cached binary
if [ ! -x "$BIN" ] || [ "$SRC_SWIFT" -nt "$BIN" ]; then
  echo "Building the converter (once)…"
  if ! swiftc -O -o "$BIN" "$SRC_SWIFT" 2>/dev/null; then
    echo "Could not compile $SRC_SWIFT."
    echo "Xcode Command Line Tools are needed:  xcode-select --install"
    exit 1
  fi
fi

SRC="${1:-}"
FPS="${2:-60}"
CODEC="${3:-prores}"
if [ -z "$SRC" ]; then
  SRC=$(ls -t "$HOME/Downloads"/chartgauge-*.mp4 "$HOME/Downloads"/chartgauge-*.webm 2>/dev/null | head -1)
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "No recording found in ~/Downloads."
  echo "Record one from tools/video-export.html first, or pass a path."
  exit 1
fi
case "$SRC" in
  *.webm)
    echo "That is a .webm and macOS cannot decode VP9, so this cannot read it."
    echo "Record again in Chrome — the exporter writes mp4 where Chrome supports it."
    exit 1 ;;
esac

if [ "$CODEC" = "h264" ]; then OUT="${SRC%.*}-resolve.mp4"; else OUT="${SRC%.*}-resolve.mov"; fi
echo "Converting for Resolve"
echo "  in  : $(basename "$SRC")"
if ! "$BIN" "$SRC" "$OUT" "$FPS" "$CODEC"; then
  echo "  conversion failed."
  exit 1
fi
echo "  out : $(basename "$OUT")"
echo
echo "Drag that file into Resolve. Import the -resolve one, not the original:"
echo "the original is a fragmented recording and Resolve will refuse it."
# Leave the window showing the result when this was double-clicked from Finder.
if [ -t 1 ] && [ -z "${1:-}" ]; then
  echo
  read -r -p "Press return to close." _ || true
fi
