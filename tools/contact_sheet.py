#!/usr/bin/env python3
"""Build a labelled contact sheet so a set of images can be eyeballed at once.

  python3 tools/contact_sheet.py out.jpg <dir-or-xlsx> [cols]

Given a directory it tiles every image, captioned with the file name. Given the
Sujith workbook it tiles the mockups embedded in column B, captioned with the
row number, so the two sheets can be compared side by side.
"""
import io
import os
import sys

from PIL import Image, ImageDraw

CELL = 190
PAD = 6
LABEL = 16


def load(source):
    if source.lower().endswith('.xlsx'):
        import openpyxl
        ws = openpyxl.load_workbook(source)['Sheet12']
        for img in sorted(ws._images, key=lambda i: i.anchor._from.row):
            yield f'row {img.anchor._from.row + 1}', Image.open(io.BytesIO(img._data()))
        return
    for name in sorted(os.listdir(source)):
        if os.path.splitext(name)[1].lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
            yield os.path.splitext(name)[0].replace('B2BRSMON-', ''), \
                Image.open(os.path.join(source, name))


def main():
    out, source = sys.argv[1], sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 8

    items = list(load(source))
    rows = (len(items) + cols - 1) // cols
    step = CELL + PAD * 2 + LABEL
    sheet = Image.new('RGB', (cols * step, rows * step), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)

    for i, (label, im) in enumerate(items):
        x, y = (i % cols) * step, (i // cols) * step
        thumb = im.convert('RGB')
        thumb.thumbnail((CELL, CELL), Image.LANCZOS)
        sheet.paste(thumb, (x + PAD + (CELL - thumb.width) // 2,
                            y + PAD + (CELL - thumb.height) // 2))
        draw.text((x + PAD, y + PAD + CELL + 2), label, fill=(0, 0, 0))
        draw.rectangle([x, y, x + step - 1, y + step - 1], outline=(210, 210, 210))

    sheet.save(out, quality=88)
    print(f'{len(items)} images -> {out} ({sheet.width}x{sheet.height})')


if __name__ == '__main__':
    main()
