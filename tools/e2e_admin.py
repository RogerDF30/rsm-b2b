#!/usr/bin/env python3
"""Browser test for the admin console.

  1. Console is gated; a wrong password is refused.
  2. All four tabs render.
  3. Catalogue lists products, search and category filters narrow it.
  4. Show/hide toggles a product and the Hidden filter finds it.
  5. Adding a product validates: SKU, name, and the first tier must equal MOQ.
  6. A valid new product saves and appears in the list.
  7. Related products can be attached and removed.
  8. Delete demands the SKU typed back, and is a hide not an erase.
  9. Banners can be added and edited; appearance settings save.
 10. Publish reports what it pushed.
"""
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8900'
PASS = 'admin2026'
passed, failed = [], []


def check(name, got, want):
    if got == want:
        passed.append(name); print(f'ok   {name}')
    else:
        failed.append(name); print(f'FAIL {name}\n       got  {got!r}\n      want {want!r}')


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={'width': 1400, 'height': 1100})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))

        # --- 1. gate ---------------------------------------------------------
        pg.goto(f'{BASE}/admin.html', wait_until='networkidle')
        pg.wait_for_timeout(600)
        check('gate shown before auth', pg.is_visible('#gate'), True)

        pg.fill('#apass', 'wrong'); pg.click('#gateForm button')
        pg.wait_for_timeout(1200)
        check('wrong password refused', pg.is_visible('#gate'), True)

        pg.fill('#apass', PASS); pg.click('#gateForm button')
        pg.wait_for_selector('#adminTabs .chip', timeout=15000)
        pg.wait_for_timeout(500)

        # --- 2. tabs ---------------------------------------------------------
        tabs = pg.eval_on_selector_all('#adminTabs .chip', 'e=>e.map(x=>x.textContent)')
        check('four tabs', len(tabs), 4)
        # count comes from the catalogue itself, so seeding more products
        # never turns this into a false failure
        total = pg.evaluate('CAT.products.length')
        check('catalogue tab counts products', str(total) in tabs[1], True)

        # --- 3. catalogue list + filters -------------------------------------
        pg.click('#adminTabs .chip:nth-child(2)')
        pg.wait_for_selector('#prodRows tr', timeout=10000)
        check('all products listed', pg.locator('#prodRows tr').count(), total)

        pg.fill('input[placeholder="Search name or SKU"]', 'arrow')
        pg.wait_for_timeout(400)
        n = pg.locator('#prodRows tr').count()
        check('search narrows the list', 0 < n < total, True)
        pg.fill('input[placeholder="Search name or SKU"]', '')
        pg.wait_for_timeout(400)

        # --- 4. show / hide ---------------------------------------------------
        row = '#prodRows tr:has-text("B2BRSMON-0013")'
        check('product starts visible', pg.inner_text(f'{row} .sw').strip(), 'Visible')
        check('switch reports its state to a screen reader',
              pg.get_attribute(f'{row} .sw', 'aria-checked'), 'true')
        pg.click(f'{row} .sw')
        pg.wait_for_timeout(900)
        check('toggled to hidden', pg.inner_text(f'{row} .sw').strip(), 'Hidden')
        check('aria-checked follows', pg.get_attribute(f'{row} .sw', 'aria-checked'), 'false')

        pg.click('text=Hidden only')
        pg.wait_for_selector('#prodRows tr', timeout=10000)
        check('hidden filter finds exactly it', pg.locator('#prodRows tr').count(), 1)
        pg.click(f'{row} .sw')          # put it back
        pg.wait_for_timeout(900)
        pg.click('text=Hidden only')
        pg.wait_for_timeout(600)

        # --- 5. validation on add --------------------------------------------
        pg.click('text=Add product')
        pg.wait_for_selector('.drawer-inner')
        pg.click('text=Add product >> nth=-1')   # the drawer's save button
        pg.wait_for_timeout(900)
        check('empty SKU refused', 'sku' in pg.inner_text('.toast').lower(), True)

        pg.fill('#f_sku', 'TEST-0001')
        pg.fill('#f_name', 'Admin Test Mug')
        pg.click('text=Add product >> nth=-1')
        pg.wait_for_timeout(900)
        # the seeded tier has price 0, so it is dropped before the MOQ check
        check('a priced tier is required',
              'price tier' in pg.inner_text('.toast').lower(), True)

        tier = '#tierBox .row:first-child input'
        pg.fill(f'{tier}:nth-child(1)', '30')      # deliberately != MOQ 25
        pg.fill(f'{tier}:nth-child(5)', '499')
        pg.click('text=Add product >> nth=-1')
        pg.wait_for_timeout(900)
        check('first tier must start at the MOQ',
              'moq' in pg.inner_text('.toast').lower(), True)

        # --- 6. valid save ----------------------------------------------------
        pg.fill(f'{tier}:nth-child(1)', '25')
        pg.wait_for_timeout(200)

        # --- 7. related products: modal, multi-select, thumbnails -------------
        check('nothing related yet',
              'None selected' in pg.inner_text('#relatedPicker'), True)
        pg.click('#relChoose')
        pg.wait_for_selector('#relModal .pick-tile', timeout=10000)
        check('picker shows every other active product',
              pg.locator('#relModal .pick-tile').count(),
              pg.evaluate('CAT.products.filter(p=>p.active).length'))
        pg.wait_for_timeout(700)
        check('picker tiles render real images',
              pg.eval_on_selector_all(
                  '#relModal .pick-tile img',
                  'e=>e.filter(x=>x.naturalWidth>0).length') > 0, True)

        pg.fill('#pickSearch', 'B2BRSMON-0091')
        pg.wait_for_timeout(400)
        check('picker search narrows the grid',
              pg.locator('#relModal .pick-tile').count(), 1)
        pg.click('#relModal .pick-tile')
        pg.fill('#pickSearch', 'B2BRSMON-0092')
        pg.wait_for_timeout(400)
        pg.click('#relModal .pick-tile')          # second one: multi-select
        check('two selected in the modal',
              pg.inner_text('#pickCount').strip(), '2 selected')

        pg.click('#pickDone')
        pg.wait_for_timeout(400)
        check('two related tiles attached',
              pg.locator('#relSelected .rel-tile').count(), 2)
        pg.wait_for_timeout(700)
        check('attached tiles show images',
              pg.eval_on_selector_all(
                  '#relSelected .rel-tile img',
                  'e=>e.filter(x=>x.naturalWidth>0).length'), 2)

        # remove one, then confirm the modal remembers the survivor
        pg.click('#relSelected .rel-tile:first-child .rel-x')
        pg.wait_for_timeout(300)
        check('remove leaves one', pg.locator('#relSelected .rel-tile').count(), 1)
        pg.click('#relChoose')
        pg.wait_for_selector('#relModal .pick-tile', timeout=10000)
        check('modal reopens with the survivor ticked',
              pg.inner_text('#pickCount').strip(), '1 selected')
        pg.click('#relModal >> text=Cancel')
        pg.wait_for_timeout(300)
        check('cancel leaves the selection alone',
              pg.locator('#relSelected .rel-tile').count(), 1)

        pg.click('text=Add product >> nth=-1')
        pg.wait_for_timeout(1800)
        check('new product saved',
              'added' in pg.inner_text('.toast').lower(), True)
        pg.wait_for_selector('#prodRows tr', timeout=10000)
        pg.fill('input[placeholder="Search name or SKU"]', 'TEST-0001')
        pg.wait_for_timeout(500)
        check('new product in the list', pg.locator('#prodRows tr').count(), 1)

        # --- 8. delete demands the SKU ---------------------------------------
        pg.click('#prodRows tr:has-text("TEST-0001") >> text=Edit')
        pg.wait_for_selector('.drawer-inner')
        pg.click('.drawer-inner >> text=Delete')
        pg.wait_for_selector('#delConfirm')
        pg.fill('#delConfirm', 'nope')
        pg.click('text=Delete product')
        pg.wait_for_timeout(900)
        check('wrong confirmation refused',
              'confirm' in pg.inner_text('.toast').lower(), True)
        pg.fill('#delConfirm', 'TEST-0001')
        pg.click('text=Delete product')
        pg.wait_for_timeout(1800)
        check('delete is a hide, not an erase',
              'hidden' in pg.inner_text('.toast').lower(), True)

        # --- 9. banners + appearance -----------------------------------------
        pg.click('#adminTabs .chip:nth-child(3)')
        pg.wait_for_timeout(600)
        pg.click('text=Add banner')
        pg.wait_for_selector('.drawer-inner')
        pg.fill('.drawer-inner input >> nth=0', 'autumn')
        pg.fill('.drawer-inner input >> nth=1', '1')
        pg.fill('.drawer-inner input >> nth=2', 'Autumn kit')
        pg.click('text=Save banner')
        pg.wait_for_timeout(1800)
        check('banner saved', 'Autumn kit' in pg.inner_text('#panel'), True)

        pg.click('#adminTabs .chip:nth-child(4)')
        pg.wait_for_timeout(600)
        pg.fill('.field:has-text("Hero title") input[type=text]', 'RSM merchandise store')
        pg.click('text=Save appearance')
        pg.wait_for_timeout(1500)
        check('appearance saved', 'saved' in pg.inner_text('.toast').lower(), True)

        # --- 10. publish ------------------------------------------------------
        pg.on('dialog', lambda d: d.accept())
        pg.click('text=Publish to site')
        pg.wait_for_timeout(2200)
        check('publish reports counts', 'Published' in pg.inner_text('.toast'), True)
        pg.screenshot(path='/tmp/admin_final.png', full_page=True)

        b.close()

    real = [e for e in errs if 'ERR_' not in e]
    if real:
        print('\nPAGE ERRORS:\n' + '\n'.join(real))
    print(f'\n{len(passed)} passed, {len(failed)} failed')
    sys.exit(1 if failed or real else 0)


if __name__ == '__main__':
    main()
