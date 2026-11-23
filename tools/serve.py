"""Local static server for the viewer with HTTP Range support, CORS and path mounts (python -m http.server has none).
# origin: jurkat/viewer/serve.py (Jurkat viewer v7); --mount added.

Tiles are byte ranges of block shards (YCT2); the viewer falls back to fetching whole shards from servers without Range
support, so plain http.server also works, only with more traffic. --mount PREFIX=DIR serves DIR under /PREFIX/ (e.g. the
cells' data folders next to the built app, without copying ~16 GB per cell); symlinks are followed.

usage: python tools/serve.py [DIR] [--port 8000] [--bind 127.0.0.1] [--mount data=/path/to/viewer_data ...]
"""
import argparse, os, re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


MOUNTS = {}


class RangeHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split("?", 1)[0].split("#", 1)[0]
        for pre, d in MOUNTS.items():
            if p.startswith("/" + pre + "/"):
                rest = p[len(pre) + 2:]
                from urllib.parse import unquote
                full = os.path.normpath(os.path.join(d, unquote(rest)))
                if not (full == d or full.startswith(d + os.sep)):
                    return os.path.join(d, "__forbidden__")
                return full
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        if os.environ.get("SERVE_QUIET"):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()

    def send_head(self):
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        a = int(m.group(1)); b = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
        if a >= size or b < a:
            self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return None
        f = open(path, "rb"); f.seek(a)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.send_header("Content-Length", str(b - a + 1))
        self.end_headers()
        self._remaining = b - a + 1
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "_remaining", None)
        if n is None:
            return super().copyfile(source, outputfile)
        while n > 0:
            buf = source.read(min(n, 1 << 20))
            if not buf: break
            outputfile.write(buf); n -= len(buf)
        self._remaining = None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="?", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "dist"))
    ap.add_argument("--port", type=int, default=8000); ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--mount", action="append", default=[], help="PREFIX=DIR: serve DIR under /PREFIX/")
    a = ap.parse_args()
    for m in a.mount:
        pre, d = m.split("=", 1)
        MOUNTS[pre.strip("/")] = os.path.abspath(d)
    srv = ThreadingHTTPServer((a.bind, a.port), partial(RangeHandler, directory=a.dir))
    print(f"serving {a.dir} at http://{a.bind}:{a.port}/ (Range + CORS){''.join(f'; /{p}/ -> {d}' for p, d in MOUNTS.items())}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
