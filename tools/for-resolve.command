#!/bin/bash
# Make a ChartGauge recording importable by DaVinci Resolve.
#
# Two things stop Resolve taking the exporter's file, and both are fixed here.
#
# 1. FRAGMENTED CONTAINER. MediaRecorder writes ftyp / moov(init only) /
#    moof+mdat / moof+mdat / mfra. Resolve wants one real moov. avconvert ships
#    with macOS and PresetPassthrough rewrites the container without touching
#    the video.
#
# 2. VARIABLE FRAME RATE. MediaRecorder timestamps frames off the wall clock,
#    so every frame has its own duration. Resolve refuses VFR footage, and
#    avconvert will not normalise it even when re-encoding. The second step
#    rewrites the stts table so every frame shares one duration. Total length
#    is preserved; frames end up evenly spaced.
#
# Nothing to install. Run it from Terminal:
#     bash ~/stock-predictor/tools/for-resolve.command
# or pass a path:
#     bash ~/stock-predictor/tools/for-resolve.command ~/Downloads/clip.mp4

set -u

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC=$(ls -t "$HOME/Downloads"/chartgauge-*.mp4 2>/dev/null | head -1)
fi

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "No recording found in ~/Downloads."
  echo "Record one from tools/video-export.html first, or pass a path."
  exit 1
fi

case "$SRC" in
  *.webm)
    echo "That is a .webm and macOS cannot read VP9, so this cannot convert it."
    echo "Record again in Chrome — the exporter writes mp4 where Chrome supports it."
    exit 1 ;;
esac

BASE="${SRC%.*}"
TMP="${BASE}-tmp.mp4"
OUT="${BASE}-resolve.mp4"

echo "Converting for Resolve"
echo "  in : $(basename "$SRC")"

if ! avconvert --preset PresetPassthrough --source "$SRC" --output "$TMP" >/dev/null 2>&1; then
  echo "  avconvert could not read that file."
  exit 1
fi

python3 - "$TMP" "$OUT" <<'PY'
# Force constant frame rate by giving every stts entry the same delta.
# Rewriting deltas in place keeps the box the same size, so no parent box size
# and no chunk offset has to move — which is what makes a byte edit safe here.
import struct, sys, shutil

def boxes(d, want, start=0, end=None):
    end = len(d) if end is None else end
    i = start
    while i < end - 8:
        size = struct.unpack('>I', d[i:i+4])[0]
        typ = d[i+4:i+8]
        if size == 1:
            size = struct.unpack('>Q', d[i+8:i+16])[0]
        if size < 8:
            return
        if typ == want:
            yield i, size
        if typ in (b'moov', b'trak', b'mdia', b'minf', b'stbl'):
            yield from boxes(d, want, i + 8, i + size)
        i += size

src, out = sys.argv[1], sys.argv[2]
shutil.copyfile(src, out)
d = bytearray(open(out, 'rb').read())

hits = list(boxes(d, b'stts'))
if not hits:
    print('  could not find the frame table; leaving timing alone')
    raise SystemExit(0)

off, _ = hits[0]
p = off + 12
count = struct.unpack('>I', d[p:p+4])[0]
p += 4
entries = [struct.unpack('>II', d[p+j*8:p+8+j*8]) for j in range(count)]
frames = sum(c for c, _ in entries)
total  = sum(c * dl for c, dl in entries)
if frames == 0:
    raise SystemExit(0)

delta = max(1, round(total / frames))
for j, (c, _) in enumerate(entries):
    struct.pack_into('>II', d, p + j*8, c, delta)
new_total = delta * frames

for boff, _ in boxes(d, b'mdhd'):
    ver = d[boff+8]
    if ver == 1: struct.pack_into('>Q', d, boff+32, new_total)
    else:        struct.pack_into('>I', d, boff+24, new_total)
    ts = struct.unpack('>I', d[boff+(28 if ver==1 else 20):boff+(32 if ver==1 else 24)])[0]
    break

open(out, 'wb').write(bytes(d))
print('  fps : %.2f constant  (was %d different frame durations)'
      % (ts/delta if ts else 0, len({dl for _, dl in entries})))
print('  len : %.2fs, %d frames' % (new_total/ts if ts else 0, frames))
PY

rm -f "$TMP"
echo "  out: $(basename "$OUT")"
echo
echo "Drag that file into Resolve."
