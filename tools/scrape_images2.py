#!/usr/bin/env python3
"""Pass 2: match the 31 leftovers by normalised product NAME.

Pass 1 matched on url_key, which fails whenever the slug contains characters
Magento rewrites differently (&, apostrophes, inch marks). The listing pages
carry the product name in the tile, so name matching picks up the rest.
"""
import csv, json, os, re, sys, time, html as htmllib
import urllib.request, http.cookiejar

BASE = "https://b2b.rsmus.companystore.gifts"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
ROOT = "/home/claude/rsm-b2b"
OUT = f"{ROOT}/assets/products"
EXPORT = "/mnt/user-data/uploads/Workstation OS/Holder/RSM b2b/Product Export.csv"

CATEGORIES = [
    "apparel/t-shirts", "apparel/shirts", "apparel/jackets", "apparel/hoodies",
    "apparel/headware", "drinkware/mugs-tumblers", "drinkware/bottles",
    "drinkware/frappe-mug", "travel/bag-pack", "travel/duffle-bag",
    "travel/laptop-handbag", "travel/tote-bags", "travel/trolley-bags",
    "utilities/accessories", "utilities/coasters", "utilities/notebook",
    "utilities/pens", "apparel", "drinkware", "travel", "utilities",
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


def norm(s):
    """Aggressive normalisation so 'Jack & Jones' == 'jack&jones' == 'jack jones'."""
    s = htmllib.unescape(s or "").lower()
    s = s.replace("&amp;", "&").replace("&quot;", '"').replace("&#039;", "'")
    s = re.sub(r"\b(b2b)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


# A listing tile: the photo anchor (carries the image) then the name anchor.
PHOTO = re.compile(
    r'href="' + re.escape(BASE) + r'/([^"]+?)\.html"[^>]*class="product photo product-item-photo".*?'
    r'src="(https?://[^"]+/media/catalog/product/[^"]+)"', re.S | re.I)
NAME = re.compile(
    r'class="product-item-link"[^>]*>\s*(.*?)\s*</a>', re.S | re.I)
# Pair image + name inside one <li class="item product product-item"> block.
BLOCK = re.compile(r'<li[^>]+class="[^"]*product-item[^"]*"(.*?)</li>', re.S | re.I)
ANYIMG = re.compile(r'src="(https?://[^"]+/media/catalog/product/[^"]+)"', re.I)


def harvest(page):
    out = []
    for blob in BLOCK.findall(page):
        img = ANYIMG.search(blob)
        nm = NAME.search(blob)
        if img and nm:
            name = re.sub(r"<[^>]+>", "", nm.group(1)).strip()
            out.append((name, img.group(1)))
    return out


def main():
    rows = list(csv.DictReader(open(EXPORT)))
    visible = [r for r in rows if r["visibility"] == "Catalog, Search"]

    manifest = json.load(open(f"{ROOT}/tools/image_manifest.json"))
    have = set(manifest)
    todo = {norm(r["name"]): r["sku"] for r in visible if r["sku"] not in have}
    print(f"{len(todo)} products still without an image")

    live = {}
    for cat in CATEGORIES:
        page = get(f"{BASE}/{cat}.html?product_list_limit=all")
        if not page:
            continue
        tiles = harvest(page)
        for name, img in tiles:
            live.setdefault(norm(name), img)
        print(f"  {cat}: {len(tiles)} tiles")
    print(f"{len(live)} distinct live product names collected")

    matched, unmatched = {}, []
    for key, sku in todo.items():
        if key in live:
            matched[sku] = live[key]
            continue
        # substring fallback, longest live name that contains or is contained
        cands = [v for k, v in live.items() if k and (k in key or key in k)]
        if len(cands) == 1:
            matched[sku] = cands[0]
        else:
            unmatched.append(sku)

    print(f"name-matched {len(matched)}, still unmatched {len(unmatched)}")

    for sku, src in sorted(matched.items()):
        ext = os.path.splitext(src.split("?")[0])[1].lower() or ".png"
        dest = os.path.join(OUT, f"{sku}{ext}")
        blob = get(src, binary=True)
        if not blob or len(blob) < 1000:
            print(f"    empty {sku}")
            continue
        with open(dest, "wb") as f:
            f.write(blob)
        manifest[sku] = f"assets/products/{sku}{ext}"

    with open(f"{ROOT}/tools/image_manifest.json", "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    print(f"\ntotal images now: {len(manifest)} / {len(visible)}")
    if unmatched:
        by_sku = {r["sku"]: r["name"] for r in visible}
        print("no image for:")
        for s in unmatched:
            print(f"  {s}  {by_sku[s]}")


if __name__ == "__main__":
    main()
