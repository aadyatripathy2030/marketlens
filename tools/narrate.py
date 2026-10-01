#!/usr/bin/env python3
"""Build the sound track for a cut: a spoken line per beat, plus effects.

Everything here is macOS built-ins -- `say` for the voice, arithmetic for the
effects -- so there is no account, no key and no network. Output is one mono
16-bit 44.1k WAV the length of the clip, which for-resolve muxes in place of
the silent track.

Each line is spoken, measured, and if it overruns its beat it is spoken again
faster until it fits, because a line that runs into the next beat is worse
than one delivered briskly.
"""
import array, math, os, re, struct, subprocess, sys, tempfile, wave

RATE = 44100
VOICE = os.environ.get('CG_VOICE', 'Samantha')
BASE_WPM = int(os.environ.get('CG_WPM', '175'))

def _say_to_wav(text, wpm, out):
    aiff = out + '.aiff'
    subprocess.run(['say', '-v', VOICE, '-r', str(wpm), '-o', aiff, text],
                   check=True, capture_output=True)
    subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@44100', '-c', '1', aiff, out],
                   check=True, capture_output=True)
    os.unlink(aiff)
    with wave.open(out, 'rb') as w:
        return array.array('h', w.readframes(w.getnframes()))

def speak(text, budget_s, tmp, idx):
    """Speak `text` so it fits inside budget_s, slowing nothing down needlessly."""
    out = os.path.join(tmp, 'vo%d.wav' % idx)
    wpm = BASE_WPM
    samples = _say_to_wav(text, wpm, out)
    # Leave a breath at the end of the beat rather than butting up against it.
    room = max(0.4, budget_s - 0.35)
    for _ in range(4):
        if len(samples) / RATE <= room:
            break
        over = (len(samples) / RATE) / room
        wpm = min(320, int(wpm * min(1.35, over * 1.04)))
        samples = _say_to_wav(text, wpm, out)
    return samples

# ---- effects, drawn rather than sampled ----
def _env(n, attack, release):
    e = []
    a = max(1, int(n * attack)); r = max(1, int(n * release))
    for i in range(n):
        if i < a: e.append(i / a)
        elif i > n - r: e.append(max(0.0, (n - i) / r))
        else: e.append(1.0)
    return e

def tone(freq_from, freq_to, secs, gain, attack=0.02, release=0.5, noise=0.0):
    n = int(secs * RATE)
    env = _env(n, attack, release)
    out = array.array('h', [0]) * 0
    seed = 12345
    vals = []
    phase = 0.0
    for i in range(n):
        t = i / n
        f = freq_from + (freq_to - freq_from) * t
        phase += 2 * math.pi * f / RATE
        v = math.sin(phase)
        if noise:
            seed = (1103515245 * seed + 12345) & 0x7fffffff
            v = v * (1 - noise) + ((seed / 0x7fffffff) * 2 - 1) * noise
        vals.append(v * env[i] * gain)
    return array.array('h', [max(-32768, min(32767, int(v * 32767))) for v in vals])

def whoosh():   return tone(900, 180, 0.34, 0.11, attack=0.08, release=0.7, noise=0.85)
def tick():     return tone(1600, 1200, 0.05, 0.13, attack=0.05, release=0.8)
def chime():    return tone(880, 1320, 0.70, 0.13, attack=0.01, release=0.85)

def mix_into(buf, clip, at_s, gain=1.0):
    start = int(at_s * RATE)
    for i, v in enumerate(clip):
        j = start + i
        if 0 <= j < len(buf):
            buf[j] = max(-32768, min(32767, buf[j] + int(v * gain)))

def build(beats, total_s, out_path):
    buf = array.array('h', [0]) * 0
    buf = array.array('h', bytes(int(total_s * RATE) * 2))
    with tempfile.TemporaryDirectory() as tmp:
        for i, b in enumerate(beats):
            start, end = b['from'] / 1000.0, b['to'] / 1000.0
            line = b.get('big', '').strip()
            if b.get('sub'): line += '. ' + b['sub'].strip()
            # the URL reads badly as speech
            line = re.sub(r'\bchartgauge\.com\b', 'chart gauge dot com', line, flags=re.I)
            if i > 0:
                mix_into(buf, whoosh(), max(0.0, start - 0.12))
            if line:
                vo = speak(line, end - start, tmp, i)
                mix_into(buf, vo, start + 0.18, gain=1.0)
        mix_into(buf, chime(), max(0.0, beats[-1]['from'] / 1000.0 + 0.05), gain=0.9)
        mix_into(buf, tick(), 0.02)
    with wave.open(out_path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(buf.tobytes())
    return out_path

if __name__ == '__main__':
    import json
    beats = json.loads(sys.argv[1])
    total = float(sys.argv[2])
    print(build(beats, total, sys.argv[3]))
