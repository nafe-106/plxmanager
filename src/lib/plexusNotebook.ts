// ---------------------------------------------------------------------------
// Plexus Kaggle notebook template.
//
// This is the Python script that "Start session" pushes to a Kaggle account.
// It is a merge of:
//   * the bootstrap that installs & starts Ollama on the Kaggle GPU, spins up
//     an authenticated proxy and opens a Cloudflare quick tunnel, and
//   * the keep-alive publisher that upserts the current tunnel URL into the
//     Supabase table `plexus_endpoint` (row id=1) so Target API Manager can
//     watch it and restart the session when the tunnel goes dark.
//
// Placeholders below are replaced with the app's saved settings at push time:
//   __PLEXUS_SUPABASE_URL__ / __PLEXUS_SUPABASE_KEY__ / __PLEXUS_TOKEN__
//   __BRAIN_MODEL__ / __VISION_MODEL__ / __EXTRA_MODELS__
// ---------------------------------------------------------------------------

export const DEFAULT_BRAIN_MODEL = "qwen3:30b";
export const DEFAULT_VISION_MODEL = "qwen2.5vl:7b";
export const DEFAULT_EXTRA_MODELS: string[] = [];
export const DEFAULT_SLUG = "plexus-ollama";

export const PLEXUS_NOTEBOOK = String.raw`# ============================================================
# PLEXUS - KAGGLE GPU OLLAMA + AUTH PROXY + CLOUDFLARE
# KEEP-ALIVE (publishes the tunnel URL to Supabase)
#
# Brain  : qwen3:30b
# Vision : qwen2.5vl:7b
# ============================================================

import os
import sys
import time
import json
import re
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import requests
import urllib.request


# ============================================================
# CONFIG
# ============================================================

BRAIN_MODEL = "__BRAIN_MODEL__"
VISION_MODEL = "__VISION_MODEL__"
EXTRA_MODELS = __EXTRA_MODELS__

PLEXUS_TOKEN = "__PLEXUS_TOKEN__"

SUPABASE_URL = "__PLEXUS_SUPABASE_URL__"
SUPABASE_KEY = "__PLEXUS_SUPABASE_KEY__"
PUBLISH_ENABLED = bool(SUPABASE_URL and SUPABASE_KEY)

OLLAMA_HOST = "127.0.0.1:11434"

PROXY_HOST = "127.0.0.1"
PROXY_PORT = 18080

OLLAMA_URL = f"http://{OLLAMA_HOST}"
PROXY_URL = f"http://{PROXY_HOST}:{PROXY_PORT}"

CONNECTION_FILE = "/kaggle/working/plexus_connection.json"

STATE = {
    "ollama": None,
    "proxy": None,
    "cloudflared": None,
    "public_url": None,
}

LOCK = threading.Lock()


# ============================================================
# HELPERS
# ============================================================

def run(cmd, capture=True):
    return subprocess.run(
        cmd,
        capture_output=capture,
        text=True,
    )


def port_open(host, port):
    s = socket.socket()
    s.settimeout(1)

    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def kill_named_process(name):
    subprocess.run(
        ["pkill", "-9", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def kill_process(proc):
    if not proc:
        return

    try:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
    except Exception:
        pass


# ============================================================
# HEADER
# ============================================================

print("=" * 70)
print("PLEXUS - KAGGLE OLLAMA BOOT")
print("=" * 70)
print()


# ============================================================
# 1. GPU
# ============================================================

print("[1/8] GPU")

gpu = run([
    "nvidia-smi",
    "--query-gpu=name,memory.total",
    "--format=csv,noheader"
])

if gpu.returncode == 0:
    print(gpu.stdout.strip())
else:
    print("! nvidia-smi unavailable")


# ============================================================
# 2. ZSTD
# ============================================================

print()
print("[2/8] Dependencies")

if shutil.which("zstd") is None:

    print("Installing zstd...")

    subprocess.run(
        ["apt-get", "update"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    result = subprocess.run(
        ["apt-get", "install", "-y", "zstd"],
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError("zstd installation failed")

print("OK zstd")


# ============================================================
# 3. OLLAMA
# ============================================================

print()
print("[3/8] Ollama")

ollama_path = shutil.which("ollama")

if not ollama_path:

    candidates = [
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
        "/root/.ollama/bin/ollama",
        "/opt/ollama/bin/ollama",
    ]

    for path in candidates:
        if os.path.exists(path):
            ollama_path = path
            break


if not ollama_path:

    print("Installing Ollama...")

    installer = requests.get(
        "https://ollama.com/install.sh",
        timeout=60,
    )

    installer.raise_for_status()

    installer_path = "/tmp/install_ollama.sh"

    Path(installer_path).write_text(
        installer.text
    )

    result = subprocess.run(
        ["sh", installer_path],
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError("Ollama installation failed")

    ollama_path = shutil.which("ollama")

    if not ollama_path:

        for path in [
            "/usr/local/bin/ollama",
            "/usr/bin/ollama",
            "/root/.ollama/bin/ollama",
            "/opt/ollama/bin/ollama",
        ]:
            if os.path.exists(path):
                ollama_path = path
                break


if not ollama_path:
    raise RuntimeError("Ollama executable not found")


print("OK", ollama_path)


# ============================================================
# 4. START OLLAMA
# ============================================================

print()
print("[4/8] Starting Ollama")

kill_named_process("ollama")

time.sleep(1)

env = os.environ.copy()
env["OLLAMA_HOST"] = OLLAMA_HOST

STATE["ollama"] = subprocess.Popen(
    [ollama_path, "serve"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    env=env,
)

deadline = time.time() + 60

while time.time() < deadline:

    if port_open("127.0.0.1", 11434):
        break

    time.sleep(1)

if not port_open("127.0.0.1", 11434):
    raise RuntimeError("Ollama did not start")

print("OK Ollama:", OLLAMA_URL)


# ============================================================
# 5. MODELS
# ============================================================

print()
print("[5/8] Models")

def get_models():

    r = requests.get(
        f"{OLLAMA_URL}/api/tags",
        timeout=20,
    )

    r.raise_for_status()

    return {
        m.get("name")
        for m in r.json().get("models", [])
    }


models = get_models()

print("Installed:")

for model in sorted(models):
    print(" o", model)


def ensure_model(model):

    if model in models:
        print(f"OK {model}")
        return

    print(f"Pulling {model}")

    process = subprocess.Popen(
        [ollama_path, "pull", model],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    for line in process.stdout:
        print(line.rstrip())

    code = process.wait()

    if code != 0:
        raise RuntimeError(
            f"Failed to pull {model}"
        )

    print(f"OK {model}")


ensure_model(BRAIN_MODEL)
ensure_model(VISION_MODEL)

for model in EXTRA_MODELS:
    ensure_model(model)


# ============================================================
# 6. AUTH PROXY
# ============================================================

print()
print("[6/8] Authenticated proxy")


proxy_code = r"""
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["PLEXUS_TOKEN"]
OLLAMA = os.environ["OLLAMA_INTERNAL"]
PORT = int(os.environ["PROXY_PORT"])


class Handler(BaseHTTPRequestHandler):

    protocol_version = "HTTP/1.1"

    # Unbuffered socket writes: every chunk hits the wire immediately so
    # cloudflared can stream it to Cloudflare without a 100s origin
    # timeout. Buffering the whole body here is what caused HTTP 524.
    wbufsize = 0

    def authorized(self):

        return (
            self.headers.get("Authorization", "")
            == "Bearer " + TOKEN
        )

    def send_body(
        self,
        status,
        body,
        content_type="application/json",
    ):

        if isinstance(body, str):
            body = body.encode()

        self.send_response(status)

        self.send_header(
            "Content-Type",
            content_type
        )

        self.send_header(
            "Content-Length",
            str(len(body))
        )

        self.send_header(
            "Cache-Control",
            "no-store"
        )

        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(body)

    def start_stream(self, status, content_type):

        self.send_response(status)

        self.send_header(
            "Content-Type",
            content_type
        )

        self.send_header(
            "Transfer-Encoding",
            "chunked"
        )

        self.send_header(
            "Cache-Control",
            "no-store"
        )

        self.end_headers()

    def stream_chunk(self, chunk):

        if not chunk:
            return

        # http chunk framing: <hex size>\r\n<data>\r\n ...
        self.wfile.write(b"%x\r\n" % len(chunk))
        self.wfile.write(chunk)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def end_stream(self):

        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def proxy(self):

        if not self.authorized():

            self.send_body(
                401,
                '{"error":"unauthorized"}'
            )

            return

        length = int(
            self.headers.get(
                "Content-Length",
                "0"
            )
        )

        body = (
            self.rfile.read(length)
            if length
            else None
        )

        target = OLLAMA + self.path

        headers = {}

        for key in [
            "Content-Type",
            "Accept",
        ]:

            value = self.headers.get(key)

            if value:
                headers[key] = value

        request = urllib.request.Request(
            target,
            data=body,
            headers=headers,
            method=self.command,
        )

        try:

            with urllib.request.urlopen(
                request,
                timeout=600
            ) as response:

                if self.command == "HEAD":

                    self.send_body(
                        response.status,
                        b"",
                        response.headers.get(
                            "Content-Type",
                            "application/json"
                        )
                    )

                    return

                self.start_stream(
                    response.status,
                    response.headers.get(
                        "Content-Type",
                        "application/json"
                    )
                )

                while True:

                    chunk = response.read(65536)

                    if not chunk:
                        break

                    self.stream_chunk(chunk)

                self.end_stream()

        except urllib.error.HTTPError as e:

            data = e.read()

            self.send_body(
                e.code,
                data,
                e.headers.get(
                    "Content-Type",
                    "application/json"
                )
            )

        except Exception:

            self.send_body(
                502,
                '{"error":"ollama_upstream_unreachable"}'
            )

    def do_GET(self):
        self.proxy()

    def do_POST(self):
        self.proxy()

    def do_HEAD(self):
        self.proxy()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(
    ("127.0.0.1", PORT),
    Handler
)

server.serve_forever()
"""


proxy_file = "/tmp/plexus_proxy.py"

Path(proxy_file).write_text(
    proxy_code
)


# Kill only our proxy
subprocess.run(
    ["pkill", "-f", "plexus_proxy.py"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

time.sleep(1)

proxy_env = os.environ.copy()
proxy_env["PLEXUS_TOKEN"] = PLEXUS_TOKEN
proxy_env["OLLAMA_INTERNAL"] = OLLAMA_URL
proxy_env["PROXY_PORT"] = str(PROXY_PORT)

STATE["proxy"] = subprocess.Popen(
    [
        sys.executable,
        proxy_file,
    ],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    env=proxy_env,
)

deadline = time.time() + 20

while time.time() < deadline:

    if port_open(
        "127.0.0.1",
        PROXY_PORT
    ):
        break

    time.sleep(0.5)

if not port_open(
    "127.0.0.1",
    PROXY_PORT
):
    raise RuntimeError("Proxy failed to start")


# Local test

local = requests.get(
    f"{PROXY_URL}/api/tags",
    headers={
        "Authorization":
            f"Bearer {PLEXUS_TOKEN}"
    },
    timeout=20,
)

if local.status_code != 200:

    raise RuntimeError(
        f"Local proxy failed: "
        f"{local.status_code}"
    )


print("OK Proxy:", PROXY_URL)
print("OK Local proxy test: 200")


# ============================================================
# 7. CLOUDFLARE
# ============================================================

print()
print("[7/8] Cloudflare")


cloudflared_path = shutil.which(
    "cloudflared"
)

if not cloudflared_path:

    for path in [
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
        "/tmp/cloudflared",
    ]:

        if os.path.exists(path):

            cloudflared_path = path
            break


if not cloudflared_path:

    print("Downloading cloudflared...")

    download_url = (
        "https://github.com/cloudflare/cloudflared/"
        "releases/latest/download/"
        "cloudflared-linux-amd64"
    )

    data = requests.get(
        download_url,
        timeout=60,
    )

    data.raise_for_status()

    cloudflared_path = "/tmp/cloudflared"

    Path(
        cloudflared_path
    ).write_bytes(
        data.content
    )

    os.chmod(
        cloudflared_path,
        0o755
    )


print("cloudflared:", cloudflared_path)


def start_tunnel():

    kill_named_process(
        "cloudflared"
    )

    time.sleep(2)

    process = subprocess.Popen(
        [
            cloudflared_path,
            "tunnel",
            "--no-autoupdate",
            "--protocol",
            "http2",
            "--url",
            PROXY_URL,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    pattern = re.compile(
        r"https://[a-zA-Z0-9-]+\.trycloudflare\.com"
    )

    public_url = None
    logs = []

    deadline = time.time() + 60

    while time.time() < deadline:

        if process.poll() is not None:
            break

        line = process.stdout.readline()

        if line:

            line = line.strip()

            if line:
                logs.append(line)
                print("[CF]", line)

            match = pattern.search(line)

            if match:

                public_url = match.group(0)

                break

        else:

            time.sleep(0.25)

    if not public_url:

        print()
        print("X Cloudflare URL not detected.")
        print()

        for line in logs[-50:]:
            print(line)

        kill_process(process)

        raise RuntimeError(
            "Cloudflare did not provide a URL."
        )

    print()
    print("Cloudflare URL:")
    print(public_url)

    # --------------------------------------------------------
    # CRITICAL:
    # Quick Tunnel DNS may take several seconds to propagate.
    # --------------------------------------------------------

    print()
    print("Waiting for Cloudflare DNS/edge...")

    test_url = (
        public_url
        + "/api/tags"
    )

    last_error = None

    for attempt in range(1, 31):

        try:

            response = requests.get(
                test_url,
                headers={
                    "Authorization":
                        f"Bearer {PLEXUS_TOKEN}"
                },
                timeout=10,
            )

            if response.status_code == 200:

                print(
                    f"OK Public endpoint ready "
                    f"(attempt {attempt})"
                )

                return process, public_url

            last_error = (
                f"HTTP {response.status_code}: "
                f"{response.text[:300]}"
            )

            print(
                f"attempt {attempt}/30: "
                f"{last_error}"
            )

        except Exception as e:

            last_error = str(e)

            print(
                f"attempt {attempt}/30: "
                f"waiting for DNS/edge..."
            )

        time.sleep(2)

    kill_process(process)

    raise RuntimeError(
        "Cloudflare URL was created, "
        "but never became reachable.\n"
        f"Last error: {last_error}"
    )


STATE["cloudflared"], STATE["public_url"] = (
    start_tunnel()
)


# ============================================================
# CONNECTION FILE
# ============================================================

def save_connection():

    data = {
        "status": "online",
        "public_url": STATE["public_url"],
        "ollama_base_url": STATE["public_url"],
        "api_key": PLEXUS_TOKEN,
        "brain_model": BRAIN_MODEL,
        "vision_model": VISION_MODEL,
        "timestamp": time.time(),
    }

    Path(
        CONNECTION_FILE
    ).write_text(
        json.dumps(
            data,
            indent=2
        )
    )


save_connection()


# ============================================================
# KEEP-ALIVE: publish the tunnel URL to Supabase
# ============================================================

def publish_connection(url):

    if not PUBLISH_ENABLED:
        print(
            "Supabase not configured "
            "(__PLEXUS_SUPABASE_URL__/__PLEXUS_SUPABASE_KEY__) - "
            "skipping publish."
        )
        return False

    body = json.dumps(
        {"id": 1, "public_url": url}
    ).encode()

    request = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/plexus_endpoint?on_conflict=id",
        data=body,
        method="POST",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )

    try:

        with urllib.request.urlopen(
            request,
            timeout=15
        ) as response:

            print(
                f"OK Published connection "
                f"(status {response.status}):"
            )
            print(url)
            return True

    except Exception as e:

        print("Publish failed:", e)
        return False


# ============================================================
# FINAL VERIFICATION
# ============================================================

print()
print("=" * 70)
print("PLEXUS KAGGLE OLLAMA ONLINE")
print("=" * 70)

print()
print("PUBLIC URL:")
print(STATE["public_url"])

print()
print("BRAIN:")
print(BRAIN_MODEL)

print()
print("VISION:")
print(VISION_MODEL)

print()
print("TOKEN:")
print(PLEXUS_TOKEN)

print()
print("CONNECTION FILE:")
print(CONNECTION_FILE)

print()
print("WINDOWS TEST:")
print()

print(
    f'curl.exe -i '
    f'-H "Authorization: Bearer {PLEXUS_TOKEN}" '
    f'{STATE["public_url"]}/api/tags'
)

print()
print("=" * 70)


# ============================================================
# SUPERVISOR (replaces dead tunnels, keeps the link published)
# ============================================================

def supervisor():

    print()
    print("Cloudflare supervisor ACTIVE")

    while True:

        time.sleep(10)

        process = STATE.get(
            "cloudflared"
        )

        if (
            process is None
            or process.poll() is not None
        ):

            print()
            print(
                "Cloudflare tunnel died."
            )

            print(
                "Creating replacement tunnel..."
            )

            try:

                new_process, new_url = (
                    start_tunnel()
                )

                STATE["cloudflared"] = (
                    new_process
                )

                STATE["public_url"] = (
                    new_url
                )

                save_connection()

                if PUBLISH_ENABLED:
                    publish_connection(new_url)

                print()
                print(
                    "OK New Cloudflare tunnel:"
                )

                print(new_url)

                print()
                print(
                    "Connection file updated."
                )

            except Exception as e:

                print()
                print(
                    "X Tunnel restart failed:"
                )

                print(e)

                time.sleep(10)


def heartbeat():

    print()
    print("Keep-alive heartbeat ACTIVE")

    while True:

        time.sleep(300)

        url = STATE.get("public_url")

        if url:

            save_connection()

            if PUBLISH_ENABLED:
                publish_connection(url)


threading.Thread(
    target=supervisor,
    daemon=True,
).start()

threading.Thread(
    target=heartbeat,
    daemon=True,
).start()


# ============================================================
# DONE
# ============================================================

if PUBLISH_ENABLED:
    publish_connection(STATE["public_url"])

print()
print("EVERYTHING IS RUNNING.")
print()
print(
    "Keep this Kaggle runtime alive."
)
print(
    "If Kaggle terminates the runtime, "
    "Ollama/proxy/Cloudflare also terminate."
)
print()
print(
    "PLEXUS can now connect to:"
)
print(
    STATE["public_url"]
)

# ============================================================
# MAIN THREAD MUST NEVER RETURN.
#
# If this top-level script finishes, Kaggle marks the run
# "complete" and terminates the whole runtime — Ollama, the
# proxy and cloudflared all die with it. The daemon threads
# above do NOT keep the process alive, so park the main thread
# here instead of letting the script end.
# ============================================================

print()
print("Parking main thread (run stays alive).")

while True:
    time.sleep(300)

    url = STATE.get("public_url")

    if url:

        save_connection()

        if PUBLISH_ENABLED:
            publish_connection(url)
`;

export interface PlexusNotebookOptions {
  supabaseUrl: string;
  supabaseKey: string;
  plexusToken: string;
  brainModel?: string;
  visionModel?: string;
  extraModels?: string[];
}

export function renderPlexusNotebook(opts: PlexusNotebookOptions): string {
  return PLEXUS_NOTEBOOK.replace(/__PLEXUS_SUPABASE_URL__/g, opts.supabaseUrl || "")
    .replace(/__PLEXUS_SUPABASE_KEY__/g, opts.supabaseKey || "")
    .replace(/__PLEXUS_TOKEN__/g, opts.plexusToken || "PLEXUS_KAGGLE_2026")
    .replace(/__BRAIN_MODEL__/g, opts.brainModel || DEFAULT_BRAIN_MODEL)
    .replace(/__VISION_MODEL__/g, opts.visionModel || DEFAULT_VISION_MODEL)
    .replace(/__EXTRA_MODELS__/g, JSON.stringify(opts.extraModels?.filter(Boolean) || []));
}