#!/usr/bin/env python3
"""Receive a recording from the exporter and convert it, with no folder to scan.

macOS will not let a LaunchAgent list ~/Downloads -- it can read and write a
path it is given, but `ls` on the folder returns nothing at all, which is why
a watcher that looked for new recordings there always concluded there were
none. So nothing here looks. The page hands the file over by name, this writes
it, runs the converter on that exact path, and both files land in
~/Movies/ChartGauge, a folder an agent is allowed to manage.

Bound to loopback only. A page can still reach a loopback server from any
origin, so requests are accepted only from a local page, the name is reduced
to a basename of known characters, and the body is capped.
"""
import http.server, json, os, re, socketserver, subprocess, sys, threading, urllib.parse

PORT = 47823
HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.expanduser('~/Movies/ChartGauge')
CONVERTER = os.path.join(HERE, 'for-resolve.command')
MAX_BYTES = 2 * 1024 * 1024 * 1024        # a 50s take is ~10MB; this is slack
OK_EXT = ('.mp4', '.webm')

def local_origin(o):
    if not o or o == 'null':              # a file:// page sends null
        return True
    h = urllib.parse.urlparse(o).hostname
    return h in ('localhost', '127.0.0.1', '::1')

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _cors(self):
        o = self.headers.get('Origin')
        self.send_header('Access-Control-Allow-Origin', o if o and o != 'null' else '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors()
        self.send_header('Content-Length', '0'); self.end_headers()

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == '/ping':
            return self._json(200, {'ok': True, 'dest': DEST})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not local_origin(self.headers.get('Origin')):
            return self._json(403, {'error': 'only a local page may post here'})
        u = urllib.parse.urlparse(self.path)
        if u.path != '/convert':
            return self._json(404, {'error': 'not found'})
        q = urllib.parse.parse_qs(u.query)
        raw = (q.get('name') or ['clip.mp4'])[0]
        name = re.sub(r'[^A-Za-z0-9._()\- ]', '_', os.path.basename(raw))
        if not name.lower().endswith(OK_EXT):
            return self._json(400, {'error': 'only mp4 or webm'})
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            return self._json(400, {'error': 'bad length'})
        if n <= 0 or n > MAX_BYTES:
            return self._json(400, {'error': 'bad length'})

        os.makedirs(DEST, exist_ok=True)
        src = os.path.join(DEST, name)
        got, left = 0, n
        with open(src, 'wb') as f:
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk); got += len(chunk); left -= len(chunk)
        if got != n:
            os.unlink(src)
            return self._json(400, {'error': 'upload was cut short'})

        out = os.path.splitext(src)[0] + '-resolve.mov'
        try:
            r = subprocess.run(['/bin/bash', CONVERTER, src, '60', 'prores'],
                               capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired:
            return self._json(500, {'error': 'conversion timed out', 'saved': src})
        if r.returncode != 0 or not os.path.exists(out):
            return self._json(500, {'error': 'conversion failed', 'saved': src,
                                    'detail': (r.stdout + r.stderr).strip()[-400:]})
        return self._json(200, {'ok': True, 'saved': src, 'converted': out,
                                'mb': round(os.path.getsize(out) / 1e6)})

    def log_message(self, *a):
        sys.stderr.write('%s - %s\n' % (self.address_string(), a[0] % a[1:]))

class Threaded(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    os.makedirs(DEST, exist_ok=True)
    print('ChartGauge convert server on 127.0.0.1:%d -> %s' % (PORT, DEST), flush=True)
    Threaded(('127.0.0.1', PORT), H).serve_forever()
