#!/usr/bin/env python3
"""Print a perceptual hash per image so two machines can be compared by text.

  python3 tools/hash_images.py <dir-or-file> [more...]

Emits "<name>\t<64-bit dhash hex>\t<WxH>" per line. dhash compares each pixel
with its right-hand neighbour on a 9x8 greyscale thumbnail, so it survives
rescaling and re-encoding, which is exactly what happens to an image pasted
into a spreadsheet.
"""
import os
import sys
from PIL import Image

EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'}


def dhash(path, size=8):
    im = Image.open(path).convert('L').resize((size + 1, size), Image.LANCZOS)
    px = list(im.getdata())
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | (px[base + col] < px[base + col + 1])
    return f'{bits:016x}'


def walk(target):
    if os.path.isfile(target):
        yield target
        return
    for name in sorted(os.listdir(target)):
        if os.path.splitext(name)[1].lower() in EXT:
            yield os.path.join(target, name)


def main():
    for target in sys.argv[1:]:
        for path in walk(target):
            try:
                with Image.open(path) as im:
                    dims = f'{im.width}x{im.height}'
                print(f'{os.path.basename(path)}\t{dhash(path)}\t{dims}')
            except Exception as err:
                print(f'{os.path.basename(path)}\tERROR\t{err}', file=sys.stderr)


if __name__ == '__main__':
    main()
