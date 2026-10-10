// Shared server configuration. Credentials never leave the edge runtime.
export const SITE_URL = "https://starrisebyfament.com";
export const PUBLISHABLE_KEY = "sb_publishable_VVprrzpACjd89clo0tFs4Q_VAKVL3GN";
export const ORIGINS = new Set([SITE_URL, "https://www.starrisebyfament.com", "https://zostreet.github.io"]);
export class PaymentError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export function usd(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new PaymentError(400, "INVALID_AMOUNT", "Invalid payment amount.");
  return (cents / 100).toFixed(2);
}
export function cents(money: any): number {
  if (money?.currency_code !== "USD" || !/^\d+(?:\.\d{1,2})?$/.test(String(money?.value))) {
    throw new PaymentError(409, "PAYMENT_MISMATCH", "PayPal returned an unexpected amount or currency.");
  }
  const [whole, fraction = ""] = String(money.value).split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new PaymentError(409, "PAYMENT_MISMATCH", "Invalid payment amount.");
  return result;
}
export function feeFor(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 10_000_000) {
    throw new PaymentError(400, "INVALID_AMOUNT", "Checkout supports amounts from $1.00 to $100,000.00.");
  }
  return Math.round(amount / 10);
}
export function validMerchant(id: unknown): boolean { return typeof id === "string" && /^[2-9A-HJ-NP-Z]{13}$/.test(id); }
export function validUuid(id: unknown): boolean { return typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id); }
export function validPayPalId(id: unknown): boolean { return typeof id === "string" && /^[A-Z0-9]{8,30}$/.test(id); }
export function payPalUrl(url: unknown): string {
  try {
    const u = new URL(String(url));
    if (u.protocol === "https:" && u.hostname === "www.paypal.com" && !u.username && !u.password) return u.href;
  } catch { /* Fail closed on an invalid or unrelated redirect. */ }
  throw new PaymentError(502, "INVALID_PAYPAL_LINK", "PayPal did not return a valid link.");
}
export function authAssertion(clientId: string, merchantId: string): string {
  const encode = (v: unknown) => btoa(JSON.stringify(v)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ iss: clientId, payer_id: merchantId })}.`;
}
export function sellerReadiness(status: any, clientId: string) {
  const integrations = (status?.oauth_integrations || []).flatMap((i: any) => i.oauth_third_party || []);
  const grant = integrations.find((i: any) => i.partner_client_id === clientId);
  const scopes: string[] = Array.isArray(grant?.scopes) ? grant.scopes.filter((s: any) => typeof s === "string") : [];
  const payment = scopes.some(s => ["https://uri.paypal.com/services/payments/realtimepayment", "https://uri.paypal.com/services/payments/payment/authcapture"].includes(s));
  const refund = scopes.includes("https://uri.paypal.com/services/payments/refund");
  const fee = scopes.includes("https://uri.paypal.com/services/payments/partnerfee");
  const denied = (status?.products || []).some((p: any) => ["DENIED", "DECLINED", "REVOKED"].includes(p.vetting_status || p.status));
  const ready = validMerchant(status?.merchant_id) && status.payments_receivable === true && status.primary_email_confirmed === true && payment && refund && fee && !denied;
  return { ready, scopes, consent: !!grant, permissions: { payment, refund, platform_fee: fee } };
}
export function purchaseUnit(order: any, title: string) {
  if (!validMerchant(order.paypal_seller_merchant_id) || !validMerchant(order.paypal_platform_merchant_id) || order.paypal_seller_merchant_id === order.paypal_platform_merchant_id) {
    throw new PaymentError(409, "SELLER_NOT_READY", "A separate, verified seller PayPal account is required.");
  }
  return {
    reference_id: order.id, custom_id: order.id, description: title.slice(0, 127),
    amount: { currency_code: "USD", value: usd(order.amount_cents) },
    payee: { merchant_id: order.paypal_seller_merchant_id },
    payment_instruction: { disbursement_mode: "INSTANT", platform_fees: [{
      amount: { currency_code: "USD", value: usd(order.platform_fee_cents) },
      payee: { merchant_id: order.paypal_platform_merchant_id },
    }] },
  };
}
export function verifyOrder(remote: any, order: any) {
  const unit = remote?.purchase_units?.[0];
  const fees = unit?.payment_instruction?.platform_fees;
  if (remote?.id !== order.paypal_order_id || remote?.purchase_units?.length !== 1 ||
      unit.reference_id !== order.id || unit.custom_id !== order.id ||
      cents(unit.amount) !== order.amount_cents || unit.payee?.merchant_id !== order.paypal_seller_merchant_id ||
      !Array.isArray(fees) || fees.length !== 1 || cents(fees[0].amount) !== order.platform_fee_cents ||
      fees[0].payee?.merchant_id !== order.paypal_platform_merchant_id || unit.payment_instruction.disbursement_mode !== "INSTANT") {
    throw new PaymentError(409, "PAYMENT_MISMATCH", "PayPal payment routing does not match this StarRise order.");
  }
  return unit;
}
export function verifyCapture(capture: any, order: any) {
  if (!validPayPalId(capture?.id) || cents(capture?.amount) !== order.amount_cents || capture.final_capture !== true) {
    throw new PaymentError(409, "PAYMENT_MISMATCH", "PayPal capture does not match this StarRise order.");
  }
  const breakdown = capture.seller_receivable_breakdown;
  if (capture.status === "COMPLETED") {
    const fees = breakdown?.platform_fees;
    if (!Array.isArray(fees) || fees.length !== 1 || cents(fees[0].amount) !== order.platform_fee_cents ||
        (fees[0].payee?.merchant_id && fees[0].payee.merchant_id !== order.paypal_platform_merchant_id) ||
        cents(breakdown.gross_amount) !== order.amount_cents) {
      throw new PaymentError(409, "PAYMENT_MISMATCH", "PayPal did not confirm the expected platform fee.");
    }
    const processingFee = cents(breakdown.paypal_fee);
    const net = cents(breakdown.net_amount);
    if (net + processingFee + order.platform_fee_cents !== order.amount_cents) {
      throw new PaymentError(409, "PAYMENT_MISMATCH", "PayPal seller totals do not match this order.");
    }
    return { processingFee, net };
  }
  return { processingFee: null, net: null };
}
export function refundBody(order: any) {
  return { amount: { currency_code: "USD", value: usd(order.amount_cents) },
    payment_instruction: { platform_fees: [{ amount: { currency_code: "USD", value: usd(order.platform_fee_cents) } }] } };
}
export function createRuntime(env: (name: string) => string | undefined, requestFetch: typeof fetch = fetch) {
  const required = (name: string) => {
    const v = env(name)?.trim();
    if (!v) throw new PaymentError(503, "CONFIGURATION_PENDING", "PayPal setup is awaiting platform configuration.");
    return v;
  };
  const dbHeaders = () => { const key = required("SUPABASE_SERVICE_ROLE_KEY"); return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }; };
  async function db(path: string, method = "GET", body?: unknown, prefer = "return=representation") {
    const r = await requestFetch(`${required("SUPABASE_URL")}/rest/v1/${path}`, {
      method, headers: { ...dbHeaders(), Prefer: prefer }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new PaymentError(500, "DATABASE_ERROR", "StarRise could not save or verify this payment. Please retry.");
    return data;
  }
  async function user(req: Request) {
    const authorization = req.headers.get("Authorization") || "";
    if (!authorization.startsWith("Bearer ")) throw new PaymentError(401, "UNAUTHORIZED", "Please sign in to StarRise.");
    const r = await requestFetch(`${required("SUPABASE_URL")}/auth/v1/user`, { headers: { ...dbHeaders(), Authorization: authorization }, signal: AbortSignal.timeout(15_000) });
    const u = await r.json().catch(() => null);
    if (!r.ok || !validUuid(u?.id) || u.is_anonymous === true) throw new PaymentError(401, "UNAUTHORIZED", "Please sign in to StarRise.");
    return u;
  }
  async function settings() {
    const rows = await db("paypal_platform_settings?singleton=eq.true&select=*&limit=1");
    const row = rows?.[0] || {};
    return { ...row,
      partner_merchant_id: row.partner_merchant_id || env("PAYPAL_LIVE_PARTNER_MERCHANT_ID") || env("PAYPAL_PARTNER_MERCHANT_ID") || env("PAYPAL_MERCHANT_ID") || "",
      partner_attribution_id: row.partner_attribution_id || env("PAYPAL_PARTNER_ATTRIBUTION_ID") || "",
    };
  }
  const clientId = () => required("PAYPAL_LIVE_CLIENT_ID");
  type AccessToken = { value: string; expiry: number; scopes: string[] };
  let cachedToken: AccessToken | null = null;
  let tokenRequest: Promise<AccessToken> | null = null;
  async function token() {
    if (cachedToken && cachedToken.expiry > Date.now()) return cachedToken;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const r = await requestFetch("https://api-m.paypal.com/v1/oauth2/token", { method: "POST",
        headers: { Authorization: `Basic ${btoa(`${clientId()}:${required("PAYPAL_LIVE_CLIENT_SECRET")}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials", signal: AbortSignal.timeout(20_000),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok || !b?.access_token) throw new PaymentError(503, "PAYPAL_AUTH_PENDING", "PayPal live credentials could not be verified.");
      cachedToken = { value: b.access_token, expiry: Date.now() + Math.max(30, Number(b.expires_in || 300) - 60) * 1000, scopes: String(b.scope || "").split(/\s+/) };
      return cachedToken;
    })();
    try { return await tokenRequest; } finally { tokenRequest = null; }
  }
  async function paypal(path: string, method = "GET", body?: unknown, seller?: string, requestId?: string) {
    const t = await token();
    const cfg = await settings();
    const headers: Record<string, string> = { Authorization: `Bearer ${t.value}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (cfg.partner_attribution_id) headers["PayPal-Partner-Attribution-Id"] = cfg.partner_attribution_id;
    if (seller) headers["PayPal-Auth-Assertion"] = authAssertion(clientId(), seller);
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const r = await requestFetch(`https://api-m.paypal.com${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25_000) });
    const b = await r.json().catch(() => null);
    if (!r.ok) {
      const issue = String(b?.details?.[0]?.issue || b?.name || "");
      console.error("PayPal API request failed", r.status, issue, b?.debug_id || "");
      if (r.status === 404) throw new PaymentError(404, "PAYPAL_RECORD_NOT_FOUND", "PayPal has not completed this account or payment yet.");
      if (issue === "INSTRUMENT_DECLINED") throw new PaymentError(422, issue, "Choose a different payment method in PayPal.");
      throw new PaymentError(502, "PAYPAL_REQUEST_FAILED", "PayPal could not complete this request. Please retry or contact support.");
    }
    return b;
  }
  async function platformStatus() {
    const cfg = await settings();
    const credentialsConfigured = !!env("PAYPAL_LIVE_CLIENT_ID")?.trim() && !!env("PAYPAL_LIVE_CLIENT_SECRET")?.trim();
    let credentialsVerified = false;
    let partnerPermissions = false;
    if (credentialsConfigured) {
      try {
        const t = await token(); credentialsVerified = true;
        partnerPermissions = t.scopes.includes("https://uri.paypal.com/services/payments/partnerfee") && t.scopes.some(s => /\/services\/customer\/partner-referrals(?:\/readwrite)?$/.test(s));
      } catch { /* Publish readiness only, never token values or API responses. */ }
    }
    const checks = { credentials_verified: credentialsVerified, partner_account: validMerchant(cfg.partner_merchant_id), partner_code: !!cfg.partner_attribution_id,
      partner_permissions: partnerPermissions, marketplace_approved: cfg.marketplace_approved === true, checkout_enabled: cfg.checkout_enabled === true,
      webhook_configured: !!env("PAYPAL_LIVE_WEBHOOK_ID")?.trim() };
    const onboarding = checks.credentials_verified && checks.partner_account && checks.partner_code && checks.partner_permissions && checks.marketplace_approved;
    return { environment: "live", onboarding_available: onboarding, payments_enabled: onboarding && checks.checkout_enabled && checks.webhook_configured,
      platform_fee_percent: 10, checks, message: onboarding ? (checks.checkout_enabled && checks.webhook_configured ? "PayPal checkout is available for verified sellers." : "Seller connections are available. Checkout is awaiting activation.") : "PayPal marketplace activation is pending. No payment has been taken." };
  }
  return { env, required, db, user, settings, clientId, token, paypal, platformStatus };
}
export type Runtime = ReturnType<typeof createRuntime>;

