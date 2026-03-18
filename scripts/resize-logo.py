#!/usr/bin/env python3
"""
Resize and optimize the new logo for all required sizes.
Usage: python scripts/resize-logo.py
Requires: pip install Pillow
"""

import os
from pathlib import Path
from PIL import Image

# Paths relative to project root
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent

SOURCE = PROJECT_ROOT / "docs" / "image-gen-design-a-square-app-icon-logo-for-canvas-notebook--1-2026-03-18T07-53-15-925Z-zvyd8rd9.jpg"

TARGETS = [
    (PROJECT_ROOT / "public" / "logo.jpg",                     512, "JPEG", {"quality": 85, "optimize": True}),
    (PROJECT_ROOT / "public" / "icons" / "icon-512.png",       512, "PNG",  {"optimize": True}),
    (PROJECT_ROOT / "public" / "icons" / "icon-192.png",       192, "PNG",  {"optimize": True}),
    (PROJECT_ROOT / "public" / "icons" / "apple-touch-icon.png", 180, "PNG", {"optimize": True}),
]


def human_size(path: Path) -> str:
    size = path.stat().st_size
    for unit in ["B", "KB", "MB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def main():
    if not SOURCE.exists():
        print(f"ERROR: Source file not found:\n  {SOURCE}")
        raise SystemExit(1)

    print(f"Source: {SOURCE.name} ({human_size(SOURCE)})")
    img = Image.open(SOURCE)
    print(f"  Dimensions: {img.width}x{img.height}, mode: {img.mode}")

    # Ensure square crop from center if not already square
    if img.width != img.height:
        side = min(img.width, img.height)
        left = (img.width - side) // 2
        top = (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side))
        print(f"  Cropped to square: {side}x{side}")

    print()
    for dest, size, fmt, save_kwargs in TARGETS:
        resized = img.resize((size, size), Image.LANCZOS)

        # JPEG requires RGB mode
        if fmt == "JPEG" and resized.mode != "RGB":
            resized = resized.convert("RGB")
        # PNG supports RGBA
        if fmt == "PNG" and resized.mode not in ("RGB", "RGBA"):
            resized = resized.convert("RGBA")

        dest.parent.mkdir(parents=True, exist_ok=True)
        resized.save(dest, format=fmt, **save_kwargs)
        print(f"  {dest.relative_to(PROJECT_ROOT)}  →  {size}x{size}  ({human_size(dest)})")

    print("\nDone.")


if __name__ == "__main__":
    main()
