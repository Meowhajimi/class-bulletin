"""静态文件服务：把 `web/` 目录用正确的 MIME 类型提供给浏览器。

`.js` 必须是 `text/javascript`，否则浏览器的 ES module 会拒绝加载，
这是本地调试时最常见的坑，所以这里显式写死映射表。
"""

from __future__ import annotations

import os
from urllib.parse import unquote

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
}

DEFAULT_FILE = "index.html"


class StaticSite:
    """把一个目录当作网站根目录，并把 URL 路径安全地映射到文件。"""

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)

    def resolve(self, url_path: str) -> str | None:
        """返回磁盘上的绝对路径；路径越界或文件不存在时返回 None。

        支持 `/` → index.html、`/admin` → admin.html 这类简写。
        """
        relative = unquote(url_path).lstrip("/\\") or DEFAULT_FILE
        candidate = os.path.abspath(os.path.join(self.root, relative))

        if not self._inside(candidate):
            return None
        if os.path.isdir(candidate):
            candidate = os.path.join(candidate, DEFAULT_FILE)
        if not os.path.isfile(candidate) and not candidate.endswith(".html"):
            with_suffix = candidate + ".html"
            if self._inside(with_suffix) and os.path.isfile(with_suffix):
                candidate = with_suffix

        if os.path.isfile(candidate) and self._inside(candidate):
            return candidate
        return None

    def _inside(self, path: str) -> bool:
        try:
            return os.path.commonpath([self.root, path]) == self.root
        except ValueError:
            # 不同盘符等情况
            return False

    @staticmethod
    def content_type(path: str) -> str:
        extension = os.path.splitext(path)[1].lower()
        return MIME_TYPES.get(extension, "application/octet-stream")

    @staticmethod
    def read(path: str) -> bytes:
        with open(path, "rb") as handle:
            return handle.read()
