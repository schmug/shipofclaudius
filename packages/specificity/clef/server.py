"""Local Clef-flash server for the specificity mod's `mode: clef`.

Serves POST /v1/systemone (the Jev/SystemOne request shape) on 127.0.0.1 only,
answering with Cloudflare's own `systemone()` from the model release. Requests
run one at a time: the GPU holds one model and the mod sends one prompt at once.

Setup, once (about 19 GB):
    hf download Cloudflare/clef-flash
    uv venv clef-venv && VIRTUAL_ENV=clef-venv uv pip install torch transformers accelerate safetensors huggingface_hub pillow torchvision
Run:
    clef-venv/bin/python packages/specificity/clef/server.py [--device mps|cuda|cpu] [--port 8765]

Measured 2026-10-04 on an M4 Max (MPS): loads in about 6 s, about 3.4 s per
four-question request with transformers' reference kernels.
"""
import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from huggingface_hub import snapshot_download

# The mod sends at most 2,000 prompt characters and a few messages of context.
MAX_BODY = 256 * 1024


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Cloudflare/clef-flash", help="Hugging Face repo id or a local snapshot directory")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    path = Path(args.model) if Path(args.model).is_dir() else Path(snapshot_download(args.model))
    sys.path.insert(0, str(path))  # joint_schema_model.py ships inside the release
    from joint_schema_model import load_release_model, systemone

    model, processor = load_release_model(path, device=args.device)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/v1/systemone":
                return self.reply(404, {"error": "not found"})
            # Loopback is reachable from any web page the person has open: a
            # foreign Host (DNS rebinding) or a non-JSON body (a plain form post,
            # which needs no CORS preflight) is refused before the model runs.
            host = self.headers.get("host", "")
            if not host.endswith("]"):
                host = host.rsplit(":", 1)[0]
            if host not in ("127.0.0.1", "localhost", "[::1]"):
                return self.reply(403, {"error": "forbidden host"})
            if self.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                return self.reply(415, {"error": "json only"})
            length = int(self.headers.get("content-length", "0") or "0")
            if length <= 0 or length > MAX_BODY:
                return self.reply(413, {"error": "body too large"})
            try:
                request = json.loads(self.rfile.read(length))
                return self.reply(200, systemone(model, processor, request))
            except ValueError as err:
                return self.reply(400, {"error": str(err)[:300]})
            except Exception as err:  # the mod falls back to haiku on any non-2xx
                return self.reply(500, {"error": type(err).__name__})

        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_: object) -> None:  # never log request bodies: they carry the person's prompts
            pass

    print(f"clef server on http://127.0.0.1:{args.port}/v1/systemone ({path.name}, {args.device})", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
