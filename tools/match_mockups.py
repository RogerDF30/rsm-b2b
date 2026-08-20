#!/usr/bin/env python3
"""Match the mockups embedded in Sujith's workbook to the SKU-named files in
the RSM B2B SAS Drive folder.

  python3 tools/match_mockups.py <workbook.xlsx> <drive-dir> [out.json]

Plain hashing fails here: the workbook mockups are screenshots with different
crops and white margins from the Drive originals, so a dhash of the whole frame
compares margin against product. Every image is therefore trimmed to its
non-white bounding box, padded back to square and reduced to a 32x32 greyscale
thumbnail. Matching is by correlation of those thumbnails, which tolerates
scale, margin and re-encoding, with a colour-histogram check as a second
opinion so two garments of the same shape but different colour do not merge.

Prints one line per workbook row: row, product name, best SKU, score, and the
runner-up, so a weak match is obvious rather than silent.
"""
import io
import json
import os
import sys

import numpy as np
import openpyxl
from PIL import Image

SIZE = 32
EXT = {'.png', '.jpg', '.jpeg', '.webp'}


def prepare(im):
    """Trim white margin, pad to square, return greyscale and colour vectors."""
    im = im.convert('RGB')
    a = np.asarray(im).astype(np.int16)
    ink = (a.sum(axis=2) < 720) | (a.max(axis=2) - a.min(axis=2) > 18)
    if ink.any():
        ys, xs = np.where(ink)
        im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

    w, h = im.size
    side = max(w, h)
    square = Image.new('RGB', (side, side), (255, 255, 255))
    square.paste(im, ((side - w) // 2, (side - h) // 2))

    grey = np.asarray(square.convert('L').resize((SIZE, SIZE), Image.LANCZOS),
                      dtype=np.float64).ravel()
    grey = grey - grey.mean()
    norm = np.linalg.norm(grey)
    grey = grey / norm if norm else grey

    small = np.asarray(square.resize((64, 64), Image.LANCZOS), dtype=np.int16)
    hist, _ = np.histogramdd(small.reshape(-1, 3), bins=(4, 4, 4),
                             range=((0, 256), (0, 256), (0, 256)))
    hist = hist.ravel() / hist.sum()
    return grey, hist


def score(a, b):
    """1.0 is identical. Shape correlation dominates, colour breaks ties."""
    shape = float(np.dot(a[0], b[0]))
    colour = float(np.minimum(a[1], b[1]).sum())
    return 0.75 * shape + 0.25 * colour


def main():
    book, drive = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else None

    ws = openpyxl.load_workbook(book)['Sheet12']
    names = {i + 2: str(r[2]).strip()
             for i, r in enumerate(ws.iter_rows(min_row=2, values_only=True)) if r[2]}

    shots = {}
    for img in ws._images:
        row = img.anchor._from.row + 1
        shots[row] = prepare(Image.open(io.BytesIO(img._data())))

    lib = {}
    for name in sorted(os.listdir(drive)):
        if os.path.splitext(name)[1].lower() in EXT:
            with Image.open(os.path.join(drive, name)) as im:
                lib[os.path.splitext(name)[0]] = prepare(im)

    print(f'{len(shots)} mockups, {len(lib)} library images\n')
    results = []
    for row in sorted(shots):
        ranked = sorted(((score(shots[row], v), k) for k, v in lib.items()),
                        reverse=True)
        best, second = ranked[0], ranked[1]
        results.append({
            'row': row, 'name': names.get(row, ''), 'sku': best[1],
            'score': round(best[0], 4), 'runner_up': second[1],
            'runner_up_score': round(second[0], 4),
            'margin': round(best[0] - second[0], 4),
        })
        print(f'row {row:3d}  {best[1]:16s} {best[0]:.3f}  '
              f'(2nd {second[1]:16s} {second[0]:.3f})  {names.get(row, "")[:46]}')

    dupes = {}
    for r in results:
        dupes.setdefault(r['sku'], []).append(r['row'])
    clashes = {k: v for k, v in dupes.items() if len(v) > 1}
    print(f'\nunique SKUs: {len(dupes)} of {len(results)}')
    if clashes:
        print('SAME SKU CLAIMED TWICE:', clashes)

    if out_path:
        with open(out_path, 'w') as f:
            json.dump(results, f, indent=2)
        print('wrote', out_path)


if __name__ == '__main__':
    main()
