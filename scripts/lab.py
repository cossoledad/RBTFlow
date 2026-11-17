"""One local development workflow. The service and all state live in build/."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from fixtures import create

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
VENV = BUILD / "venv"
BIN = VENV / "bin"
SITE = BUILD / "site"
URL = "http://127.0.0.1:8080/"
PIDFILE = BUILD / "server.json"
LOG = BUILD / "server.log"
ENV = {**os.environ, "RBTFLOW_ROOT": str(ROOT), "PYTHONUNBUFFERED": "1",
       "PYTHONNOUSERSITE": "1", "XDG_CACHE_HOME": str(BUILD / "client-cache")}


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], cwd=kwargs.pop("cwd", ROOT),
                          env=ENV, check=True, **kwargs)


def api(path="api/", *, method="GET", data=None, accept="application/json", user="admin"):
    auth = base64.b64encode(f"{user}:rbtflow-local".encode()).decode()
    headers = {"Authorization": f"Basic {auth}", "Accept": accept}
    if data is not None:
        data = urllib.parse.urlencode(data).encode()
    request = urllib.request.Request(URL + path, data=data, method=method, headers=headers)
    # localhost traffic must not go through corporate HTTP proxy settings.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as r:
        body = r.read()
        return json.loads(body) if accept == "application/json" else body


def setup():
    BUILD.mkdir(mode=0o700, exist_ok=True)
    if not (BIN / "python").exists():
        interpreter = os.environ.get("RBTFLOW_PYTHON") or shutil.which("python3.12")
        if not interpreter:
            mise = shutil.which("mise")
            if not mise:
                raise RuntimeError("Install Python 3.12 or set RBTFLOW_PYTHON=/path/to/python3.12.")
            result = subprocess.run([mise, "where", "python@3.12.16"], capture_output=True, text=True)
            if result.returncode:
                run([mise, "install", "python@3.12.16"])
                result = run([mise, "where", "python@3.12.16"], capture_output=True, text=True)
            interpreter = str(Path(result.stdout.strip()) / "bin/python3")
        run([interpreter, "-c", "import sys; assert sys.version_info[:2] == (3, 12), 'Python 3.12 required'"])
        run([interpreter, "-m", "venv", VENV])
    requirements = ROOT / "requirements.txt"
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = BUILD / "dependencies.sha256"
    if not marker.exists() or marker.read_text() != digest:
        print("Installing pinned lab dependencies (build/install.log)...", flush=True)
        with (BUILD / "install.log").open("a") as f:
            run([BIN / "python", "-m", "pip", "install", "-r", requirements], stdout=f, stderr=subprocess.STDOUT)
            run([BIN / "python", "-m", "pip", "check"], stdout=f, stderr=subprocess.STDOUT)
        marker.write_text(digest)
    if not (SITE / "conf/settings_local.py").exists():
        if SITE.exists():
            raise RuntimeError("Incomplete site in build/site; inspect build/site-install.log before retrying.")
        print("Creating SQLite Review Board site (build/site-install.log)...", flush=True)
        with (BUILD / "site-install.log").open("w") as f:
            run([BIN / "rb-site", "install", "--noinput", "--domain-name=localhost",
                 "--allowed-host=127.0.0.1", "--site-root=/", "--db-type=sqlite3",
                 f"--db-name={SITE / 'data/reviewboard.db'}", "--cache-type=file",
                 f"--cache-info={BUILD / 'cache'}", "--web-server-port=8080",
                 "--admin-user=admin", "--admin-password=rbtflow-local",
                 "--admin-email=admin@example.invalid", "--company=RBTFlow",
                 "--opt-out-support-data", f"--sitelist={BUILD / 'sites'}", SITE],
                stdout=f, stderr=subprocess.STDOUT)
    if not (SITE / "data/reviewboard.db").exists():
        raise RuntimeError("Site database missing; inspect build/site-install.log.")
    settings = SITE / "conf/settings_local.py"
    marker_text = "\n# RBTFlow local development settings\n"
    settings.write_text(settings.read_text().split(marker_text)[0] + marker_text +
                        'DEBUG = True\nEMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"\n' +
                        '# Disposable loopback lab: integration tests create thousands of API calls.\n'
                        'API_ANONYMOUS_LIMIT_RATE = "100000/h"\nAPI_AUTHENTICATED_LIMIT_RATE = "100000/h"\n' +
                        f'STATICFILES_DIRS = [{str(SITE / "htdocs/static")!r}]\n' +
                        'STATICFILES_FINDERS = ["django.contrib.staticfiles.finders.FileSystemFinder",\n'
                        '    "django.contrib.staticfiles.finders.AppDirectoriesFinder",\n'
                        '    "djblets.extensions.staticfiles.ExtensionFinder"]\n')
    settings.chmod(0o600)
    (SITE / "data/reviewboard.db").chmod(0o600)
    create(BUILD)
    script = ROOT / "scripts/seed.py"
    with (BUILD / "seed.log").open("a") as f:
        run([BIN / "rb-site", "manage", SITE, "shell", "-c",
             f"exec(compile(open({str(script)!r}).read(), {str(script)!r}, 'exec'))"],
            stdout=f, stderr=subprocess.STDOUT)
    config = BUILD / "workspace/.reviewboardrc"
    config.write_text(f'REVIEWBOARD_URL = {URL!r}\nREPOSITORY = "RBTFlow Demo"\n'
                      'TRACKING_BRANCH = "origin/main"\nSQUASH_HISTORY = True\n'
                      'USERNAME = "admin"\nPASSWORD = "rbtflow-local"\n'
                      'SAVE_COOKIES = False\nIN_MEMORY_CACHE = True\nENABLE_PROXY = False\n')
    config.chmod(0o600)


def process_identity(pid):
    """Linux process start time prevents signaling an unrelated reused PID."""
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def running_pid():
    if not PIDFILE.exists():
        return None
    info = json.loads(PIDFILE.read_text())
    pid = info["pid"]
    if process_identity(pid) != info["start_time"]:
        return None
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if str(SITE).encode() in cmd and b"runserver" in cmd:
            return pid
    except FileNotFoundError:
        pass
    return None


def start():
    if not Path("/proc/self/stat").exists():
        raise RuntimeError("This local service launcher currently supports Linux/WSL only.")
    if running_pid():
        if api().get("stat") != "ok":
            raise RuntimeError("Service process exists but API is unhealthy; inspect build/server.log.")
        print(f"Running: {URL} (PID {running_pid()})", flush=True)
        return
    setup()
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 8080))  # Never adopt an unrelated service on this port.
    with LOG.open("a") as f:
        child = subprocess.Popen([str(BIN / "rb-site"), "manage", str(SITE), "runserver",
                                  "127.0.0.1:8080", "--noreload", "--insecure"],
                                 cwd=ROOT, env=ENV, stdout=f, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, start_new_session=True)
    PIDFILE.write_text(json.dumps({"pid": child.pid, "start_time": process_identity(child.pid)}))
    for _ in range(60):
        if child.poll() is not None:
            raise RuntimeError("Review Board exited; inspect build/server.log.")
        try:
            if api().get("stat") == "ok":
                print(f"Running: {URL} (PID {child.pid})\nLogin: admin / rbtflow-local\n"
                      "Demo workspace: build/workspace; log: build/server.log", flush=True)
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    child.terminate()
    child.wait(timeout=10)
    raise RuntimeError("API readiness timed out; inspect build/server.log.")


def stop():
    pid = running_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if running_pid() is None:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Server did not stop; inspect it before sending more signals.")
    PIDFILE.unlink(missing_ok=True)
    print("Stopped; local data preserved.")


def main():
    args = sys.argv[1:]
    action = args.pop(0) if args else "start"
    if action != "rbt" and args:
        raise RuntimeError("Only the rbt action accepts additional arguments.")
    # Serialize setup/start/stop so concurrent launches cannot duplicate a server.
    import fcntl
    BUILD.mkdir(mode=0o700, exist_ok=True)
    BUILD.chmod(0o700)
    with (BUILD / "lab.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == "setup":
            setup()
            print("Local lab ready. Run: bash dev.sh start")
        elif action == "start":
            start()
        elif action == "stop":
            stop()
        elif action == "status":
            pid = running_pid()
            if not pid or api().get("stat") != "ok":
                raise RuntimeError("Stopped or unhealthy. See build/server.log.")
            print(f"Running: {URL} (PID {pid})")
        elif action == "smoke":
            start()
            run([BIN / "python", ROOT / "scripts/smoke.py"])
        elif action == "rbt":
            if not (BIN / "rbt").exists():
                raise RuntimeError("Run bash dev.sh start first to install the lab tools.")
            run([BIN / "rbt", *args], cwd=Path.cwd())
        elif action == "logs":
            print("\n".join(LOG.read_text().splitlines()[-60:]) if LOG.exists() else "No server log yet.")
        else:
            raise RuntimeError("Usage: bash dev.sh {start|setup|stop|status|logs|smoke|rbt ...}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
