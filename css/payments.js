(function () {
  'use strict';
  const SITE = 'https://rcnikxotdalxtuvpmlvm.supabase.co';
  const KEY = 'sb_publishable_VVprrzpACjd89clo0tFs4Q_VAKVL3GN';
  let client;
  let cachedStatus;
  let statusAt = 0;
  const db = () => client || (client = window.supabase.createClient(SITE, KEY));
  async function invoke(name, body = {}) {
    const { data, error } = await db().functions.invoke(name, { body });
    if (error) {
      let message = 'PayPal could not complete this request. Please try again.';
      try {
        const detail = await error.context.clone().json();
        if (typeof detail.error === 'string') message = detail.error;
      } catch { /* Do not expose internal responses or credentials. */ }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  async function platform(refresh = false) {
    if (refresh || !cachedStatus || Date.now() - statusAt > 20000) {
      cachedStatus = await invoke('paypal-platform-status');
      statusAt = Date.now();
    }
    return cachedStatus;
  }
  function enabled(status) { return status?.environment === 'live' && status.payments_enabled === true; }
  async function signedIn() {
    const { data, error } = await db().auth.getUser();
    if (error || !data?.user || data.user.is_anonymous) throw new Error('Please sign in to StarRise before continuing.');
    return data.user;
  }
  function paypalLink(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.paypal.com' || url.username || url.password) {
      throw new Error('PayPal did not return a valid checkout link. No payment has been taken.');
    }
    return url.href;
  }
  function notice(status) {
    const available = enabled(status);
    document.querySelectorAll('[data-paypal-notice]').forEach(element => {
      const title = element.querySelector('strong');
      const description = element.querySelector('p');
      if (title) title.textContent = available ? 'PayPal checkout is available for verified sellers.' : 'PayPal payments are awaiting activation.';
      if (description) description.textContent = available
        ? 'Pay securely with PayPal. Your order is confirmed only after PayPal verifies the completed payment.'
        : 'Checkout will become available after PayPal marketplace approval and seller setup are verified. No payment is collected while checkout is paused.';
    });
  }
  async function checkout(kind, body) {
    await signedIn();
    const status = await platform(true);
    if (!enabled(status)) throw new Error('PayPal marketplace payments are awaiting activation. No payment has been taken.');
    const name = kind === 'service' ? 'paypal-live-create-service-order' : 'create-marketplace-checkout';
    const result = await invoke(name, body);
    if (result?.environment !== 'live' || !result.order_id || !result.paypal_order_id) throw new Error('StarRise could not verify this checkout. No payment has been taken.');
    const target = paypalLink(result.approval_url);
    window.location.assign(target);
  }
  async function sellerPanel() {
    const panel = document.getElementById('paypal-seller-panel');
    if (!panel) return;
    const status = panel.querySelector('[data-seller-status]');
    const setup = panel.querySelector('[data-seller-setup]');
    const consent = panel.querySelector('[data-seller-consent]');
    const refresh = panel.querySelector('[data-seller-refresh]');
    let available = false;
    function updateButton() { setup.disabled = !available || !consent.checked; }
    async function load() {
      available = false;
      updateButton();
      refresh.disabled = true;
      status.textContent = 'Checking your PayPal seller setup…';
      try {
        await signedIn();
        const result = await invoke('paypal-seller-status');
        notice(result.platform);
        if (!result.platform?.onboarding_available) {
          status.textContent = 'Seller connections are waiting for PayPal marketplace activation. You do not need to enter bank or payment details here.';
        } else if (result.seller?.ready) {
          status.textContent = 'Your PayPal seller account is verified' + (result.seller.account_suffix ? ' (ending ' + result.seller.account_suffix + ')' : '') + '. ' + (enabled(result.platform) ? 'You can receive payments for your listings.' : 'Checkout is awaiting activation.');
        } else {
          available = true;
          status.textContent = 'Connect PayPal to receive payments for your listings. PayPal will verify your account and permissions.';
        }
      } catch (error) { status.textContent = error.message; }
      finally { refresh.disabled = false; updateButton(); }
    }
    consent.addEventListener('change', updateButton);
    refresh.addEventListener('click', load);
    setup.addEventListener('click', async () => {
      if (!available || !consent.checked) return;
      setup.disabled = true;
      try {
        await signedIn();
        const result = await invoke('paypal-seller-onboarding', { consent: true });
        if (result.already_connected) { await load(); return; }
        if (result.environment !== 'live') throw new Error('PayPal seller setup is unavailable.');
        window.location.assign(paypalLink(result.onboarding_url));
      } catch (error) { status.textContent = error.message; updateButton(); }
    });
    await load();
  }
  async function returnPage() {
    const message = document.getElementById('paypal-return-status');
    if (!message) return;
    const retry = document.getElementById('paypal-return-retry');
    const continuation = document.getElementById('paypal-return-continue');
    const login = document.getElementById('paypal-return-login');
    const params = new URLSearchParams(window.location.search);
    const kind = params.get('kind');
    const order = params.get('order');
    const token = params.get('token');
    let complete = false;
    let busy = false;
    const valid = ['marketplace', 'service'].includes(kind) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(order || '') && /^[A-Z0-9]{8,30}$/.test(token || '');
    if (!valid) { message.textContent = 'This payment reference is incomplete. Check My Purchases or My Dashboard before starting another checkout.'; return; }
    async function verify() {
      if (busy || complete) return;
      busy = true;
      retry.hidden = true;
      login.hidden = true;
      message.textContent = 'Verifying your payment with PayPal…';
      try {
        try { await signedIn(); } catch {
          login.href = 'login.html?redirect=' + encodeURIComponent('paypal-checkout-return.html' + window.location.search);
          login.hidden = false;
          message.textContent = 'Sign in to the StarRise account that started this checkout to verify your payment.';
          return;
        }
        const result = await invoke(kind === 'service' ? 'paypal-live-capture-service-order' : 'paypal-marketplace-capture-order', { order_id: order, paypal_order_id: token });
        if (result?.ok === true && result.status === 'COMPLETED' && result.order_id === order && result.paypal_order_id === token && result.environment === 'live') {
          complete = true;
          message.textContent = kind === 'marketplace' ? 'Payment confirmed. Your purchase is available in My Purchases.' : 'Payment confirmed. Your service request is recorded in My Dashboard.';
          continuation.href = kind === 'marketplace' ? 'purchases.html' : 'dashboard.html';
          continuation.textContent = kind === 'marketplace' ? 'Open My Purchases' : 'Open My Dashboard';
          continuation.hidden = false;
        } else if (result?.status === 'PENDING') {
          message.textContent = 'PayPal is still processing this payment. Check again before starting another checkout.';
          retry.hidden = false;
        } else throw new Error('StarRise could not confirm this payment. Check your orders or contact support before paying again.');
      } catch (error) { message.textContent = error.message; retry.hidden = false; }
      finally { busy = false; }
    }
    retry.addEventListener('click', verify);
    await verify();
  }
  window.StarRisePayments = { client: db, invoke, platform, enabled, notice, checkout };
  document.addEventListener('DOMContentLoaded', () => {
    sellerPanel();
    returnPage();
  });
})();
