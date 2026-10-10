import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { feeFor, cents, purchaseUnit, verifyOrder, verifyCapture, refundBody, sellerReadiness } from '../supabase/functions/_shared/paypal-platform.ts';
import { createCheckout, captureCheckout, refundCheckout, completeService, handler, webhook } from '../supabase/functions/_shared/paypal-handlers.ts';

const BUYER = '11111111-1111-4111-8111-111111111111';
const SELLER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const LISTING = '44444444-4444-4444-8444-444444444444';
const SELLER_MERCHANT = 'ABCDEF2345678';
const PLATFORM_MERCHANT = 'ZYXWVU2345678';
const PAYPAL_ORDER = 'TESTPAYPALORDER123';
const CAPTURE = 'TESTCAPTURE1234567';
const scopes = ['https://uri.paypal.com/services/payments/realtimepayment', 'https://uri.paypal.com/services/payments/refund', 'https://uri.paypal.com/services/payments/partnerfee'];
function fixture(kind = 'marketplace') {
  const state = { order: { id: ORDER, buyer_id: BUYER, seller_id: SELLER, item_id: LISTING, service_id: LISTING, amount_cents: 200,
    platform_fee_cents: 20, paypal_order_id: PAYPAL_ORDER, paypal_seller_merchant_id: SELLER_MERCHANT,
    paypal_platform_merchant_id: PLATFORM_MERCHANT, paypal_environment: 'live', payment_provider: 'paypal_live',
    payment_status: kind === 'service' ? 'unpaid' : 'pending', status: 'pending' }, enabled: true, writes: [], calls: [], admin: false };
  state.remote = { id: PAYPAL_ORDER, status: 'APPROVED', purchase_units: [purchaseUnit(state.order, 'Test item')] };
  state.capture = { id: CAPTURE, status: 'COMPLETED', final_capture: true, amount: { currency_code: 'USD', value: '2.00' },
    seller_receivable_breakdown: { gross_amount: { currency_code: 'USD', value: '2.00' }, paypal_fee: { currency_code: 'USD', value: '0.40' },
      net_amount: { currency_code: 'USD', value: '1.40' }, platform_fees: [{ amount: { currency_code: 'USD', value: '0.20' }, payee: { merchant_id: PLATFORM_MERCHANT } }] } };
  const rt = {
    env: () => undefined, required: () => 'test-webhook', clientId: () => 'test-client',
    user: async () => ({ id: BUYER }),
    settings: async () => ({ partner_merchant_id: PLATFORM_MERCHANT }),
    platformStatus: async () => ({ environment: 'live', payments_enabled: state.enabled, onboarding_available: state.enabled, message: 'Payments paused.' }),
    db: async (path, method = 'GET', body) => {
      if (method !== 'GET') state.writes.push({ path, method, body: structuredClone(body) });
      if (path.startsWith('platform_admins')) return state.admin ? [{ user_id: BUYER }] : [];
      if (path.startsWith('paypal_connected_accounts')) return [{ user_id: SELLER, tracking_id: 'seller-test' }];
      if (path.startsWith('marketplace_items')) return [{ id: LISTING, seller_id: SELLER, price_cents: 200, status: 'active', title: 'Test item' }];
      if (path.startsWith('star_rise_services')) return [{ id: LISTING, user_id: SELLER, price_cents: 200, is_active: true, title: 'Test service' }];
      if (path.startsWith('marketplace_orders') || path.startsWith('service_orders')) {
        if (method === 'POST') state.order = structuredClone(body);
        if (method === 'PATCH') Object.assign(state.order, body);
        return [structuredClone(state.order)];
      }
      throw new Error('Unexpected database call: ' + path);
    },
    paypal: async (path, method = 'GET', body, seller, requestId) => {
      state.calls.push({ path, method, body, seller, requestId });
      if (path.includes('verify-webhook-signature')) return { verification_status: 'FAILURE' };
      if (path.includes('merchant-integrations')) return { tracking_id: 'seller-test', merchant_id: SELLER_MERCHANT, payments_receivable: true,
        primary_email_confirmed: true, oauth_integrations: [{ oauth_third_party: [{ partner_client_id: 'test-client', scopes }] }] };
      if (path === '/v2/checkout/orders' && method === 'POST') return { id: PAYPAL_ORDER, links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=' + PAYPAL_ORDER }] };
      if (path.endsWith('/capture')) { state.remote.status = 'COMPLETED'; state.remote.purchase_units[0].payments = { captures: [structuredClone(state.capture)] }; return structuredClone(state.remote); }
      if (path.endsWith('/refund')) return { id: 'TESTREFUND12345678', status: 'COMPLETED', amount: { currency_code: 'USD', value: '2.00' } };
      return structuredClone(state.remote);
    }
  };
  return { rt, state };
}

test('prices, fees, currency and seller routing are verified', () => {
  const { state } = fixture();
  assert.equal(feeFor(200), 20);
  assert.equal(cents({ currency_code: 'USD', value: '4.99' }), 499);
  assert.throws(() => cents({ currency_code: 'EUR', value: '2.00' }));
  assert.throws(() => feeFor(99));
  const bad = structuredClone(state.remote); bad.purchase_units[0].payee.merchant_id = PLATFORM_MERCHANT;
  assert.throws(() => verifyOrder(bad, state.order));
  const fee = structuredClone(state.remote); fee.purchase_units[0].payment_instruction.platform_fees[0].amount.value = '0.01';
  assert.throws(() => verifyOrder(fee, state.order));
  const totals = structuredClone(state.capture); totals.seller_receivable_breakdown.net_amount.value = '1.99';
  assert.throws(() => verifyCapture(totals, state.order));
  assert.deepEqual(verifyCapture(state.capture, state.order), { processingFee: 40, net: 140 });
  assert.equal(refundBody(state.order).payment_instruction.platform_fees[0].amount.value, '0.20');
});
test('seller readiness requires payment, refund and platform-fee consent for this app', () => {
  const seller = { merchant_id: SELLER_MERCHANT, payments_receivable: true, primary_email_confirmed: true,
    oauth_integrations: [{ oauth_third_party: [{ partner_client_id: 'test-client', scopes }] }] };
  assert.equal(sellerReadiness(seller, 'test-client').ready, true);
  assert.equal(sellerReadiness(seller, 'unrelated-client').ready, false);
  seller.oauth_integrations[0].oauth_third_party[0].scopes = scopes.slice(0, 2);
  assert.equal(sellerReadiness(seller, 'test-client').ready, false);
});
test('paused checkout does not create an order or contact PayPal', async () => {
  const { rt, state } = fixture(); state.enabled = false;
  await assert.rejects(createCheckout(rt, 'marketplace', { id: BUYER }, { item_id: LISTING }), /Payments paused/);
  assert.equal(state.calls.length, 0); assert.equal(state.writes.length, 0);
});
test('checkout ignores buyer-supplied prices and redirects to the implemented return route', async () => {
  const { rt, state } = fixture();
  const result = await createCheckout(rt, 'marketplace', { id: BUYER }, { item_id: LISTING, amount_cents: 1 });
  assert.equal(state.order.amount_cents, 200); assert.equal(state.order.platform_fee_cents, 20);
  const create = state.calls.find(x => x.path === '/v2/checkout/orders');
  assert.ok(create.body.payment_source.paypal.experience_context.return_url.includes('/paypal-checkout-return.html?kind=marketplace&order='));
  assert.equal(result.environment, 'live');
});
test('capture rejects a different buyer and a mismatched PayPal reference', async () => {
  const { rt, state } = fixture();
  await assert.rejects(captureCheckout(rt, 'marketplace', { id: SELLER }, { order_id: ORDER, paypal_order_id: PAYPAL_ORDER }), /not found/);
  await assert.rejects(captureCheckout(rt, 'marketplace', { id: BUYER }, { order_id: ORDER, paypal_order_id: 'OTHERORDER12345678' }), /does not match/);
  assert.equal(state.calls.length, 0);
});
test('capture confirms payment and retry does not make a second charge', async () => {
  const { rt, state } = fixture();
  const body = { order_id: ORDER, paypal_order_id: PAYPAL_ORDER };
  const result = await captureCheckout(rt, 'marketplace', { id: BUYER }, body);
  assert.equal(result.ok, true); assert.equal(state.order.payment_status, 'paid');
  assert.equal(state.order.fulfillment_status, 'available');
  await captureCheckout(rt, 'marketplace', { id: BUYER }, body);
  assert.equal(state.calls.filter(x => x.path.endsWith('/capture')).length, 1);
});
test('pending capture never marks an order paid or unlocks delivery', async () => {
  const { rt, state } = fixture(); state.capture.status = 'PENDING';
  const result = await captureCheckout(rt, 'marketplace', { id: BUYER }, { order_id: ORDER, paypal_order_id: PAYPAL_ORDER });
  assert.equal(result.status, 'PENDING'); assert.equal(result.ok, false);
  assert.equal(state.order.payment_status, 'pending'); assert.equal(state.order.fulfillment_status, undefined);
});
test('refund requires seller or admin and returns the full platform fee once', async () => {
  const { rt, state } = fixture('service');
  state.order.payment_status = 'paid'; state.order.paypal_capture_id = CAPTURE;
  state.remote.purchase_units[0].payments = { captures: [state.capture] };
  await assert.rejects(refundCheckout(rt, 'service', { id: BUYER }, { order_id: ORDER }), /not found/);
  const refund = await refundCheckout(rt, 'service', { id: SELLER }, { order_id: ORDER });
  assert.equal(refund.refund_status, 'succeeded'); assert.equal(state.order.payment_status, 'refunded');
  const call = state.calls.find(x => x.path.endsWith('/refund'));
  assert.equal(call.body.payment_instruction.platform_fees[0].amount.value, '0.20');
  await refundCheckout(rt, 'service', { id: SELLER }, { order_id: ORDER });
  assert.equal(state.calls.filter(x => x.path.endsWith('/refund')).length, 1);
});
test('service completion does not send another payment or payout', async () => {
  const { rt, state } = fixture('service');
  state.order.payment_status = 'paid'; state.order.paypal_capture_id = CAPTURE; state.order.status = 'in_progress';
  await completeService(rt, { id: SELLER }, { order_id: ORDER });
  assert.equal(state.order.status, 'completed'); assert.equal(state.calls.length, 0);
  await completeService(rt, { id: SELLER }, { order_id: ORDER });
  assert.equal(state.writes.length, 1);
});
test('an unverified webhook cannot change payment records', async () => {
  const { rt, state } = fixture();
  const request = new Request('https://example.test/webhook', { method: 'POST', body: JSON.stringify({ id: 'event-test', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: CAPTURE } }) });
  await assert.rejects(webhook(rt, request), /signature/); assert.equal(state.writes.length, 0);
});
test('the HTTP handler rejects an unrelated origin and unsupported methods', async () => {
  const { rt, state } = fixture();
  const run = handler('marketplace-create', rt);
  assert.equal((await run(new Request('https://example.test', { method: 'POST', headers: { Origin: 'https://unrelated.test' } }))).status, 403);
  assert.equal((await run(new Request('https://example.test'))).status, 405);
  assert.equal(state.writes.length, 0);
});

async function browserAdapter({ ready = true, url = 'https://www.paypal.com/checkoutnow?token=TEST', auth = true } = {}) {
  const calls = []; const redirects = [];
  const context = { URL, URLSearchParams, console, Date, document: { addEventListener() {} }, window: { location: { assign: x => redirects.push(x) },
    supabase: { createClient: () => ({ auth: { getUser: async () => ({ data: { user: auth ? { id: BUYER } : null } }) }, functions: { invoke: async (name, args) => {
      calls.push({ name, body: args.body });
      return { data: name === 'paypal-platform-status' ? { environment: 'live', payments_enabled: ready } : { environment: 'live', order_id: ORDER, paypal_order_id: PAYPAL_ORDER, approval_url: url } };
    } } }) } } };
  vm.runInNewContext(await readFile(new URL('../css/payments.js', import.meta.url), 'utf8'), context);
  return { api: context.window.StarRisePayments, calls, redirects };
}
test('browser checkout fails closed while the server is paused', async () => {
  const { api, calls, redirects } = await browserAdapter({ ready: false });
  await assert.rejects(api.checkout('marketplace', { item_id: LISTING }), /awaiting activation/);
  assert.deepEqual(calls.map(x => x.name), ['paypal-platform-status']); assert.equal(redirects.length, 0);
});
test('browser uses the correct service and marketplace endpoints', async () => {
  for (const [kind, name, body] of [['marketplace', 'create-marketplace-checkout', { item_id: LISTING }], ['service', 'paypal-live-create-service-order', { service_id: LISTING, request_message: 'Test service' }]]) {
    const { api, calls, redirects } = await browserAdapter(); await api.checkout(kind, body);
    assert.equal(calls.at(-1).name, name); assert.equal(redirects.length, 1);
  }
});
test('browser refuses sandbox or unrelated checkout redirects', async () => {
  for (const url of ['https://www.sandbox.paypal.com/checkoutnow', 'https://unrelated.test', 'https://user@www.paypal.com/checkoutnow']) {
    const { api, redirects } = await browserAdapter({ url });
    await assert.rejects(api.checkout('marketplace', { item_id: LISTING }), /valid checkout link/);
    assert.equal(redirects.length, 0);
  }
});
test('anonymous browser sessions cannot start checkout', async () => {
  const { api, calls } = await browserAdapter({ auth: false });
  await assert.rejects(api.checkout('service', { service_id: LISTING }), /sign in/); assert.equal(calls.length, 0);
});
