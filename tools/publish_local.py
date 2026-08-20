#!/usr/bin/env python3
"""Build assets/products.json and assets/site.json from the live backend.

Same output as Admin.gs buildCatalogueJson()/buildSiteJson(), produced here so
the catalogue can be published by committing to the repo instead of by the
console's Publish button (which needs the GITHUB_TOKEN script property).

  python3 tools/publish_local.py            # writes the two files
  git add -A && git commit && git push      # publishes them

specs, url_key, weight and attribute_set have no column in the Sheet: they came
from the Magento scrape and are carried over from the file already on disk.
"""
import json
import os
import urllib.request

API = ('https://script.google.com/macros/s/AKfycbyDezChvk8YkvxbdaPMB0W5sKK1z'
       'nGFH7F6B9T0ficleUdVTPGk22tPD-MI_hZeelaf/exec')
TOKEN = 'rsm_XkCA0HS327rSxemHHRHIymHolJcf'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT = os.path.join(ROOT, 'assets/products.json')
SITE = os.path.join(ROOT, 'assets/site.json')


def call(fn, **kw):
    body = json.dumps({'fn': fn, 'token': TOKEN, **kw}).encode()
    req = urllib.request.Request(API, body, {'Content-Type': 'text/plain'})
    out = json.loads(urllib.request.urlopen(req, timeout=120).read())
    if not out.get('ok'):
        raise SystemExit('API said: ' + str(out.get('error')))
    return out


def main():
    admin_pass = os.environ.get('RSM_ADMIN_PASS')
    if not admin_pass:
        raise SystemExit('Set RSM_ADMIN_PASS first.')
    d = call('adminCatalog', admin_pass=admin_pass)

    old = {}
    if os.path.exists(CAT):
        with open(CAT) as f:
            for p in json.load(f)['products']:
                old[p['sku'].strip().upper()] = p

    live = [p for p in d['products'] if p['active']]
    live_skus = {p['sku'] for p in live}

    cats = {}
    for c in d['categories']:
        if c['active']:
            cats.setdefault(c['parent_slug'], set()).add(c['label'])

    out = {
        'generated_from': 'admin console',
        'generated_at': d.get('published_at') or '',
        'pricing_status': 'from the Sheet',
        'categories': [{'slug': k, 'label': k, 'subcategories': sorted(v)}
                       for k, v in sorted(cats.items())],
        'products': [],
    }
    for p in live:
        was = old.get(p['sku'], {})
        out['products'].append({
            'sku': p['sku'], 'name': p['name'], 'url_key': was.get('url_key', ''),
            'category': p['category'], 'subcategory': p['subcategory'],
            'attribute_set': was.get('attribute_set', ''),
            'description': p['description'], 'specs': was.get('specs', []),
            'moq': p['moq'], 'gst_rate': p['gst_rate'], 'base_price': p['base_price'],
            'tiers': p['tiers'], 'sizes': p['sizes'], 'has_sizes': p['has_sizes'],
            'image': p['image'], 'weight': was.get('weight', ''), 'active': True,
            # union of the hand-picked and auto-mapped lists, manual first
            'related': [s for s in p.get('related_all', p['related_skus'])
                        if s in live_skus],
        })

    with open(CAT, 'w') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    with open(SITE, 'w') as f:
        json.dump({'generated_at': '', 'settings': d['settings'],
                   'banners': [b for b in d['banners'] if b['active']]},
                  f, indent=2, ensure_ascii=False)

    linked = sum(1 for p in out['products'] if p['related'])
    kept = sum(1 for p in out['products'] if p['specs'])
    print(f"{len(out['products'])} products, {linked} with related, "
          f"{kept} with specs carried over")


if __name__ == '__main__':
    main()
