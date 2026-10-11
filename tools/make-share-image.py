"""生成分享卡片用的 PNG（微信/QQ 的链接卡片会挑一张图当缩略图）。

为什么要这个文件：
    微信、QQ 在聊天里生成链接卡片时，很看重页面里的图片。
    我们以前只有 favicon.svg —— 而微信对 SVG 支持不好，等于没有图。
    所以这里把它转成一张真正的 PNG。

为什么手写而不是用图片库：
    本项目刻意零第三方依赖（连 Word 文档都是手写 OOXML）。
    PNG 的结构其实很简单：签名 + IHDR + IDAT + IEND，
    像素数据用 zlib 压缩即可 —— 标准库都有。

跑一次就够，产物是 web/assets/share.png（已提交进仓库）：
    python tools/make-share-image.py
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(BASE_DIR, "web", "assets", "share.png")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

# 与 favicon.svg 一致
BRAND = (0x25, 0x63, 0xEB)  # #2563eb
WHITE = (255, 255, 255)

SIZE = 512


def coverage(
    x: float, y: float, width: float, height: float, radius: float, px: int, py: int, samples: int = 2
) -> float:
    """这个像素被"圆角矩形"覆盖的比例（0~1）。

    用 2×2 超采样做抗锯齿，避免圆角出现锯齿。

    ★ 圆角的标准做法：把点"夹"到内部那个矩形（圆心矩形）上，
      再算到夹取点的距离是否 <= 半径。
      我第一版自己发明的角判断写错了 —— 图看起来被切掉一大块，
      所以这里改成这个通用写法。
    """
    hits = 0
    total = samples * samples
    for sx in range(samples):
        for sy in range(samples):
            fx = px + (sx + 0.5) / samples
            fy = py + (sy + 0.5) / samples
            # 夹到圆心矩形的范围内
            cx = min(max(fx, x + radius), x + width - radius)
            cy = min(max(fy, y + radius), y + height - radius)
            if (fx - cx) ** 2 + (fy - cy) ** 2 <= radius * radius:
                hits += 1
    return hits / total


def mix(base: tuple[int, int, int], over: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    """把 over 以 alpha 叠在 base 上（和 SVG 的 opacity 一个意思）。"""
    if alpha <= 0:
        return base
    if alpha >= 1:
        return over
    return tuple(round(base[i] * (1 - alpha) + over[i] * alpha) for i in range(3))  # type: ignore[return-value]


def build_pixels() -> list[list[tuple[int, int, int]]]:
    """按 favicon.svg 的构图放大到 SIZE×SIZE（原图 64×64，所以放大 8 倍）。"""
    scale = SIZE / 64
    # (x, y, w, h, rx, opacity) —— 直接照抄 favicon.svg 里的四条白杠
    bars = [
        (16, 14, 32, 6, 3, 0.95),
        (16, 27, 32, 5, 2.5, 0.8),
        (16, 38, 24, 5, 2.5, 0.8),
        (16, 49, 14, 5, 2.5, 0.55),
    ]
    scaled_bars = [
        (bx * scale, by * scale, bw * scale, bh * scale, br * scale, opacity)
        for bx, by, bw, bh, br, opacity in bars
    ]

    rows: list[list[tuple[int, int, int]]] = []
    for py in range(SIZE):
        row: list[tuple[int, int, int]] = []
        for px in range(SIZE):
            # 底：白色 → 叠上圆角蓝色方块
            color = mix((255, 255, 255), BRAND, coverage(0, 0, SIZE, SIZE, 14 * scale, px, py))

            # 再叠四条白杠（先按包围盒粗筛，省掉大量无用的距离计算）
            for bx, by, bw, bh, br, opacity in scaled_bars:
                if not (bx - 2 <= px <= bx + bw + 2 and by - 2 <= py <= by + bh + 2):
                    continue
                color = mix(color, WHITE, coverage(bx, by, bw, bh, br, px, py) * opacity)
            row.append(color)
        rows.append(row)
    return rows


def chunk(tag: bytes, data: bytes) -> bytes:
    """PNG 的一个数据块：长度 + 类型 + 数据 + CRC32。"""
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, rows: list[list[tuple[int, int, int]]]) -> None:
    height = len(rows)
    width = len(rows[0])

    # 每行前面加一个过滤字节 0（表示"不过滤"）
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for red, green, blue in row:
            raw.extend((red, green, blue))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8 位、真彩色 RGB

    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", ihdr))
        handle.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        handle.write(chunk(b"IEND", b""))


def main() -> int:
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    write_png(OUT_PATH, build_pixels())

    size = os.path.getsize(OUT_PATH)
    with open(OUT_PATH, "rb") as handle:
        head = handle.read(8)

    ok_signature = head == b"\x89PNG\r\n\x1a\n"
    print(f"  已生成 {os.path.relpath(OUT_PATH, BASE_DIR)}")
    print(f"  尺寸 {SIZE}×{SIZE}　大小 {size} 字节")
    print(f"  PNG 签名正确：{'是' if ok_signature else '否'}")

    if not ok_signature or size < 200:
        print("  [失败] 生成的文件不像有效 PNG")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
