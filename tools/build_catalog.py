#!/usr/bin/env python3
"""Transform the Magento export into products.json + the Google Sheet seed CSVs.

Inputs : Product Export.csv (423 rows), tools/image_manifest.json (scraped images)
Outputs: assets/products.json          <- the storefront reads only this
         sheet-seed/Products.csv
         sheet-seed/Variants.csv
         sheet-seed/PriceTiers.csv
         sheet-seed/Categories.csv

PRICING WARNING
The Magento export contains ZERO tier-price rows and ZERO MOQ values (verified:
`special_price` empty on all 423 rows, no tier_price column, Magento keeps
Advanced Pricing in a separate export). The MOQ and tier tables produced here are
GENERATED PLACEHOLDERS from the rule in TIER_RULE below. They exist so the
pricing engine, the cart and the approval mail can be built and demoed end to
end. Replace sheet-seed/PriceTiers.csv with the real commercial table before
this goes anywhere near RSM.
"""
import csv, json, os, re, html as htmllib
from collections import defaultdict

ROOT = "/home/claude/rsm-b2b"
EXPORT = "/mnt/user-data/uploads/Workstation OS/Holder/RSM b2b/Product Export.csv"

# --- PLACEHOLDER commercial rules. Replace with the real table. ---------------
MOQ_BY_SET = {
    "Apparel": 25, "Caps": 25, "Bags": 10, "Mug": 25,
    "Sipper": 25, "Stationery": 25, "Accessories": 50,
}
# (multiple of MOQ at which the break starts, discount off base price)
TIER_RULE = [(1, 0.00), (2, 0.07), (4, 0.12), (10, 0.18)]

# PLACEHOLDER GST. The RSMB012862 order shows the client running 5% on a
# 1953-rupee duffle bag and 18% on drinkware and stationery, which does not
# follow the standard slabs. Confirm each rate with finance before go-live.
GST_BY_SET = {
    "Apparel": 5, "Caps": 5, "Bags": 5, "Mug": 18,
    "Sipper": 18, "Stationery": 18, "Accessories": 18,
}

CATEGORY_LABELS = {
    "Apparel": "Apparel", "Drinkware": "Drinkware",
    "Travel": "Travel", "Utilities": "Utilities",
}


def clean_html(s):
    """Keep the description readable but strip Magento's markup noise."""
    s = htmllib.unescape(s or "")
    s = re.sub(r"<\s*b\s*>Description<\s*/\s*b\s*>", "", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</?p[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\n{2,}", "\n", s)
    return s.strip()


def spec_pairs(s):
    """Pull 'Fabric: 100% cotton' style pairs out of the description."""
    out = []
    for line in clean_html(s).split("\n"):
        m = re.match(r"\s*([A-Za-z][A-Za-z /]{2,20}):\s*(.+)$", line.strip())
        if m:
            out.append([m.group(1).strip(), m.group(2).strip()])
    return out


def round5(x):
    return int(round(x / 5.0) * 5)


def main():
    rows = list(csv.DictReader(open(EXPORT)))
    by_sku = {r["sku"]: r for r in rows}
    visible = [r for r in rows if r["visibility"] == "Catalog, Search"]
    images = json.load(open(f"{ROOT}/tools/image_manifest.json"))

    products, variants, tiers = [], [], []
    cats = {}

    for r in visible:
        sku = r["sku"]
        parts = [p for p in r["categories"].split(",") if "/" in p]
        # 'rsm_b2b/Apparel/T-Shirts' -> ('Apparel', 'T-Shirts')
        top, sub = "Other", "Other"
        for p in parts:
            seg = p.split("/")
            if len(seg) >= 3:
                top, sub = seg[1], seg[2]
                break
            if len(seg) == 2:
                top = seg[1]
        # one row of the export has a typo: 'rsm/Utilities/Accessories'
        if top not in CATEGORY_LABELS and sub != "Other":
            top = "Utilities" if sub == "Accessories" else top

        cats.setdefault(top, set()).add(sub)

        aset = r["attribute_set_code"]
        moq = MOQ_BY_SET.get(aset, 25)
        gst = GST_BY_SET.get(aset, 18)

        sizes = []
        base = 0.0
        if r["product_type"] == "configurable" and r["configurable_variations"]:
            for part in r["configurable_variations"].split("|"):
                d = dict(kv.split("=", 1) for kv in part.split(",") if "=" in kv)
                v = by_sku.get(d.get("sku", ""))
                if not v:
                    continue
                price = float(v["price"] or 0)
                base = base or price
                sizes.append(d.get("size", ""))
                variants.append({
                    "variant_sku": v["sku"], "parent_sku": sku,
                    "size": d.get("size", ""), "stock_qty": v["qty"] or 0,
                    "active": "TRUE",
                })
        else:
            base = float(r["price"] or 0)

        if base <= 0:
            continue

        # Placeholder tier ladder
        ladder = []
        for i, (mult, disc) in enumerate(TIER_RULE):
            lo = moq * mult
            hi = (moq * TIER_RULE[i + 1][0]) - 1 if i + 1 < len(TIER_RULE) else ""
            unit = round5(base * (1 - disc))
            ladder.append({"min_qty": lo, "max_qty": hi, "unit_price": unit})
            tiers.append({"parent_sku": sku, "min_qty": lo,
                          "max_qty": hi, "unit_price": unit})

        img = images.get(sku, "")
        products.append({
            "sku": sku,
            "name": r["name"].strip(),
            "url_key": r["url_key"],
            "category": top,
            "subcategory": sub,
            "attribute_set": aset,
            "description": clean_html(r["short_description"] or r["description"]),
            "specs": spec_pairs(r["short_description"] or r["description"]),
            "moq": moq,
            "gst_rate": gst,
            "base_price": round5(base),
            "tiers": ladder,
            "sizes": sizes,
            "has_sizes": bool(sizes),
            "image": img,
            "weight": r["weight"] or "",
            "active": True,
        })

    products.sort(key=lambda p: (p["category"], p["subcategory"], p["name"]))

    os.makedirs(f"{ROOT}/sheet-seed", exist_ok=True)
    with open(f"{ROOT}/assets/products.json", "w") as f:
        json.dump({
            "generated_from": "Magento Product Export.csv",
            "pricing_status": "PLACEHOLDER - MOQ and tiers generated, not client-supplied",
            "categories": [
                {"slug": k, "label": CATEGORY_LABELS.get(k, k),
                 "subcategories": sorted(v)}
                for k, v in sorted(cats.items())
            ],
            "products": products,
        }, f, indent=1)

    def dump(name, rowlist, cols):
        with open(f"{ROOT}/sheet-seed/{name}.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for row in rowlist:
                w.writerow({c: row.get(c, "") for c in cols})

    dump("Products", [{
        "sku": p["sku"], "name": p["name"], "category": p["category"],
        "subcategory": p["subcategory"], "description": p["description"],
        "moq": p["moq"], "gst_rate": p["gst_rate"], "base_price": p["base_price"],
        "has_sizes": "TRUE" if p["has_sizes"] else "FALSE",
        "image": p["image"], "lead_time_days": 14, "active": "TRUE",
        "sort_order": i,
    } for i, p in enumerate(products)],
        ["sku", "name", "category", "subcategory", "description", "moq",
         "gst_rate", "base_price", "has_sizes", "image", "lead_time_days",
         "active", "sort_order"])

    dump("Variants", variants,
         ["variant_sku", "parent_sku", "size", "stock_qty", "active"])
    dump("PriceTiers", tiers,
         ["parent_sku", "min_qty", "max_qty", "unit_price"])
    dump("Categories", [
        {"slug": sub, "parent_slug": top, "label": sub,
         "sort_order": i, "active": "TRUE"}
        for i, (top, subs) in enumerate(sorted(cats.items()))
        for sub in sorted(subs)
    ], ["slug", "parent_slug", "label", "sort_order", "active"])

    print(f"products      {len(products)}")
    print(f"variants      {len(variants)}")
    print(f"tier rows     {len(tiers)}")
    print(f"with image    {sum(1 for p in products if p['image'])}")
    print(f"categories    { ({k: len(v) for k, v in cats.items()}) }")
    print(f"price range   {min(p['base_price'] for p in products)} - "
          f"{max(p['base_price'] for p in products)}")


if __name__ == "__main__":
    main()
