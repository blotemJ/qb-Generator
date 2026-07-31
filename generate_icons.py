# -*- coding: utf-8 -*-
"""为题库生成器扩展生成 PNG 图标（16/48/128）。"""
from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(BASE, "icons")
os.makedirs(ICON_DIR, exist_ok=True)

# 找系统中文字体
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]
FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)


def draw_icon(size, path):
    # 背景渐变（蓝紫）
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    top = (59, 91, 255)
    bottom = (122, 91, 255)
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (size, y)], fill=color)
    # 圆角卡片（白色半透明）
    pad = int(size * 0.10)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=int(size * 0.18), fill=(255, 255, 255, 235))
    # 中央 "题" 字
    if FONT_PATH:
        font = ImageFont.truetype(FONT_PATH, int(size * 0.52))
        bbox = d.textbbox((0, 0), "题", font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]), "题", font=font, fill=(59, 91, 255, 255))
    img.save(path, "PNG")


for s in (16, 48, 128):
    draw_icon(s, os.path.join(ICON_DIR, f"icon{s}.png"))
    print(f"icon{s}.png 已生成")
