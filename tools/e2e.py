#!/usr/bin/env python3
"""End-to-end browser test against the mock API.

Success criteria, each verified rather than eyeballed:
  1. PDP blocks Add to cart below MOQ, unblocks once sizes roll up past it.
  2. Cart shows one unit price across all sizes of the same parent SKU.
  3. Checkout is gated: an anonymous visit lands on login.
  4. Login prefills the checkout form from the user record.
  5. Submit without evidence is refused.
  6. Submit with evidence returns an order ID and clears the cart.
  7. Status page shows Pending Approval for the requester.
  8. Approval flips the status; admin close records tracking.
  9. Rejection surfaces the reason and the start-a-new-order route.
"""
import base64, json, sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8900'
EMAIL, PASSWORD = 'neha.garg@rsmus.com', 'DemoPass2026!'
SHIRT = 'B2BRSMON-0013'

passed, failed = [], []


def check(name, got, want):
    if got == want:
        passed.append(name)
        print(f'ok   {name}')
    else:
        failed.append(name)
        print(f'FAIL {name}\n       got  {got!r}\n       want {want!r}')


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={'width': 1360, 'height': 1000})
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))

        # --- 1. PDP MOQ gate -------------------------------------------------
        pg.goto(f'{BASE}/product.html?sku={SHIRT}', wait_until='networkidle')
        pg.wait_for_selector('#addBtn')
        check('PDP: add disabled at zero qty', pg.is_disabled('#addBtn'), True)

        pg.fill('[data-size-input="M"]', '10')
        pg.dispatch_event('[data-size-input="M"]', 'input')
        check('PDP: still blocked at 10 (MOQ 25)', pg.is_disabled('#addBtn'), True)
        check('PDP: hint asks for 15 more', 'Add 15 more' in pg.inner_text('#hint'), True)

        pg.fill('[data-size-input="L"]', '12')
        pg.dispatch_event('[data-size-input="L"]', 'input')
        pg.fill('[data-size-input="XL"]', '8')
        pg.dispatch_event('[data-size-input="XL"]', 'input')
        check('PDP: rollup 10+12+8 unblocks', pg.is_disabled('#addBtn'), False)
        check('PDP: total quantity is 30', pg.inner_text('#sumQty'), '30')
        check('PDP: 25-49 tier row highlighted',
              pg.get_attribute('#tiers tbody tr:first-child', 'class'), 'on')

        pg.screenshot(path='/tmp/e2e_pdp.png', full_page=True)
        pg.click('#addBtn')
        pg.wait_for_timeout(400)

        # --- 2. Cart ---------------------------------------------------------
        pg.goto(f'{BASE}/cart.html', wait_until='networkidle')
        pg.wait_for_selector('.tbl')
        units = pg.eval_on_selector_all(
            '.tbl tbody tr td:nth-child(3)', 'els => els.map(e => e.textContent.trim())')
        check('Cart: one unit price across all three sizes', len(set(units)), 1)
        check('Cart: three size lines', len(units), 3)
        check('Cart: checkout enabled', pg.is_disabled('a.btn[href="checkout.html"]')
              if pg.query_selector('a.btn[href="checkout.html"]') else True, False)
        pg.screenshot(path='/tmp/e2e_cart.png', full_page=True)

        # --- 3. Checkout is gated -------------------------------------------
        pg.goto(f'{BASE}/checkout.html', wait_until='networkidle')
        pg.wait_for_timeout(600)
        check('Checkout: anonymous redirected to login', 'login.html' in pg.url, True)

        # --- 4. Login --------------------------------------------------------
        pg.fill('#email', EMAIL)
        pg.fill('#pass', PASSWORD)
        pg.click('#go')
        pg.wait_for_url('**/checkout.html*', timeout=15000)
        pg.wait_for_selector('[name=requester_name]')
        check('Checkout: name prefilled', pg.input_value('[name=requester_name]'), 'Neha Garg')
        check('Checkout: LOB prefilled', pg.input_value('[name=lob]'), 'Consulting')
        check('Checkout: ship city prefilled', pg.input_value('[name=ship_city]'), 'Gurugram')

        pg.fill('[name=event_date]', '2026-09-30')
        pg.fill('[name=purpose]', 'Team milestone kit for the Gurugram office.')
        pg.fill('[name=requester_phone]', '9812345678')
        pg.fill('[name=ship_state]', 'Haryana')

        # --- 5. Evidence is mandatory ---------------------------------------
        pg.click('#submitBtn')
        pg.wait_for_timeout(500)
        check('Checkout: refuses submit with no evidence',
              'evidence' in pg.inner_text('.toast').lower(), True)

        png = base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
        pg.set_input_files('#files', [{
            'name': 'lob-approval.png', 'mimeType': 'image/png', 'buffer': png}])
        pg.wait_for_timeout(600)
        check('Checkout: evidence listed', 'lob-approval.png' in pg.inner_text('#fileList'), True)
        pg.screenshot(path='/tmp/e2e_checkout.png', full_page=True)

        # --- 6. Submit -------------------------------------------------------
        pg.click('#submitBtn')
        pg.wait_for_url('**/status.html*', timeout=15000)
        order_id = pg.url.split('id=')[1].split('&')[0]
        check('Submit: order id issued', order_id.startswith('RSMB'), True)
        cart_after = pg.evaluate("() => sessionStorage.getItem('rsm_cart')")
        check('Submit: cart cleared', cart_after, None)

        # --- 7. Status -------------------------------------------------------
        pg.wait_for_selector('.status')
        check('Status: shows Pending Approval', pg.inner_text('.status').strip().lower(), 'pending approval')
        pg.screenshot(path='/tmp/e2e_status_pending.png', full_page=True)

        # --- 8. Approve, then admin close -----------------------------------
        pg.evaluate("""async id => {
            await fetch('/', {method:'POST', headers:{'Content-Type':'text/plain'},
              body: JSON.stringify({fn:'_decide', token:'rsm-demo-token',
                order_id:id, act:'approve', who:'uday.reddy@rsmus.com'})});
        }""", order_id)

        pg.goto(f'{BASE}/admin.html', wait_until='networkidle')
        pg.fill('#apass', 'admin2026')
        pg.click('#gateForm button')
        pg.wait_for_selector('#rows tr', timeout=15000)
        row = f'#rows tr:has-text("{order_id}")'
        check('Admin: order listed', pg.locator(row).count(), 1)
        check('Admin: status is Approved', 'approved' in pg.inner_text(row).lower(), True)
        pg.screenshot(path='/tmp/e2e_admin.png', full_page=True)

        pg.click(f'{row} button')
        pg.wait_for_selector('.drawer-inner')
        pg.click('text=Close with tracking')
        pg.fill('#courier', 'Blue Dart')
        pg.fill('#trackno', 'BD48219930')
        pg.click('text=Mark closed and notify')
        pg.wait_for_timeout(1500)
        check('Admin: order closed', 'closed' in pg.inner_text(row).lower(), True)
        pg.screenshot(path='/tmp/e2e_admin_closed.png', full_page=True)

        # --- 9. Rejection path ----------------------------------------------
        rej = pg.evaluate("""async () => {
            const post = (b) => fetch('/', {method:'POST',
              headers:{'Content-Type':'text/plain'}, body: JSON.stringify(b)}).then(r=>r.json());
            const s = await post({fn:'login', token:'rsm-demo-token',
              email:'neha.garg@rsmus.com', password:'DemoPass2026!'});
            const o = await post({fn:'submitOrder', token:'rsm-demo-token', session:s.session,
              order:{requester_name:'Neha Garg', requester_email:'neha.garg@rsmus.com',
                     lob:'Consulting', event_date:'2026-10-01', purpose:'Second order',
                     ship_name:'Preeti', ship_phone:'1', ship_street:'x', ship_city:'Gurugram',
                     ship_pincode:'122002'},
              files:[{name:'e.png', mime:'image/png', bytes:10, data:'AA=='}],
              lines:[{parent_sku:'B2BRSMON-0013', variant_sku:'B2BRSMON-0013_M', size:'M', qty:30}],
              client_total: undefined});
            await post({fn:'_decide', token:'rsm-demo-token', order_id:o.order_id,
              act:'reject', who:'gowri.srinivas@rsmus.com',
              reason:'Budget not sanctioned for this quarter.'});
            return o.order_id;
        }""")
        pg.goto(f'{BASE}/status.html?id={rej}', wait_until='networkidle')
        pg.fill('#oem', EMAIL)
        pg.click('#findForm button')
        pg.wait_for_selector('.status', timeout=15000)
        check('Status: rejected shown', pg.inner_text('.status').strip().lower(), 'rejected')
        check('Status: reason shown',
              'Budget not sanctioned' in pg.inner_text('#out'), True)
        check('Status: offers a new order',
              'Start a new order' in pg.inner_text('#out'), True)
        pg.screenshot(path='/tmp/e2e_status_rejected.png', full_page=True)

        b.close()

    real = [e for e in errors if 'ERR_CONNECTION' not in e]
    if real:
        print('\nPAGE ERRORS:\n' + '\n'.join(real))
    print(f'\n{len(passed)} passed, {len(failed)} failed')
    sys.exit(1 if failed or real else 0)


if __name__ == '__main__':
    main()
