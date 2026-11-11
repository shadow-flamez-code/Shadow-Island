"""Builds the Windows icon and tray assets from the Shadow Island emblem."""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EMBLEM = Image.open(ROOT / "renderer" / "emblem.png").convert("RGBA")
WORDMARK = ROOT / "renderer" / "wordmark.png"
BUILD = ROOT / ".iconbuild"
BUILD.mkdir(exist_ok=True)

print("wordmark", Image.open(WORDMARK).size, "emblem", EMBLEM.size)

SIZE = 1024
master = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# Tile: deep indigo glass so the icon still reads on a light desktop.
grad = Image.new("RGBA", (SIZE, SIZE))
draw = ImageDraw.Draw(grad)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = round(34 - 22 * t)
    g = round(20 - 14 * t)
    b = round(66 - 48 * t)
    draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))
tile_mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(tile_mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=210, fill=255)
master.paste(grad, (0, 0), tile_mask)

# Neon bloom behind the artwork.
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([90, 120, 934, 964], fill=(150, 70, 245, 150))
glow = glow.filter(ImageFilter.GaussianBlur(120))
master = Image.alpha_composite(
    master, Image.composite(glow, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), tile_mask)
)

# The emblem fills almost the whole tile so it stays readable at 16 px.
target_w = 952
target_h = round(EMBLEM.height * target_w / EMBLEM.width)
emblem = EMBLEM.resize((target_w, target_h), Image.LANCZOS)
master.alpha_composite(emblem, ((SIZE - target_w) // 2, (SIZE - target_h) // 2))

ImageDraw.Draw(master).rounded_rectangle(
    [8, 8, SIZE - 9, SIZE - 9], radius=204, outline=(196, 130, 255, 150), width=9
)

master.resize((512, 512), Image.LANCZOS).save(ROOT / "assets" / "icon.png")
master.resize((256, 256), Image.LANCZOS).save(BUILD / "icon-256.png")

# Tray: transparent emblem, as large as possible.
tray = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
tray_w = 500
tray_h = round(EMBLEM.height * tray_w / EMBLEM.width)
tray.alpha_composite(
    EMBLEM.resize((tray_w, tray_h), Image.LANCZOS), ((512 - tray_w) // 2, (512 - tray_h) // 2)
)
tray.resize((64, 64), Image.LANCZOS).save(ROOT / "assets" / "tray.png")

# Multi-resolution Windows .ico.
sizes = [16, 24, 32, 48, 64, 128, 256]
master.resize((256, 256), Image.LANCZOS).save(
    ROOT / "assets" / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes]
)
print("icons rebuilt")
