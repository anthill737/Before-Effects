"""Generate the Before Effects icon (.ico with 16-256 px images) using only the Python standard library.

Design: a warm amber half-disc ("light falling on a surface") on a dark rounded square.
Run: python tools/launcher/make-icon.py  ->  tools/launcher/icon.ico and apps/studio/build/icon.png
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def render(size: int) -> bytes:
    """RGBA pixels, 4x4 supersampled."""
    ss = 4
    out = bytearray(size * size * 4)
    r_corner = 0.22 * size
    cx = cy = size / 2
    radius = 0.30 * size
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    # rounded square background
                    dx = max(r_corner - px, 0, px - (size - r_corner))
                    dy = max(r_corner - py, 0, py - (size - r_corner))
                    inside_bg = (dx * dx + dy * dy) <= r_corner * r_corner
                    if not inside_bg:
                        continue
                    col = (20, 23, 30)
                    d = math.hypot(px - cx, py - cy)
                    if d <= radius:
                        # left half bright amber, right half dim (the "◐" mark), soft rim
                        col = (255, 197, 107) if px < cx else (74, 58, 34)
                    elif d <= radius + 0.06 * size:
                        t = (d - radius) / (0.06 * size)
                        glow = (1 - t) * 0.35 * max(0.0, min(1.0, (cx - px) / (0.08 * size)))
                        col = tuple(int(c * (1 - glow) + a * glow) for c, a in zip(col, (255, 197, 107)))
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            i = (y * size + x) * 4
            if a > 0:
                cov = acc[3] / 255
                out[i : i + 4] = bytes([int(acc[0] / cov), int(acc[1] / cov), int(acc[2] / cov), int(a)])
    return bytes(out)


def png(size: int, rgba: bytes) -> bytes:
    raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [(s, png(s, render(s))) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    data = b""
    for s, blob in images:
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    ico = header + entries + data
    os.makedirs(os.path.join(ROOT, "tools", "launcher"), exist_ok=True)
    open(os.path.join(ROOT, "tools", "launcher", "icon.ico"), "wb").write(ico)
    os.makedirs(os.path.join(ROOT, "apps", "studio", "build"), exist_ok=True)
    open(os.path.join(ROOT, "apps", "studio", "build", "icon.ico"), "wb").write(ico)
    open(os.path.join(ROOT, "apps", "studio", "build", "icon.png"), "wb").write(images[-1][1])
    print("wrote icon.ico", len(ico), "bytes")


if __name__ == "__main__":
    main()
