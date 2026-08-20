#!/usr/bin/env python3
"""Side-by-side proof sheet for the workbook-row -> Drive-SKU mapping.

  python3 tools/pair_sheet.py out.jpg map.json <workbook.xlsx> <drive-dir>

map.json is {"<row>": "<sku>"}. Each tile shows the workbook mockup on the left
and the proposed Drive image on the right, captioned with row, SKU and product
name, so a wrong pairing is visible at a glance instead of buried in a score.
"""
import io
import json
import os
import sys

import openpyxl
from PIL import Image, ImageDraw

CELL = 150
PAD = 8
LABEL = 26


def main():
    out, map_path, book, drive = sys.argv[1:5]
    mapping = {int(k): v for k, v in json.load(open(map_path)).items()}

    ws = openpyxl.load_workbook(book)['Sheet12']
    names = {i + 2: str(r[2]).strip()
             for i, r in enumerate(ws.iter_rows(min_row=2, values_only=True)) if r[2]}
    shots = {i.anchor._from.row + 1: Image.open(io.BytesIO(i._data())) for i in ws._images}

    lib = {}
    for name in os.listdir(drive):
        stem, ext = os.path.splitext(name)
        if ext.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
            lib[stem] = os.path.join(drive, name)

    cols = 3
    rows_n = (len(mapping) + cols - 1) // cols
    tile_w = CELL * 2 + PAD * 3
    tile_h = CELL + PAD * 2 + LABEL
    sheet = Image.new('RGB', (cols * tile_w, rows_n * tile_h), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)

    for i, row in enumerate(sorted(mapping)):
        sku = mapping[row]
        x, y = (i % cols) * tile_w, (i // cols) * tile_h
        for j, im in enumerate([shots.get(row),
                                Image.open(lib[sku]) if sku in lib else None]):
            if im is None:
                continue
            t = im.convert('RGB')
            t.thumbnail((CELL, CELL), Image.LANCZOS)
            sheet.paste(t, (x + PAD + j * (CELL + PAD) + (CELL - t.width) // 2,
                            y + PAD + (CELL - t.height) // 2))
        draw.text((x + PAD, y + PAD + CELL + 4),
                  f'row {row}  ->  {sku}', fill=(0, 0, 0))
        draw.text((x + PAD, y + PAD + CELL + 15), names.get(row, '')[:52], fill=(90, 90, 90))
        draw.rectangle([x, y, x + tile_w - 1, y + tile_h - 1], outline=(205, 205, 205))

    sheet.save(out, quality=90)
    print(f'{len(mapping)} pairs -> {out} ({sheet.width}x{sheet.height})')


if __name__ == '__main__':
    main()
