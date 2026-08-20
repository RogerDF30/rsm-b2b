#!/usr/bin/env python3
"""Copy the mapped Drive images into the repo as assets/products/<SKU>.webp.

  python3 tools/import_images.py <drive-dir> [--force]

Matches what the existing catalogue images look like: square, white background,
800px, webp. Skips a SKU that already has a file unless --force is given.
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'assets/products')
SIDE = 800


def square(im):
    im = im.convert('RGBA')
    flat = Image.new('RGB', im.size, (255, 255, 255))
    flat.paste(im, mask=im.split()[3])
    w, h = flat.size
    side = max(w, h)
    canvas = Image.new('RGB', (side, side), (255, 255, 255))
    canvas.paste(flat, ((side - w) // 2, (side - h) // 2))
    return canvas.resize((SIDE, SIDE), Image.LANCZOS)


def main():
    drive = sys.argv[1]
    force = '--force' in sys.argv
    skus = set(json.load(open(os.path.join(HERE, 'row_to_sku.json'))).values())

    by_sku = {}
    for name in os.listdir(drive):
        stem, ext = os.path.splitext(name)
        if stem in skus and ext.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
            by_sku[stem] = os.path.join(drive, name)

    missing = sorted(skus - set(by_sku))
    os.makedirs(OUT, exist_ok=True)
    written, skipped = 0, 0

    for sku, src in sorted(by_sku.items()):
        dst = os.path.join(OUT, sku + '.webp')
        if os.path.exists(dst) and not force:
            skipped += 1
            continue
        with Image.open(src) as im:
            square(im).save(dst, 'WEBP', quality=86, method=6)
        written += 1

    print(f'{written} written, {skipped} already present, {len(missing)} missing')
    if missing:
        print('no Drive file for:', ', '.join(missing))


if __name__ == '__main__':
    main()
