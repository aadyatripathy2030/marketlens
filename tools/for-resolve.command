#!/bin/bash
# Make a ChartGauge recording importable by DaVinci Resolve.
#
# The exporter records through the browser's MediaRecorder, which writes a
# FRAGMENTED mp4: ftyp / moov(init only) / moof+mdat / moof+mdat / mfra.
# Resolve wants an ordinary mp4 with one real moov — ftyp / moov / mdat — and
# silently refuses the fragmented kind.
#
# avconvert ships with macOS, so there is nothing to install. PresetPassthrough
# rewrites the container without touching the video, so it is quick and lossless.
#
# Double-click this file to convert the newest chartgauge recording in
# ~/Downloads, or run it with a path:  ./for-resolve.command /path/to/clip.mp4

set -u
cd "$(dirname "$0")"

boxes() {  # first few box types, so the change is visible rather than claimed
  python3 - "$1" <<'PY' 2>/dev/null || echo "?"
import struct, sys
d = open(sys.argv[1], 'rb').read()
i = 0; out = []
while i < len(d) - 8 and len(out) < 8:
    s = struct.unpack('>I', d[i:i+4])[0]
    out.append(d[i+4:i+8].decode('latin-1', 'replace'))
    if s < 8: break
    i += s
print(' '.join(out))
PY
}

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC=$(ls -t "$HOME/Downloads"/chartgauge-*.mp4 "$HOME/Downloads"/chartgauge-*.webm 2>/dev/null | head -1)
fi

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "No recording found."
  echo "Record one from tools/video-export.html first, or pass a path:"
  echo "  ./for-resolve.command ~/Downloads/chartgauge-aiproduct-1080x1920.mp4"
  read -n 1 -s -r -p "Press any key to close."; echo; exit 1
fi

case "$SRC" in
  *.webm)
    echo "That is a .webm, and macOS cannot read VP9, so this cannot convert it."
    echo "Record again in Chrome — the exporter writes mp4 wherever Chrome supports it."
    read -n 1 -s -r -p "Press any key to close."; echo; exit 1 ;;
esac

OUT="${SRC%.*}-resolve.mp4"
echo "Converting for Resolve"
echo "  in : $(basename "$SRC")"
echo "       boxes: $(boxes "$SRC")"

if ! avconvert --preset PresetPassthrough --source "$SRC" --output "$OUT" >/dev/null 2>&1; then
  echo
  echo "avconvert could not read that file."
  read -n 1 -s -r -p "Press any key to close."; echo; exit 1
fi

echo "  out: $(basename "$OUT")"
echo "       boxes: $(boxes "$OUT")"
case "$(boxes "$OUT")" in
  *moof*) echo; echo "Still fragmented — tell Claude, this should not happen." ;;
  *)      echo; echo "Done. Drag that file into Resolve." ;;
esac
read -n 1 -s -r -p "Press any key to close."; echo
