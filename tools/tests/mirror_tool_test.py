"""备用镜像发布工具的测试（tools/publish-mirror.py）。

为什么需要：
    第一次发布镜像时 30 个文件全部失败，报
        {"statusCode":"403","error":"Unauthorized","message":"Invalid Compact JWS"}
    原因是把 key 放进了 `Authorization: Bearer`。而 Supabase 官方文档明确写着：

        "Send publishable and secret keys on the `apikey` header **only**.
         If you also pass the key on the `Authorization: Bearer` header ...
         the platform tries to parse it as a JWT and rejects the request."
        "The new keys are not JWTs"

    这种"看着像认证失败、其实是密钥格式用错位置"的问题，光看代码很难发现。
    所以这里起一个**假的 HTTP 服务器**，把真正发出去的头抓下来断言 —— 测的是线上行为。

运行：python tools/tests/mirror_tool_test.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location(
    "publish_mirror", os.path.join(BASE_DIR, "tools", "publish-mirror.py")
)
_mirror = importlib.util.module_from_spec(_spec)
sys.modules["publish_mirror"] = _mirror
_spec.loader.exec_module(_mirror)

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  [通过] {name}")
    else:
        failed += 1
        print(f"  [失败] {name}" + (f" —— {detail}" if detail else ""))


# ============================== 假服务器：抓请求头 ==============================

captured: list[dict] = []


class Recorder(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # 静音
        pass

    def _record(self, method: str) -> None:
        consumed = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            consumed = self.rfile.read(length)
        captured.append(
            {
                "method": method,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": consumed,
            }
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(b'{"ok":true}')

    def do_GET(self) -> None:  # noqa: N802
        self._record("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._record("POST")


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    # 真实 Supabase 的 service_role JWT 大约 200 字符：
    #   header(36) . payload(约 120) . signature(43)
    # 测试里用接近真实长度的假值，否则会误判校验阈值
    LEGACY = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6YWZ5bWh6cWxrb2xibHVnemdwIiwicm9sZSI6"
        "InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDE1NTU1NTU1fQ."
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
    )
    NEW_SECRET = "sb_secret_abcdefghijklmnopqrstuvwxyz123456"

    try:
        print("\n一、密钥类型识别（只输出类型，不输出密钥本身）")
        check("新版机密 key 被正确识别", "机密" in _mirror.describe_key(NEW_SECRET))
        check("可发布 key 会被指出没有上传权限", "没有上传权限" in _mirror.describe_key("sb_publishable_xx"))
        check("旧版 JWT 被正确识别", "旧版 JWT" in _mirror.describe_key(LEGACY))
        check("乱填的东西会被标记为无法识别", "无法识别" in _mirror.describe_key("随便写的东西"))

        print("\n二、认证头构造（这就是出过 bug 的地方）")
        new_headers = _mirror.auth_headers(NEW_SECRET)
        check("新版密钥放在 apikey 头里", new_headers.get("apikey") == NEW_SECRET)
        check(
            "★ 新版密钥绝不能放进 Authorization（否则报 Invalid Compact JWS）",
            "Authorization" not in new_headers,
            str(sorted(new_headers.keys())),
        )

        legacy_headers = _mirror.auth_headers(LEGACY)
        check("旧版 JWT 也放进 apikey", legacy_headers.get("apikey") == LEGACY)
        check("旧版 JWT 额外放进 Authorization", legacy_headers.get("Authorization") == f"Bearer {LEGACY}")

        print("\n三、真正发出去的 HTTP 头（用假服务器抓包）")
        captured.clear()
        ok, detail = _mirror.upload(base, NEW_SECRET, "index.html", b"<html></html>", "text/html")
        check("上传请求成功", ok, detail)
        sent = captured[-1]["headers"] if captured else {}
        check("抓到了请求", bool(captured))
        check("请求头里有 apikey", sent.get("apikey") == NEW_SECRET, str(sent.get("apikey")))
        check(
            "★ 请求头里没有 Authorization（这是修复的关键）",
            "authorization" not in sent,
            f"实际发出了 authorization={sent.get('authorization')!r}",
        )
        check("请求头里带了 Content-Type", sent.get("content-type") == "text/html")
        check("请求头里带了 x-upsert（可重复发布）", sent.get("x-upsert") == "true")
        check("上传路径正确", captured[-1]["path"].endswith("/storage/v1/object/site/index.html"), captured[-1]["path"])

        captured.clear()
        _mirror.upload(base, LEGACY, "js/app.js", b"//x", "text/javascript")
        sent = captured[-1]["headers"]
        check("旧版 JWT 走 Authorization", sent.get("authorization") == f"Bearer {LEGACY}")

        print("\n四、上传前会先验证桶（避免传了 30 个文件才发现问题）")
        captured.clear()
        ok, detail, category = _mirror.check_bucket(base, NEW_SECRET)
        check("check_bucket 返回成功", ok, detail)
        check("成功时没有错误类别", category == "", repr(category))
        check(
            "check_bucket 打的是 bucket 查询接口",
            captured and "/storage/v1/bucket/site" in captured[-1]["path"],
            captured[-1]["path"] if captured else "（没有请求）",
        )

        print("\n四之二、密钥形状检查（★ 这次真实故障就卡在这里）")
        # 截图里那个值：长度 16、以 kC3vyf7d 开头 —— 根本不是 Supabase 密钥
        bad_key = "kC3vyf7dQ2mZpXr9"
        ok, message = _mirror.validate_key_shape(bad_key)
        check("16 位的乱码被拒绝", not ok)
        check("拒绝时说明了长度与前缀（便于自查）", "长度 16" in message and "kC3vyf7d" in message, message)

        check("正常的 sb_secret_ key 被接受", _mirror.validate_key_shape(NEW_SECRET)[0])
        check("正常的旧版 JWT 被接受", _mirror.validate_key_shape(LEGACY)[0])
        check("可发布 key 被拒绝并说明没有权限", not _mirror.validate_key_shape("sb_publishable_abc")[0])
        check(
            "抄了一半的 sb_secret_ 会被指出太短",
            "太短" in _mirror.validate_key_shape("sb_secret_abc")[1],
        )
        check(
            "抄了一半的 JWT 会被指出偏短",
            "偏短" in _mirror.validate_key_shape("eyJhbGci.abc.def")[1],
        )
        check(
            "项目 ID（20 位）会被拒绝 —— 它最容易和 key 搞混",
            not _mirror.validate_key_shape("xzafymhzqlkolblugzgp")[0],
        )
        check("拒绝时给出去的指引里有具体位置", "Settings → API Keys" in _mirror.KEY_HELP)

        print("\n五、key 文件的读取（允许注释、空行、BOM）")
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "key.txt")
            with open(path, "w", encoding="utf-8-sig") as handle:
                handle.write("# 这是注释\n\n   sb_secret_from_file   \n另一个不该被读到的\n")
            original = _mirror.KEY_FILE
            _mirror.KEY_FILE = path
            try:
                read_back = _mirror.read_service_key()
                check("跳过注释与空行，取第一行有效内容", read_back == "sb_secret_from_file", repr(read_back))
                check("不会读到第二行", read_back != "另一个不该被读到的")
            finally:
                _mirror.KEY_FILE = original

        print("\n六、收集要上传的文件")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.makedirs(os.path.join(temp_dir, "js", "ui"))
            for relative in ("index.html", "js/app.js", "js/ui/dom.js", "_headers"):
                with open(os.path.join(temp_dir, relative), "w", encoding="utf-8") as handle:
                    handle.write("x")
            # collect_files 固定读 DIST_DIR，所以临时把它指过去再还原
            original_dist = _mirror.DIST_DIR
            _mirror.DIST_DIR = temp_dir
            try:
                pairs = _mirror.collect_files()
            finally:
                _mirror.DIST_DIR = original_dist
            remotes = sorted(remote for _local, remote in pairs)
            check("收集到 3 个文件", len(pairs) == 3, str(remotes))
            check("跳过 Netlify 专用的 _headers", "_headers" not in remotes, str(remotes))
            check("子目录路径用 / 分隔", "js/ui/dom.js" in remotes, str(remotes))
    finally:
        server.shutdown()

    print("\n" + "=" * 52)
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 52)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
