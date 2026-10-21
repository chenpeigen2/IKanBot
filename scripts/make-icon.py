"""
IKanBot 应用图标生成器。

设计概念
--------
「IK 字标 + 缝衣针」：字母 K 的上斜笔自然延伸、收细成一根缝衣针（服装外贸的强符号），
针身靠近 K 的一端留一个针眼（镂空）；底部一道缝线虚线，既是缝纫线迹也是单据上的文本行。
深海军蓝 → 亮一档的蓝的斜向渐变底，冷静专业。

为什么手工画字形而不用字体
--------------------------
针必须与 K 的斜笔**一气呵成**地连上。用字体渲染的 K，斜笔末端是平的、角度也不受控，
接针就会露馅。手工多边形可以精确控制每一笔的起止、宽度与方向。

输出
----
build/icon.ico     多尺寸 ICO（16~256）
build/icon_*.png    各尺寸 PNG（开发预览用）
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build")

# ---------------------------------------------------------------- 设计参数
# 全部在 1024 的逻辑坐标系里描述，最后按 SS 倍超采样绘制再降采样，得到平滑抗锯齿。
L = 1024

BG_R = 224                     # 圆角半径
INK = (255, 255, 255)         # 主体纯白
SEAM = (255, 255, 255, 46)    # 底部缝线虚线

C_TL = (0x12, 0x1E, 0x4A)     # 渐变左上（深海军蓝）
C_BR = (0x2E, 0x62, 0xE8)     # 渐变右下（亮蓝）

# 字母笔画
I_X0, I_X1 = 236, 330         # I 的左右边界
K_X0, K_X1 = 396, 490         # K 竖条的左右边界
TOP, BOT = 318, 716           # 字母上下边界

# 上斜笔（→ 延伸成针）
UP_START = (500, 520)         # 上斜笔中心线起点
UP_END = (672, 348)           # 上斜笔中心线终点（此处接针身）
UP_W0, UP_W1 = 94, 36         # 起止半宽

# 针身（沿上斜笔方向继续，与斜笔重叠一小段以免出现台阶）
NEEDLE_FROM = (648, 372)      # 起点：向斜笔内部重叠，保证接缝无缝
NEEDLE_END = (812, 208)       # 针身末端
NEEDLE_W0, NEEDLE_W1 = 36, 13
TIP = (886, 134)              # 针尖
EYE = (712, 308)              # 针眼中心（镂空）
EYE_R = 16

# 下斜笔
DN_START = (500, 520)
DN_END = (700, 700)
DN_W0, DN_W1 = 94, 34

# 底部缝线虚线
SEAM_Y = 836
SEAM_X0, SEAM_X1 = 236, 788
SEAM_DASH, SEAM_GAP, SEAM_W = 46, 46, 15


def _norm(p, q):
    """单位方向向量 + 单位法线向量"""
    dx, dy = q[0] - p[0], q[1] - p[1]
    ln = math.hypot(dx, dy) or 1.0
    ux, uy = dx / ln, dy / ln
    return (ux, uy), (-uy, ux)


def _taper(p, q, w0, w1):
    """把一条线段做成两端不同宽度的四边形（笔画收细）"""
    (ux, uy), (nx, ny) = _norm(p, q)
    a = (p[0] + nx * w0, p[1] + ny * w0)
    b = (p[0] - nx * w0, p[1] - ny * w0)
    c = (q[0] - nx * w1, q[1] - ny * w1)
    d = (q[0] + nx * w1, q[1] + ny * w1)
    return [a, b, c, d]


def draw_icon(px: int) -> Image.Image:
    """在 px×px 上绘制图标（px 通常是 1024 的整数倍，用于超采样）"""
    s = px / L
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # ---- 圆角方形底 ----
    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=int(BG_R * s), fill=(20, 30, 70, 255))

    # ---- 斜向渐变（叠在底上，用底作为 alpha 遮罩） ----
    grad = Image.new("RGBA", (px, px))
    gp = grad.load()
    # 预计算每像素的投影参数（对角线方向）
    denom = float((px - 1) * 2)
    for y in range(px):
        for x in range(px):
            t = (x + y) / denom
            t = t ** 0.92  # 稍压暗左下，让主体更靠右下
            r = int(C_TL[0] + (C_BR[0] - C_TL[0]) * t)
            g = int(C_TL[1] + (C_BR[1] - C_TL[1]) * t)
            b = int(C_TL[2] + (C_BR[2] - C_TL[2]) * t)
            gp[x, y] = (r, g, b, 255)
    img.paste(grad, (0, 0), img.split()[3])

    # ---- 左上柔光（让底有一点体积感） ----
    glow = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = int(px * 0.62)
    gd.ellipse([-gr // 2, -gr // 2, gr, gr], fill=(255, 255, 255, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(int(px * 0.10)))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # ---- 底部缝线虚线 ----
    x = SEAM_X0
    while x + SEAM_DASH <= SEAM_X1:
        d.rounded_rectangle(
            [x * s, (SEAM_Y - SEAM_W / 2) * s, (x + SEAM_DASH) * s, (SEAM_Y + SEAM_W / 2) * s],
            radius=SEAM_W * s / 2,
            fill=SEAM,
        )
        x += SEAM_DASH + SEAM_GAP

    # ---- 字母与针（纯白） ----
    def poly(pts):
        d.polygon([(p[0] * s, p[1] * s) for p in pts], fill=INK)

    # I
    d.rectangle([I_X0 * s, TOP * s, I_X1 * s, BOT * s], fill=INK)
    # K 竖条
    d.rectangle([K_X0 * s, TOP * s, K_X1 * s, BOT * s], fill=INK)
    # K 上斜笔
    poly(_taper(UP_START, UP_END, UP_W0, UP_W1))
    # K 下斜笔
    poly(_taper(DN_START, DN_END, DN_W0, DN_W1))
    # 针身（接在上斜笔末端）
    poly(_taper(NEEDLE_FROM, NEEDLE_END, NEEDLE_W0, NEEDLE_W1))
    # 针尖
    poly([
        (NEEDLE_END[0] + 7, NEEDLE_END[1] - 7),
        TIP,
        (NEEDLE_END[0] - 7, NEEDLE_END[1] + 7),
    ])

    # ---- 针眼：取该处渐变的实际颜色填回（视觉上就是透出底色）----
    ex, ey = int(EYE[0] * s), int(EYE[1] * s)
    ex = max(0, min(px - 1, ex))
    ey = max(0, min(px - 1, ey))
    d.ellipse(
        [(EYE[0] - EYE_R) * s, (EYE[1] - EYE_R) * s, (EYE[0] + EYE_R) * s, (EYE[1] + EYE_R) * s],
        fill=gp[ex, ey],
    )

    return img


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    master = draw_icon(1024)
    master.save(os.path.join(OUT, "icon_1024.png"))

    sizes = [256, 128, 64, 48, 32, 16]
    for n in sizes:
        master.resize((n, n), Image.LANCZOS).save(os.path.join(OUT, f"icon_{n}.png"))

    # ICO：Vista+ 支持 PNG 压缩的图元
    master.save(
        os.path.join(OUT, "icon.ico"),
        format="ICO",
        sizes=[(n, n) for n in sizes],
        append_images=[master.resize((n, n), Image.LANCZOS) for n in sizes],
    )
    print("icon.ico 已生成:", os.path.getsize(os.path.join(OUT, "icon.ico")), "bytes")
