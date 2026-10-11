"""班级公告栏 —— 本地服务器入口。

一条命令同时提供：
  1. 静态页面（web/ 目录，就是最终要上传到公网的那份文件）
  2. 与 Supabase 完全相同的接口（/auth/v1、/rest/v1）

用法：
    python serve.py                 # 只允许本机访问
    python serve.py --lan           # 允许同网络中同学用手机访问，并打印网址
    python serve.py --port 9000     # 换端口
    python serve.py --seed          # 首次启动时插入两条示例公告

不需要安装任何第三方库，Python 3.10+ 标准库即可运行。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from server import db
from server.local_api import LocalAPI
from server.security import SecurityGuard
from server.static_site import StaticSite

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
CONFIG_PATH = os.path.join(BASE_DIR, "local_config.json")
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "server", "class_bulletin.db")
# IP 黑名单：只在本机，永久封禁的记录靠它保存
BLACKLIST_PATH = os.path.join(BASE_DIR, "server", "ip_blacklist.json")


# 安全防护管理页。内嵌在这里而不是放到 web/ 目录：
#   · web/ 下的文件会被打包上传到公网，而这个页面不该出现在公网上
#   · 页面逻辑很短，放一起更容易看懂"它和黑名单是一体的"
SECURITY_PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>安全防护 · 本机专用</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f3f4f7; color: #16181d; font-size: 15px; line-height: 1.6;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0e1014; color: #eef1f6; }
    .card { background: #161920 !important; border-color: #262b34 !important; }
    .muted { color: #98a1af !important; }
    table { color: inherit; }
    th, td { border-color: #262b34 !important; }
    code { background: #1b1f27 !important; }
    button { background: #1b1f27 !important; color: #eef1f6 !important; border-color: #343b47 !important; }
    button.primary { background: #7aa7ff !important; color: #0b1220 !important; border-color: #7aa7ff !important; }
    button.danger { color: #ff8f86 !important; border-color: #ff8f86 !important; }
  }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .muted { color: #666f7d; font-size: 13px; }
  .banner {
    margin: 16px 0; padding: 12px 16px; border-radius: 10px;
    background: #fdf1d8; color: #9a5b00; border: 1px solid #9a5b00; font-size: 14px;
  }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
  .stat {
    flex: 1 1 140px; padding: 14px 16px; border-radius: 12px;
    background: #fff; border: 1px solid #e5e8ee;
  }
  .stat b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
  .card {
    background: #fff; border: 1px solid #e5e8ee; border-radius: 12px;
    padding: 16px; margin-bottom: 16px;
  }
  h2 { font-size: 15px; margin: 0 0 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #666f7d; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  th { font-size: 12px; color: #666f7d; font-weight: 600; }
  code { background: #f7f8fa; padding: 1px 5px; border-radius: 5px; font-size: 13px; }
  button {
    min-height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer;
    background: #fff; color: inherit; border: 1px solid #e5e8ee; font: inherit; font-size: 13px;
  }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.danger { color: #b3261e; border-color: #b3261e; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .tag.ban { background: #b3261e; color: #fff; }
  .tag.lock { background: #fdf1d8; color: #9a5b00; }
  .tag.ok { background: #e3f6ee; color: #0a6c4a; }
  .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  input {
    min-height: 36px; padding: 4px 10px; border-radius: 8px;
    border: 1px solid #e5e8ee; background: #fff; color: inherit; font: inherit;
  }
  .manual { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .events { font-size: 12px; color: #666f7d; }
</style>
</head>
<body>
<div class="wrap">
  <h1>安全防护 · 本机专用</h1>
  <p class="muted">这个页面只有在这台电脑上（127.0.0.1）才能打开，同学手机上访问会得到 404。</p>

  <div class="banner">
    <b>防护范围说明：</b>这里的按 IP 锁定与风控，保护的是<b>本地服务器</b>
    （<code>python serve.py</code> / <code>启动本地预览.bat</code> 起的那个）。<br>
    公网上的 Netlify 静态页面没有服务器，无法按 IP 拦截 ——
    那边的防线是 Supabase 的登录频率限制与验证码，见 <code>安全设置.md</code>。
  </div>

  <div class="stats" id="stats"></div>

  <div class="card">
    <h2>当前策略</h2>
    <p class="muted" id="policy"></p>
    <p class="muted">永久封禁记录保存在 <code>server/ip_blacklist.json</code>，
      你也可以直接编辑那个文件（改完重启服务器生效）。</p>
  </div>

  <div class="card">
    <h2>IP 名单</h2>
    <div id="list"></div>
  </div>

  <div class="card">
    <h2>手动加入黑名单</h2>
    <div class="manual">
      <input id="manual-ip" placeholder="IP 地址，例如 192.168.1.50" size="26" />
      <input id="manual-reason" placeholder="原因（可留空）" size="24" />
      <button class="danger" onclick="manualBlock(true)">永久封禁</button>
      <button onclick="manualBlock(false)">锁定 30 分钟</button>
    </div>
    <p class="muted" style="margin-top:10px">
      提示：家用宽带重播号后 IP 会变，所以封 IP 是"止血"手段，不是根治。
      真正的根治办法是换一个强密码（见 <code>安全设置.md</code>）。
    </p>
  </div>
</div>

<script>
const fmtTime = (seconds) => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN') : '—';
const fmtLeft = (seconds) => {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
};

async function load() {
  const data = await (await fetch('/security/api')).json();
  document.getElementById('stats').innerHTML = `
    <div class="stat"><b>${data.total}</b><span class="muted">名单里的 IP</span></div>
    <div class="stat"><b>${data.banned}</b><span class="muted">永久封禁</span></div>
    <div class="stat"><b>${data.locked}</b><span class="muted">锁定中</span></div>`;
  document.getElementById('policy').textContent =
    `连续失败满 ${data.policy.fail_threshold} 次开始锁定；锁定时长为 ` +
    `${data.policy.base_lock_minutes} 分钟的整数倍；` +
    `失败超过 ${data.policy.hard_fail_limit} 次永久封禁；` +
    `风控风险分达到 ${data.policy.risk_limit} 永久封禁。`;

  const rows = data.records || [];
  if (!rows.length) {
    document.getElementById('list').innerHTML = '<p class="muted">名单是空的，一切正常。</p>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
      <th>IP</th><th>状态</th><th>失败</th><th>风险分</th><th>原因</th><th>最近活动</th><th>操作</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const item of rows) {
    const tag = item.permanent
      ? '<span class="tag ban">永久封禁</span>'
      : (item.locked ? `<span class="tag lock">锁定 ${fmtLeft(item.unlock_in_seconds)}</span>`
                     : '<span class="tag ok">正常</span>');
    const events = (item.events || []).slice(-3).map((e) =>
      `<div>${fmtTime(e.at)} ${e.kind}：${(e.detail || '').replace(/</g, '&lt;')}</div>`).join('');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code></code></td>
      <td>${tag}</td>
      <td>${item.failures || 0}</td>
      <td>${item.risk || 0}</td>
      <td>${(item.reason || '—').replace(/</g, '&lt;')}</td>
      <td>${fmtTime(item.last_seen)}<div class="events">${events}</div></td>
      <td><div class="row-actions">
        <button class="primary" data-act="unblock">解封</button>
        <button data-act="forget">删除记录</button>
      </div></td>`;
    tr.querySelector('code').textContent = item.ip;
    tr.querySelector('[data-act="unblock"]').onclick = () => act('unblock', item.ip);
    tr.querySelector('[data-act="forget"]').onclick = () => act('forget', item.ip);
    tbody.append(tr);
  }

  const host = document.getElementById('list');
  host.innerHTML = '';
  host.append(table);
}

async function act(action, ip, extra) {
  const response = await fetch('/security/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ip, ...(extra || {}) }),
  });
  const result = await response.json();
  alert(result.message || '完成');
  load();
}

function manualBlock(permanent) {
  const ip = document.getElementById('manual-ip').value.trim();
  if (!ip) { alert('请填 IP'); return; }
  act('block', ip, {
    permanent,
    minutes: 30,
    reason: document.getElementById('manual-reason').value.trim() || '管理员手动封禁',
  });
}

load();
setInterval(load, 5000);
</script>
</body>
</html>
"""

DEFAULT_ADMIN_EMAIL = "admin@class.local"


def _prepare_stdout() -> None:
    """输出被重定向（管道/文件）时统一按 UTF-8 写，避免中文变乱码。

    直接开在真实控制台时不动它 —— Windows 控制台有自己的中文处理方式。
    """
    if sys.stdout.isatty():
        return
    try:
        # line_buffering：输出被重定向时也要立刻看到日志，而不是攒满一块才出现
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, OSError):
        pass


def out(text: str = "") -> None:
    """打印一行日志；遇到控制台编码不支持中文时自动降级，不让程序崩掉。"""
    try:
        print(text)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        print(text.encode(encoding, "replace").decode(encoding, "replace"))


def load_config(path: str) -> dict[str, Any]:
    """读取 local_config.json；不存在时就生成一份带随机口令的配置。"""
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    config = {
        "admin_email": DEFAULT_ADMIN_EMAIL,
        "admin_password": secrets.token_urlsafe(9),
        "db_path": os.path.relpath(DEFAULT_DB_PATH, BASE_DIR).replace("\\", "/"),
        "_说明": "这是本地服务器使用的管理员账号。修改后重启 serve.py 生效。",
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
    out(f"[配置] 已生成 {os.path.basename(path)}")
    out(f"[配置] 管理员邮箱：{config['admin_email']}")
    out(f"[配置] 初始口令：  {config['admin_password']}   （请尽快修改）")
    out()
    return config


def _windows_adapter_ips() -> list[str]:
    """在 Windows 上再把所有网卡的 IPv4 地址捞一遍。

    只靠"默认路由"那一个地址在装了 WSL / Docker / VPN / 虚拟机时会选错网卡，
    同学就连不上。这里用一个不依赖语言的简单办法：把 ipconfig 输出里
    所有 IPv4 形状的地址抓出来，再去掉回环和自动地址。
    """
    if os.name != "nt":
        return []
    try:
        completed = subprocess.run(
            ["ipconfig"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return re.findall(r"(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])", completed.stdout or "")


def _is_netmask(address: str) -> bool:
    """判断这个地址是不是"子网掩码"（ipconfig 里也会出现 255.255.255.0 这种）。

    掩码的二进制一定是连续的 1 后跟连续的 0，主机地址不会长这样，
    所以这个判断不依赖系统语言，中英文 Windows 都可靠。
    顺带也把 0.0.0.0 和 255.255.255.255 一起排除掉了。
    """
    try:
        octets = [int(part) for part in address.split(".")]
    except ValueError:
        return False
    if len(octets) != 4 or any(part > 255 for part in octets):
        return False

    value = 0
    for part in octets:
        value = (value << 8) | part
    inverted = value ^ 0xFFFFFFFF
    return (inverted & (inverted + 1)) == 0


def _is_usable_host(address: str) -> bool:
    """筛掉明显不可能被同学访问的地址。"""
    try:
        octets = [int(part) for part in address.split(".")]
    except ValueError:
        return False
    if len(octets) != 4 or any(part < 0 or part > 255 for part in octets):
        return False

    first = octets[0]
    if first == 0 or first == 127 or first >= 224:  # 保留 / 回环 / 组播
        return False
    if first == 169 and octets[1] == 254:  # 没拿到 DHCP 时的自动地址
        return False
    return not _is_netmask(address)


def _is_local_address(address: str) -> bool:
    """这个地址真的属于本机吗？

    ipconfig 的输出里除了本机地址，还有网关、DHCP 服务器、DNS 服务器的地址；
    照着它们去访问只会连不上。最简单的验证办法是把它绑到 socket 上：
    只有本机自己的地址才绑得上，别人的地址会直接报错。
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((address, 0))
        return True
    except OSError:
        return False


def local_ips() -> list[str]:
    """本机可能被同学访问到的局域网地址（可能不止一个）。

    只取一个地址并不可靠：装了 WSL、Docker、VPN 或虚拟机时，
    "默认路由"指向的可能不是 Wi-Fi 网卡。所以这里把所有候选地址
    都列出来，并逐个验证"确实是本机地址"，让使用者自己试。
    """
    candidates: list[str] = []
    route_address = ""

    # 默认路由对应的地址：通常就是 Wi-Fi / 有线网卡的地址
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            route_address = probe.getsockname()[0]
            candidates.append(route_address)
    except OSError:
        pass

    # 再看主机名能解析出的其它地址（多网卡时会有多个）
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass

    candidates.extend(_windows_adapter_ips())

    result: list[str] = []
    for address in candidates:
        if not _is_usable_host(address):
            continue
        if not _is_local_address(address):
            # 网关 / DHCP 服务器 / DNS 地址会走到这里，必须排除
            continue
        if address not in result:
            result.append(address)

    if result:
        return result[:5]
    # 兜底：全部验证失败时，至少给出默认路由那个地址
    if route_address and _is_usable_host(route_address):
        return [route_address]
    return ["127.0.0.1"]


def make_handler(api: LocalAPI, site: StaticSite, quiet: bool):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ClassBulletin/1.0"
        protocol_version = "HTTP/1.1"

        # ---------- 日志 ----------

        def log_message(self, fmt: str, *args: Any) -> None:
            if not quiet:
                out(f"  {self.address_string()} {fmt % args}")

        # ---------- 各 HTTP 方法 ----------

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_HEAD(self) -> None:  # noqa: N802
            self._dispatch("HEAD")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_PATCH(self) -> None:  # noqa: N802
            self._dispatch("PATCH")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self._send(204, None, {})

        # ---------- 路由 ----------

        def _client_ip(self) -> str:
            """来访者的 IP。

            本地服务器直接和浏览器说话，所以 socket 上的地址就是真实地址
            （不像公网那样藏在代理后面）。这也是"按 IP 封禁"能真正生效的原因。
            """
            return self.client_address[0] if self.client_address else "127.0.0.1"

        def _is_local_request(self) -> bool:
            """是不是"这台电脑自己"发来的请求。

            黑名单管理页只允许本机打开：即使你用 --lan 让同学能访问，
            他们在手机上也看不到、动不了这份名单。
            """
            return self._client_ip() in ("127.0.0.1", "::1")

        def _dispatch(self, method: str) -> None:
            parsed = urlparse(self.path)
            path = parsed.path

            # 同源 API 前缀 /api/*。
            #
            # 为什么要统一这个前缀：公网主站（Cloudflare Pages）上，
            # /api/* 由 functions/api/[[path]].js 转发到 Supabase；
            # 而 *.supabase.co 在中国移动上会被 ERR_CONNECTION_RESET，
            # 走同源代理就绕开了。本地预览没有那个 Function，
            # 所以这里把 /api 剥掉，交给同一个接口层处理 ——
            # 这样 config.js 只需要填一个 /api，三种环境都通。
            if path.startswith("/api/"):
                path = path[len("/api"):]

            # 安全防护管理页：只有本机能访问，其它来源直接当作不存在
            if path.rstrip("/") in ("/security", "/security.html"):
                if not self._is_local_request():
                    self._send_json(404, {"message": "Not found"}, {})
                    return
                self._send_security_page()
                return

            if path.rstrip("/") == "/security/api":
                if not self._is_local_request():
                    self._send_json(404, {"message": "Not found"}, {})
                    return
                self._handle_security_api(method)
                return

            if LocalAPI.owns(path):
                body = self._read_body()
                if body is None:
                    return
                query = parse_qs(parsed.query)
                status, payload, extra = api.handle(
                    method, path, query, self._headers(), body, self._client_ip()
                )
                self._send_json(status, payload, extra)
                return

            # ★ 静态文件请求也要过风控。
            #   扫描器最爱打的就是 /.env、/.git/config、/wp-admin 这类路径，
            #   而它们既不是 /auth 也不是 /rest —— 只在接口层拦会全部漏掉。
            blocked = api.screen_request(
                method, path, parsed.query, b"", self._client_ip()
            )
            if blocked is not None:
                status, payload, extra = blocked
                self._send_json(status, payload, extra)
                return

            if method in ("GET", "HEAD"):
                status = self._send_static(path, include_body=method == "GET")
                api.record_status(self._client_ip(), status)
                return

            self._send_json(405, {"message": "Method not allowed"}, {})

        # ---------- 工具 ----------

        def _headers(self) -> dict[str, str]:
            return {key.lower(): value for key, value in self.headers.items()}

        def _read_body(self) -> bytes | None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0:
                return b""
            if length > 1024 * 1024:
                self._send_json(413, {"message": "请求体过大"}, {})
                return None
            return self.rfile.read(length)

        def _send_json(self, status: int, payload: Any, extra: dict[str, str]) -> None:
            if status == 204 or payload is None:
                self._send(status, None, extra)
                return
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers = {"Content-Type": "application/json; charset=utf-8", **extra}
            self._send(status, body, headers)

        # ---------- 安全防护管理页（只有本机能访问） ----------

        def _send_security_page(self) -> None:
            body = SECURITY_PAGE_HTML.encode("utf-8")
            self._send(
                200,
                body,
                {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                },
                content_length=len(body),
            )

        def _handle_security_api(self, method: str) -> None:
            """黑名单的读与改。整条路径都只有 127.0.0.1 能到达。"""
            if method == "GET":
                self._send_json(200, api.guard.snapshot(), {})
                return

            if method != "POST":
                self._send_json(405, {"message": "Method not allowed"}, {})
                return

            body = self._read_body()
            if body is None:
                return
            try:
                payload = json.loads(body.decode("utf-8")) if body else {}
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"message": "请求体不是合法的 JSON"}, {})
                return

            action = str(payload.get("action", ""))
            ip = str(payload.get("ip", "")).strip()

            if action == "unblock":
                if not ip:
                    self._send_json(400, {"message": "缺少 ip"}, {})
                    return
                ok = api.guard.unblock(ip)
                self._send_json(
                    200,
                    {"ok": ok, "message": f"已解除 {ip} 的封禁" if ok else f"名单里没有 {ip}"},
                    {},
                )
                return

            if action == "block":
                if not ip:
                    self._send_json(400, {"message": "缺少 ip"}, {})
                    return
                reason = str(payload.get("reason", "")).strip() or "管理员手动封禁"
                permanent = bool(payload.get("permanent", True))
                minutes = int(payload.get("minutes", 30) or 30)
                api.guard.block(ip, reason, permanent=permanent, minutes=minutes)
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "message": f"已{'永久封禁' if permanent else f'锁定 {minutes} 分钟'} {ip}",
                    },
                    {},
                )
                return

            if action == "forget":
                if not ip:
                    self._send_json(400, {"message": "缺少 ip"}, {})
                    return
                ok = api.guard.forget(ip)
                self._send_json(
                    200,
                    {"ok": ok, "message": f"已从记录里删除 {ip}" if ok else f"名单里没有 {ip}"},
                    {},
                )
                return

            self._send_json(400, {"message": f"不认识的操作：{action}"}, {})

        def _send_static(self, path: str, include_body: bool) -> int:
            """返回 HTTP 状态码，调用方据此记录 404（扫描器特征）。"""
            fs_path = site.resolve(path)
            if fs_path is None:
                # 页面不存在时给一个明确的 404，而不是浏览器默认页
                self._send_json(404, {"message": f"找不到 {path}"}, {})
                return 404
            body = site.read(fs_path)
            headers = {
                "Content-Type": StaticSite.content_type(fs_path),
                # 关掉缓存：改完 CSS/JS 刷新就能看到，方便后续反复修改
                "Cache-Control": "no-cache, no-store, must-revalidate",
            }
            self._send(200, body if include_body else None, headers, content_length=len(body))
            return 200

        def _send(
            self,
            status: int,
            body: bytes | None,
            headers: dict[str, str],
            content_length: int | None = None,
        ) -> None:
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            # 204 按规范不能带 Content-Length
            if status != 204:
                length = content_length if content_length is not None else (
                    len(body) if body else 0
                )
                self.send_header("Content-Length", str(length))
            self.end_headers()
            if body and status != 204:
                self.wfile.write(body)

    return Handler


def main() -> int:
    _prepare_stdout()
    parser = argparse.ArgumentParser(
        description="班级公告栏本地服务器（静态页面 + Supabase 兼容接口）"
    )
    parser.add_argument("--port", type=int, default=8787, help="端口，默认 8787")
    parser.add_argument(
        "--lan", action="store_true", help="允许同网络的其他设备访问（同学用手机看）"
    )
    parser.add_argument("--config", default=CONFIG_PATH, help="配置文件路径")
    parser.add_argument("--db", default=None, help="数据库文件路径（默认读配置）")
    parser.add_argument("--seed", action="store_true", help="插入示例公告")
    parser.add_argument("--quiet", action="store_true", help="不打印每条请求日志")
    args = parser.parse_args()

    config = load_config(args.config)

    db_path = args.db or config.get("db_path") or DEFAULT_DB_PATH
    if not os.path.isabs(db_path):
        db_path = os.path.join(BASE_DIR, db_path)

    if not os.path.isdir(WEB_DIR):
        out(f"[错误] 找不到网页目录：{WEB_DIR}")
        return 1

    conn = db.connect(db_path)
    if args.seed:
        inserted = db.seed_demo(conn)
        if inserted:
            out(f"[数据] 已插入 {inserted} 条示例公告")

    api = LocalAPI(
        conn,
        admin_email=config.get("admin_email", DEFAULT_ADMIN_EMAIL),
        admin_password=config.get("admin_password", ""),
        guard=SecurityGuard(BLACKLIST_PATH),
    )
    site = StaticSite(WEB_DIR)
    handler = make_handler(api, site, args.quiet)

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        httpd = ThreadingHTTPServer((host, args.port), handler)
    except OSError as exc:
        out(f"[错误] 无法监听 {host}:{args.port} —— {exc}")
        out("       端口可能已被占用，可换一个：python serve.py --port 8788")
        return 1

    machine_url = f"http://127.0.0.1:{args.port}"
    out()
    out("=" * 56)
    out("  班级公告栏 已启动")
    out("=" * 56)
    out(f"  同学看的页面：{machine_url}/")
    out(f"  你自己管理页：{machine_url}/admin.html")
    if args.lan:
        addresses = local_ips()
        out("  把这个网址发到班级群里给同学：")
        for address in addresses:
            out(f"    http://{address}:{args.port}/")
        if len(addresses) > 1:
            out("    （有多个地址时，哪个能打开就用哪个）")
        out("  同学那边注意三件事：")
        out("    1. 别用 127.0.0.1 —— 那指的是手机自己，会显示「拒绝连接」")
        out("    2. 手机必须连同一个 Wi-Fi；用流量（5G/4G）打不开局域网地址")
        out("    3. 首次访问若被防火墙拦住，请允许 Python 通过")
    else:
        out("  目前只允许本机访问。要让同学访问，请用：python serve.py --lan")
    out(f"  管理员邮箱：{config.get('admin_email', DEFAULT_ADMIN_EMAIL)}")
    out("  按 Ctrl+C 停止")
    out("=" * 56)
    out()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        out("\n[停止] 服务器已关闭")
    finally:
        httpd.server_close()
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
