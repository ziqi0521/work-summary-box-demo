"""用无头 Chrome 给演示站拍截图，供 tutorial.html 引用。

不需要 playwright —— Chrome 自带的 `--headless=new --screenshot` 就够，配
`--virtual-time-budget` 把开屏动画（1.7s 淡出 / 2.4s 消失）快进掉，否则拍到的是
一片开屏遮罩。

带 `?demo_seen=<版本号>` 是为了让 shim 提前把「最近上新」标成已读：不然每次开新
profile 截图，那个弹窗都会盖在首页上。版本号从构建产物里现读，不写死。

用法：python src/shoot.py            # 全部
      python src/shoot.py home game  # 只拍指定的几张
"""
from pathlib import Path
import http.server
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
PORT = 8731

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

# name -> (hash, 视口宽, 视口高)
SHOTS = [
    ("home",    "",         1440, 1600),
    ("confirm", "#confirm", 1440, 1100),
    ("archive", "#archive", 1440, 1100),
    ("report",  "#report",  1440, 1300),
    ("game",    "#game",    1440, 1000),
    ("profile", "#profile", 1440, 1400),
]


def find_chrome():
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            return p
    sys.exit("[shoot] 找不到 Chrome / Edge")


def latest_version():
    m = re.search(r"\{ v: '(v[\d.]+)'", (ROOT / "index.html").read_text(encoding="utf-8"))
    if not m:
        sys.exit("[shoot] 从 index.html 里读不出 CHANGELOG 版本号")
    return m.group(1)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), Quiet)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def shoot(chrome, url, out, w, h):
    profile = tempfile.mkdtemp(prefix="demo-shot-")
    try:
        cmd = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={profile}",
            f"--window-size={w},{h}",
            "--virtual-time-budget=6000",
            f"--screenshot={out}",
            url,
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=90)
        if not Path(out).exists():
            tail = (r.stderr or b"").decode("utf-8", "replace")[-400:]
            print(f"[shoot] {out.name} 失败\n{tail}")
            return False
        print(f"[shoot] {out.name}  {Path(out).stat().st_size:,} 字节")
        return True
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def main():
    want = set(sys.argv[1:])
    chrome = find_chrome()
    ver = latest_version()
    OUT.mkdir(exist_ok=True)
    httpd = serve()
    ok = True
    try:
        for name, h, w, hh in SHOTS:
            if want and name not in want:
                continue
            url = f"http://127.0.0.1:{PORT}/index.html?demo_seen={ver}{h}"
            ok &= shoot(chrome, url, OUT / f"{name}.png", w, hh)
    finally:
        httpd.shutdown()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
