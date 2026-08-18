#!/usr/bin/env python3
"""Scrape product images from the live Magento storefront and map them to SKUs.

Matching is by url_key, which appears both in the Magento CSV export and in the
live product URL slug. The rsm_imgs/... paths in the export are stale: the live
server 302-loops on them, so the real image URL has to be read off the rendered
category pages.
"""
import csv, json, os, re, sys, time
import urllib.request, urllib.error, http.cookiejar

BASE = "https://b2b.rsmus.companystore.gifts"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
OUT = ("/home/claude/rsm-b2b/assets/products")
EXPORT = "/mnt/user-data/uploads/Workstation OS/Holder/RSM b2b/Product Export.csv"

CATEGORIES = [
    "apparel/t-shirts", "apparel/shirts", "apparel/jackets", "apparel/hoodies",
    "apparel/headware", "drinkware/mugs-tumblers", "drinkware/bottles",
    "drinkware/frappe-mug", "travel/bag-pack", "travel/duffle-bag",
    "travel/laptop-handbag", "travel/tote-bags", "travel/trolley-bags",
    "utilities/accessories", "utilities/coasters", "utilities/notebook",
    "utilities/pens",
]

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [("User-Agent", UA)]


def get(url, binary=False, tries=3):
    for n in range(tries):
        try:
            with opener.open(url, timeout=45) as r:
                data = r.read()
            return data if binary else data.decode("utf-8", "replace")
        except Exception as e:
            if n == tries - 1:
                print(f"    FAIL {url}: {e}", file=sys.stderr)
                return None
            time.sleep(2 * (n + 1))


# Magento renders the listing tile as a block containing the product link and
# its image. Pull both, then pair them by proximity within the same tile.
TILE = re.compile(
    r'<a[^>]+href="' + re.escape(BASE) + r'/([a-z0-9\-]+)\.html"[^>]*class="product photo product-item-photo"'
    r'(.*?)</a>', re.S | re.I)
IMG = re.compile(r'<img[^>]+src="([^"]+/media/catalog/product/[^"]+)"', re.I)
# fallback: any product anchor followed within 800 chars by a catalog image
LOOSE = re.compile(
    r'href="' + re.escape(BASE) + r'/([a-z0-9\-]+)\.html".{0,800}?'
    r'src="(https?://[^"]+/media/catalog/product/[^"]+)"', re.S | re.I)


def harvest(html):
    """Return {url_key: image_url} found on one listing page."""
    found = {}
    for slug, blob in TILE.findall(html):
        m = IMG.search(blob)
        if m:
            found.setdefault(slug, m.group(1))
    for slug, src in LOOSE.findall(html):
        found.setdefault(slug, src)
    return found


def main():
    rows = list(csv.DictReader(open(EXPORT)))
    visible = [r for r in rows if r["visibility"] == "Catalog, Search"]
    want = {r["url_key"]: r["sku"] for r in visible}
    print(f"{len(want)} visible products to match")

    os.makedirs(OUT, exist_ok=True)
    found = {}

    for cat in CATEGORIES:
        url = f"{BASE}/{cat}.html?product_list_limit=all"
        html = get(url)
        if not html:
            continue
        hits = harvest(html)
        new = {k: v for k, v in hits.items() if k in want and k not in found}
        found.update(new)
        print(f"  {cat}: {len(hits)} tiles, {len(new)} new matches")

    # Anything still unmatched: hit its own product page directly.
    missing = [k for k in want if k not in found]
    print(f"{len(found)} matched from listings, {len(missing)} need a direct page fetch")
    for slug in missing:
        html = get(f"{BASE}/{slug}.html")
        if not html:
            continue
        m = IMG.search(html) or re.search(
            r'"(https?://[^"]+/media/catalog/product/cache/[^"]+\.(?:png|jpg|jpeg|webp))"', html, re.I)
        if m:
            found[slug] = m.group(1)
            print(f"  direct hit: {slug}")

    # Download. Prefer the largest cache variant by stripping the size segment.
    manifest = {}
    for slug, src in sorted(found.items()):
        sku = want[slug]
        ext = os.path.splitext(src.split("?")[0])[1].lower() or ".png"
        dest = os.path.join(OUT, f"{sku}{ext}")
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            manifest[sku] = f"assets/products/{sku}{ext}"
            continue
        blob = get(src, binary=True)
        if not blob or len(blob) < 1000:
            print(f"    empty  {sku}")
            continue
        with open(dest, "wb") as f:
            f.write(blob)
        manifest[sku] = f"assets/products/{sku}{ext}"

    with open(("/home/claude/rsm-b2b/tools/image_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    print(f"\ndownloaded {len(manifest)} / {len(want)}")
    unmatched = sorted(set(want.values()) - set(manifest))
    if unmatched:
        print("no image for:", ", ".join(unmatched))


if __name__ == "__main__":
    main()
