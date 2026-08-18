#!/usr/bin/env python3
"""Resize to max 800px, convert to WebP, and generate a branded placeholder
for the 8 products the storefront scrape could not resolve."""
import json, os, glob
from PIL import Image, ImageDraw, ImageFont

ROOT = "/home/claude/rsm-b2b"
OUT = f"{ROOT}/assets/products"
CERULEAN, MIDNIGHT, GREY, OFFWHITE = "#009CDE", "#00153D", "#9AA6B8", "#F4F8FB"

cat = json.load(open(f"{ROOT}/assets/products.json"))
before = sum(os.path.getsize(f) for f in glob.glob(f"{OUT}/*"))

def font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

def wrap(draw, text, f, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= maxw:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines[:4]

made = 0
for p in cat["products"]:
    sku, dest = p["sku"], f"{OUT}/{p['sku']}.webp"
    src = f"{ROOT}/{p['image']}" if p["image"] else None

    if src and os.path.exists(src):
        im = Image.open(src).convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im).convert("RGB")
        im.thumbnail((800, 800), Image.LANCZOS)
        im.save(dest, "WEBP", quality=82, method=6)
        os.remove(src)
    else:
        # branded placeholder, Core 5 palette
        im = Image.new("RGB", (700, 700), OFFWHITE)
        d = ImageDraw.Draw(im)
        d.rectangle([0, 0, 700, 8], fill=CERULEAN)
        f1, f2 = font(30), font(20)
        lines = wrap(d, p["name"], f1, 560)
        y = 300 - (len(lines) * 20)
        for ln in lines:
            d.text((350 - d.textlength(ln, font=f1) / 2, y), ln, font=f1, fill=MIDNIGHT)
            y += 42
        d.text((350 - d.textlength(sku, font=f2) / 2, y + 14), sku, font=f2, fill=GREY)
        note = "Image pending"
        d.text((350 - d.textlength(note, font=f2) / 2, y + 46), note, font=f2, fill=CERULEAN)
        im.save(dest, "WEBP", quality=82, method=6)
        made += 1
    p["image"] = f"assets/products/{sku}.webp"

json.dump(cat, open(f"{ROOT}/assets/products.json", "w"), indent=1)
after = sum(os.path.getsize(f) for f in glob.glob(f"{OUT}/*"))
print(f"{len(cat['products'])} images, {made} placeholders generated")
print(f"{before/1e6:.1f} MB -> {after/1e6:.1f} MB")
