"""Turns the raw preview captures into clean, presentation-ready shots.

Each capture is cropped to the artwork, framed with a soft neon bloom and
written into docs/screenshots/.
"""

from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
SHOTS = ROOT / "docs" / "screenshots"

# The panel sits at (60, 8) with a size of 700 x 552 inside the 820 x 660
# preview window; the capsule is centred at the top of the window.
PANEL = (60, 8, 760, 560)

PLAN = {
    # name -> (output, crop mode, margin, bloom tint, bloom strength)
    "idle": ("idle-capsule.png", "capsule", 30, (168, 85, 247), 150),
    "compact": ("media-capsule.png", "capsule", 30, (168, 85, 247), 150),
    "now": ("now.png", "panel", 26, (124, 58, 237), 90),
    "system": ("core.png", "panel", 26, (124, 58, 237), 90),
    "tools": ("tools.png", "panel", 26, (124, 58, 237), 90),
    "live": ("pulse.png", "panel", 26, (124, 58, 237), 90),
    "link": ("link.png", "panel", 26, (34, 211, 238), 90),
    "settings": ("config.png", "panel", 26, (168, 85, 247), 90),
}

# Width of the resting capsule per preview mode.
CAPSULE_WIDTH = {"idle": 240, "compact": 300}


def crop_for(kind: str, key: str, margin: int):
    image = Image.open(SHOTS / f"raw-{key}.png").convert("RGBA")
    if kind == "panel":
        left, top, right, bottom = PANEL
    else:
        width = CAPSULE_WIDTH.get(key, 256)
        centre = image.width / 2
        left = int(centre - width / 2)
        right = int(centre + width / 2)
        top = 10
        bottom = 10 + 42
    box = (
        max(0, left - margin),
        max(0, top - margin),
        min(image.width, right + margin),
        min(image.height, bottom + margin),
    )
    return image.crop(box)


def polish(key: str, output: str, kind: str, margin: int, tint, strength: int) -> None:
    art = crop_for(kind, key, margin)
    alpha = art.split()[3]

    bloom = Image.new("RGBA", art.size, (0, 0, 0, 0))
    layer = Image.new("RGBA", art.size, tint + (strength,))
    bloom.paste(layer, (0, 0), alpha)
    bloom = bloom.filter(ImageFilter.GaussianBlur(max(10, margin // 2 + 8)))

    out = Image.alpha_composite(bloom, art)
    out.save(SHOTS / output, optimize=True)
    print(f"{output}: {out.width}x{out.height}")


def main() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    for key, (output, kind, margin, tint, strength) in PLAN.items():
        if not (SHOTS / f"raw-{key}.png").exists():
            print(f"missing raw-{key}.png")
            continue
        polish(key, output, kind, margin, tint, strength)


if __name__ == "__main__":
    main()

