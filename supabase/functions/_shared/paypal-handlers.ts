import { PaymentError, SITE_URL, ORIGINS, PUBLISHABLE_KEY, createRuntime, type Runtime, feeFor, usd, cents, validUuid, validPayPalId, payPalUrl, sellerReadiness, purchaseUnit, verifyOrder, verifyCapture, refundBody } from "./paypal-platform.ts";

type Kind = "service" | "marketplace";
const tableFor = (kind: Kind) => kind === "service" ? "service_orders" : "marketplace_orders";
const now = () => new Date().toISOString();
const runtime = createRuntime(name => Deno.env.get(name));

export async function refreshSeller(rt: Runtime, userId: string) {
  const rows = await rt.db(`paypal_connected_accounts?user_id=eq.${encodeURIComponent(userId)}&environment=eq.live&select=*&limit=1`);
  const account = rows?.[0];
  if (!account) return { ready: false, paypal_merchant_id: null, account_status: "not_connected", payments_receivable: false, primary_email_confirmed: false, consent_granted: false, permissions: { payment: false, refund: false, platform_fee: false } };
  const cfg = await rt.settings();
  let remote;
  try {
    remote = await rt.paypal(`/v1/customer/partners/${encodeURIComponent(cfg.partner_merchant_id)}/merchant-integrations?tracking_id=${encodeURIComponent(account.tracking_id)}`);
  } catch (e) {
    if (!(e instanceof PaymentError && e.status === 404)) throw e;
    remote = {};
  }
  if (remote.tracking_id && remote.tracking_id !== account.tracking_id) throw new PaymentError(409, "SELLER_MISMATCH", "PayPal returned a different seller connection.");
  const state = sellerReadiness(remote, rt.clientId());
  // A platform fee account must not also be the seller receiving this purchase.
  if (remote.merchant_id === cfg.partner_merchant_id) state.ready = false;
  const updated = { paypal_merchant_id: remote.merchant_id || null,
    payments_receivable: remote.payments_receivable === true, primary_email_confirmed: remote.primary_email_confirmed === true,
    consent_granted: state.consent, capabilities_verified: state.ready, granted_scopes: state.scopes,
    account_status: state.ready ? "connected" : (remote.merchant_id ? "limited" : "pending"),
    last_verified_at: now(), updated_at: now(),
  };
  await rt.db(`paypal_connected_accounts?user_id=eq.${encodeURIComponent(userId)}&environment=eq.live`, "PATCH", updated);
  return { ...updated, ready: state.ready, permissions: state.permissions };
}

export async function startSeller(rt: Runtime, user: any, body: any) {
  if (body?.consent !== true) throw new PaymentError(400, "CONSENT_REQUIRED", "Please acknowledge the seller setup instructions first.");
  const platform = await rt.platformStatus();
  if (!platform.onboarding_available) throw new PaymentError(503, "PLATFORM_NOT_READY", platform.message);
  const existing = await refreshSeller(rt, user.id);
  if (existing.ready) return { already_connected: true, seller: existing };
  const trackingId = `starrise-live-${user.id}`;
  const rows = await rt.db("paypal_connected_accounts?on_conflict=user_id", "POST", {
    user_id: user.id, tracking_id: trackingId, environment: "live", account_status: "pending",
    payments_receivable: false, primary_email_confirmed: false, consent_granted: false, capabilities_verified: false,
    updated_at: now(),
  }, "resolution=merge-duplicates,return=representation");
  if (!rows?.length) throw new PaymentError(500, "DATABASE_ERROR", "Could not save seller setup.");
  const referral = await rt.paypal("/v2/customer/partner-referrals", "POST", {
    tracking_id: trackingId,
    operations: [{ operation: "API_INTEGRATION", api_integration_preference: { rest_api_integration: {
      integration_method: "PAYPAL", integration_type: "THIRD_PARTY",
      third_party_details: { features: ["PAYMENT", "REFUND", "PARTNER_FEE"] },
    } } }],
    products: ["EXPRESS_CHECKOUT"], legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    partner_config_override: { return_url: `${SITE_URL}/paypal-seller-setup.html?paypal=return`, return_url_description: "Return to StarRise seller setup" },
  });
  return { onboarding_url: payPalUrl(referral.links?.find((l: any) => l.rel === "action_url")?.href), environment: "live" };
}

export async function createCheckout(rt: Runtime, kind: Kind, user: any, body: any) {
  const platform = await rt.platformStatus();
  if (!platform.payments_enabled) throw new PaymentError(503, "PAYMENTS_PAUSED", platform.message);
  const id = kind === "service" ? body?.service_id : body?.item_id;
  if (!validUuid(id)) throw new PaymentError(400, "INVALID_ITEM", "Choose a valid StarRise listing.");
  const sourceTable = kind === "service" ? "star_rise_services" : "marketplace_items";
  const fields = kind === "service" ? "id,user_id,title,price_cents,is_active" : "id,seller_id,title,price_cents,status";
  const listings = await rt.db(`${sourceTable}?id=eq.${id}&select=${fields}&limit=1`);
  const listing = listings?.[0];
  if (!listing || (kind === "service" ? listing.is_active !== true : listing.status !== "active")) throw new PaymentError(404, "LISTING_UNAVAILABLE", "This listing is no longer available.");
  const sellerId = kind === "service" ? listing.user_id : listing.seller_id;
  if (!validUuid(sellerId) || sellerId === user.id) throw new PaymentError(400, "INVALID_SELLER", "You cannot purchase your own listing.");
  const message = typeof body?.request_message === "string" ? body.request_message.trim() : "";
  if (kind === "service" && (!message || message.length > 2000)) throw new PaymentError(400, "INVALID_REQUEST", "Describe your service request in 1–2000 characters.");
  const amount = Number(listing.price_cents);
  const fee = feeFor(amount);
  const seller = await refreshSeller(rt, sellerId);
  if (!seller.ready) throw new PaymentError(409, "SELLER_NOT_READY", "This seller has not completed PayPal setup yet. No payment has been taken.");
  const cfg = await rt.settings();
  const order = { id: crypto.randomUUID(), buyer_id: user.id, seller_id: sellerId, amount_cents: amount, platform_fee_cents: fee,
    paypal_seller_merchant_id: seller.paypal_merchant_id, paypal_platform_merchant_id: cfg.partner_merchant_id,
    paypal_environment: "live", payment_provider: "paypal_live",
    ...(kind === "service" ? { service_id: id, provider_amount_cents: amount - fee, request_message: message, status: "pending", payment_status: "unpaid", payout_status: "not_applicable" }
      : { item_id: id, seller_amount_cents: amount - fee, payment_status: "pending", fulfillment_status: "pending" }),
  };
  const unit = purchaseUnit(order, listing.title || "StarRise order");
  await rt.db(tableFor(kind), "POST", order);
  const remote = await rt.paypal("/v2/checkout/orders", "POST", {
    intent: "CAPTURE", purchase_units: [unit], payment_source: { paypal: { experience_context: {
      brand_name: "StarRise by FAM ENT", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
      return_url: `${SITE_URL}/paypal-checkout-return.html?kind=${kind}&order=${order.id}`,
      cancel_url: `${SITE_URL}/${kind === "service" ? `service.html?id=${id}&` : "marketplace.html?"}paypal=cancel`,
    } } },
  }, seller.paypal_merchant_id, order.id);
  if (!validPayPalId(remote.id)) throw new PaymentError(502, "INVALID_PAYPAL_ORDER", "PayPal did not create an order.");
  const approvalUrl = payPalUrl(remote.links?.find((l: any) => ["approve", "payer-action"].includes(l.rel))?.href);
  const saved = await rt.db(`${tableFor(kind)}?id=eq.${order.id}&buyer_id=eq.${user.id}`, "PATCH", { paypal_order_id: remote.id, updated_at: now() });
  if (!saved?.length) throw new PaymentError(500, "DATABASE_ERROR", "Could not link the PayPal order. No payment has been taken.");
  return { ok: true, order_id: order.id, service_order_id: kind === "service" ? order.id : undefined, paypal_order_id: remote.id,
    approval_url: approvalUrl, amount: usd(amount), platform_fee: usd(fee), currency: "USD", environment: "live" };
}

async function getOrder(rt: Runtime, kind: Kind, id: unknown) {
  if (!validUuid(id)) throw new PaymentError(400, "INVALID_ORDER", "Invalid StarRise order reference.");
  const rows = await rt.db(`${tableFor(kind)}?id=eq.${id}&select=*&limit=1`);
  if (!rows?.[0]) throw new PaymentError(404, "ORDER_NOT_FOUND", "This order was not found.");
  return rows[0];
}
function routedOrder(order: any) {
  if (order.payment_provider !== "paypal_live" || order.paypal_environment !== "live" || !order.paypal_seller_merchant_id || !order.paypal_platform_merchant_id) {
    throw new PaymentError(409, "LEGACY_PAYMENT", "This earlier payment requires support through its original payment setup.");
  }
}
const resultFor = (kind: Kind, order: any, captureId: string, status: string) => ({ ok: status === "COMPLETED", status, order_id: order.id,
  service_order_id: kind === "service" ? order.id : undefined, paypal_order_id: order.paypal_order_id, capture_id: captureId, environment: "live" });

export async function reconcilePayment(rt: Runtime, kind: Kind, order: any, remote: any) {
  routedOrder(order);
  const unit = verifyOrder(remote, order);
  const captures = unit.payments?.captures || [];
  if (captures.length !== 1) throw new PaymentError(409, "CAPTURE_MISSING", "PayPal has not confirmed a single full payment.");
  const capture = captures[0];
  const totals = verifyCapture(capture, order);
  if (order.paypal_capture_id && order.paypal_capture_id !== capture.id) throw new PaymentError(409, "CAPTURE_MISMATCH", "This payment has a different capture reference.");
  if (capture.status === "PENDING") return resultFor(kind, order, capture.id, "PENDING");
  if (capture.status !== "COMPLETED") throw new PaymentError(409, "PAYMENT_NOT_COMPLETED", "PayPal has not completed this payment.");
  if (["refunded", "refund_pending", "failed"].includes(order.payment_status) || order.refund_status === "pending") throw new PaymentError(409, "ORDER_CLOSED", "This order is closed or awaiting a refund.");
  if (order.payment_status === "paid") return resultFor(kind, order, capture.id, "COMPLETED");
  const condition = kind === "service" ? "unpaid,pending" : "pending";
  const saved = await rt.db(`${tableFor(kind)}?id=eq.${order.id}&payment_status=in.(${condition})`, "PATCH", {
    payment_status: "paid", paypal_capture_id: capture.id, paid_at: now(), updated_at: now(),
    paypal_processing_fee_cents: totals.processingFee, paypal_net_amount_cents: totals.net,
    ...(kind === "service" ? { payout_status: "paid" } : { fulfillment_status: "available" }),
  });
  if (!saved?.length) {
    const latest = await getOrder(rt, kind, order.id);
    if (latest.payment_status !== "paid" || latest.paypal_capture_id !== capture.id) throw new PaymentError(409, "ORDER_CHANGED", "Payment status changed. Please refresh this order.");
  }
  return resultFor(kind, order, capture.id, "COMPLETED");
}

export async function captureCheckout(rt: Runtime, kind: Kind, user: any, body: any) {
  const order = await getOrder(rt, kind, body?.order_id);
  if (order.buyer_id !== user.id) throw new PaymentError(404, "ORDER_NOT_FOUND", "This order was not found.");
  routedOrder(order);
  if (!validPayPalId(body?.paypal_order_id) || order.paypal_order_id !== body.paypal_order_id) throw new PaymentError(409, "PAYMENT_MISMATCH", "The PayPal reference does not match this order.");
  if (order.payment_status === "paid" && order.paypal_capture_id) return resultFor(kind, order, order.paypal_capture_id, "COMPLETED");
  const path = `/v2/checkout/orders/${order.paypal_order_id}`;
  let remote = await rt.paypal(path, "GET", undefined, order.paypal_seller_merchant_id);
  const unit = verifyOrder(remote, order);
  if (unit.payments?.captures?.length) return reconcilePayment(rt, kind, order, remote);
  if (remote.status !== "APPROVED") throw new PaymentError(409, "APPROVAL_REQUIRED", "Approve this payment in PayPal first.");
  const platform = await rt.platformStatus();
  if (!platform.payments_enabled) throw new PaymentError(503, "PAYMENTS_PAUSED", platform.message);
  const seller = await refreshSeller(rt, order.seller_id);
  if (!seller.ready || seller.paypal_merchant_id !== order.paypal_seller_merchant_id) throw new PaymentError(409, "SELLER_NOT_READY", "The seller's PayPal connection must be verified before payment.");
  await rt.paypal(`${path}/capture`, "POST", {}, order.paypal_seller_merchant_id, `capture-${order.id}`);
  // Re-read PayPal's canonical order, including routing, before releasing a file.
  remote = await rt.paypal(path, "GET", undefined, order.paypal_seller_merchant_id);
  return reconcilePayment(rt, kind, order, remote);
}

export async function refundCheckout(rt: Runtime, kind: Kind, user: any, body: any) {
  const order = await getOrder(rt, kind, body?.order_id);
  const admins = user.id === order.seller_id ? [] : await rt.db(`platform_admins?user_id=eq.${user.id}&select=user_id&limit=1`);
  if (user.id !== order.seller_id && !admins?.length) throw new PaymentError(404, "ORDER_NOT_FOUND", "This order was not found.");
  routedOrder(order);
  if (order.payment_status === "refunded") return { ok: true, refund_status: "succeeded", message: "This order has already been refunded." };
  if (!order.paypal_capture_id || !["paid", "refund_pending"].includes(order.payment_status)) throw new PaymentError(409, "ORDER_NOT_PAID", "Only a confirmed payment can be refunded.");
  let refund;
  if (order.paypal_refund_id) {
    refund = await rt.paypal(`/v2/payments/refunds/${order.paypal_refund_id}`, "GET", undefined, order.paypal_seller_merchant_id);
  } else {
    const remote = await rt.paypal(`/v2/checkout/orders/${order.paypal_order_id}`, "GET", undefined, order.paypal_seller_merchant_id);
    const unit = verifyOrder(remote, order);
    const capture = unit.payments?.captures?.find((c: any) => c.id === order.paypal_capture_id);
    verifyCapture(capture, order);
    if (capture.status !== "COMPLETED") throw new PaymentError(409, "REFUND_REQUIRES_SUPPORT", "This payment has already changed. Contact support to reconcile it before refunding.");
    // Stable idempotency key also covers retries after a database save failure.
    refund = await rt.paypal(`/v2/payments/captures/${order.paypal_capture_id}/refund`, "POST", refundBody(order), order.paypal_seller_merchant_id, `refund-${order.id}`);
  }
  if (!validPayPalId(refund?.id) || cents(refund.amount) !== order.amount_cents) throw new PaymentError(409, "REFUND_MISMATCH", "PayPal returned a different refund amount.");
  const succeeded = refund.status === "COMPLETED";
  if (!succeeded && refund.status !== "PENDING") throw new PaymentError(409, "REFUND_FAILED", "PayPal has not accepted this refund. Contact support before retrying.");
  await rt.db(`${tableFor(kind)}?id=eq.${order.id}&payment_status=in.(paid,refund_pending)`, "PATCH", {
    paypal_refund_id: refund.id, refund_status: succeeded ? "succeeded" : "pending", refunded_at: succeeded ? now() : null,
    payment_status: succeeded ? "refunded" : "refund_pending", updated_at: now(),
    ...(kind === "service" ? { status: "cancelled", ...(succeeded ? { payout_status: "not_applicable" } : {}) } : { fulfillment_status: "revoked" }),
  });
  return { ok: true, refund_id: refund.id, refund_status: succeeded ? "succeeded" : "pending", message: succeeded ? "The full payment was refunded, including StarRise's platform fee." : "PayPal is processing the full refund. Do not issue a second refund." };
}

export async function completeService(rt: Runtime, user: any, body: any) {
  const order = await getOrder(rt, "service", body?.order_id);
  if (order.seller_id !== user.id) throw new PaymentError(404, "ORDER_NOT_FOUND", "This service order was not found.");
  routedOrder(order);
  if (order.payment_status !== "paid" || !order.paypal_capture_id || order.refund_status === "pending") throw new PaymentError(409, "PAYMENT_REQUIRED", "A confirmed payment is required before completion.");
  if (order.status === "completed") return { ok: true, message: "This service is already complete. No additional payment was made." };
  if (!["accepted", "in_progress"].includes(order.status)) throw new PaymentError(409, "INVALID_STATUS", "Accept the paid service before completing it.");
  await rt.db(`service_orders?id=eq.${order.id}&seller_id=eq.${user.id}&payment_status=eq.paid&status=in.(accepted,in_progress)`, "PATCH", { status: "completed", updated_at: now() });
  return { ok: true, message: "Service completed. Seller proceeds were routed to PayPal when payment was confirmed; no additional transfer was made." };
}

export async function webhook(rt: Runtime, req: Request) {
  const event = await req.json().catch(() => null);
  if (!event?.id || !event?.event_type || !event?.resource) throw new PaymentError(400, "INVALID_WEBHOOK", "Invalid webhook.");
  const signature = await rt.paypal("/v1/notifications/verify-webhook-signature", "POST", {
    auth_algo: req.headers.get("paypal-auth-algo"), cert_url: req.headers.get("paypal-cert-url"),
    transmission_id: req.headers.get("paypal-transmission-id"), transmission_sig: req.headers.get("paypal-transmission-sig"),
    transmission_time: req.headers.get("paypal-transmission-time"), webhook_id: rt.required("PAYPAL_LIVE_WEBHOOK_ID"), webhook_event: event,
  });
  if (signature.verification_status !== "SUCCESS") throw new PaymentError(401, "INVALID_SIGNATURE", "Invalid webhook signature.");
  const resource = event.resource;
  if (event.event_type === "MERCHANT.PARTNER-CONSENT.REVOKED") {
    const id = String(resource.merchant_id || "");
    if (id) await rt.db(`paypal_connected_accounts?paypal_merchant_id=eq.${encodeURIComponent(id)}&environment=eq.live`, "PATCH", { account_status: "revoked", consent_granted: false, capabilities_verified: false, payments_receivable: false, updated_at: now() });
    return { received: true };
  }
  if (event.event_type === "MERCHANT.ONBOARDING.COMPLETED") {
    const tracking = String(resource.tracking_id || "");
    if (tracking) {
      const accounts = await rt.db(`paypal_connected_accounts?tracking_id=eq.${encodeURIComponent(tracking)}&environment=eq.live&select=user_id&limit=1`);
      if (accounts?.[0]) await refreshSeller(rt, accounts[0].user_id);
    }
    return { received: true };
  }
  const related = resource.supplementary_data?.related_ids || {};
  const refundEvent = event.event_type === "PAYMENT.CAPTURE.REFUNDED";
  const captureLink = resource.links?.find((l: any) => l.rel === "up")?.href;
  const captureFromLink = typeof captureLink === "string" ? /^https:\/\/(?:api-m|api)\.paypal\.com\/v2\/payments\/captures\/([A-Z0-9]{8,30})$/.exec(captureLink)?.[1] : undefined;
  const captureId = refundEvent ? (related.capture_id || captureFromLink) : resource.id;
  for (const kind of ["service", "marketplace"] as Kind[]) {
    const lookup = related.order_id ? `paypal_order_id=eq.${encodeURIComponent(related.order_id)}` : (captureId ? `paypal_capture_id=eq.${encodeURIComponent(captureId)}` : "");
    if (!lookup) continue;
    const rows = await rt.db(`${tableFor(kind)}?${lookup}&payment_provider=eq.paypal_live&paypal_environment=eq.live&select=*&limit=1`);
    const order = rows?.[0];
    if (!order) continue;
    routedOrder(order);
    const remote = await rt.paypal(`/v2/checkout/orders/${order.paypal_order_id}`, "GET", undefined, order.paypal_seller_merchant_id);
    const unit = verifyOrder(remote, order);
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      if (!unit.payments?.captures?.some((c: any) => c.id === resource.id)) throw new PaymentError(409, "PAYMENT_MISMATCH", "Webhook capture mismatch.");
      if (!["refunded", "refund_pending", "failed"].includes(order.payment_status)) await reconcilePayment(rt, kind, order, remote);
    } else if (refundEvent) {
      const refund = await rt.paypal(`/v2/payments/refunds/${resource.id}`, "GET", undefined, order.paypal_seller_merchant_id);
      if (refund.status === "COMPLETED" && cents(refund.amount) === order.amount_cents &&
          unit.payments?.captures?.some((c: any) => c.id === order.paypal_capture_id && ["REFUNDED", "PARTIALLY_REFUNDED"].includes(c.status))) {
        await rt.db(`${tableFor(kind)}?id=eq.${order.id}&payment_status=in.(paid,refund_pending)`, "PATCH", {
          payment_status: "refunded", refund_status: "succeeded", paypal_refund_id: refund.id, refunded_at: now(), updated_at: now(),
          ...(kind === "service" ? { status: "cancelled", payout_status: "not_applicable" } : { fulfillment_status: "revoked" }),
        });
      }
    } else if (["PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.DENIED"].includes(event.event_type)) {
      if (unit.payments?.captures?.some((c: any) => c.id === captureId && ["DECLINED", "DENIED", "FAILED", "REFUNDED"].includes(c.status))) {
        await rt.db(`${tableFor(kind)}?id=eq.${order.id}&payment_status=in.(pending,unpaid,paid)`, "PATCH", { payment_status: "failed", updated_at: now(), ...(kind === "service" ? { payout_status: "failed" } : { fulfillment_status: "revoked" }) });
      }
    }
  }
  return { received: true };
}

export function handler(action: string, rt: Runtime = runtime) {
  return async (req: Request) => {
    const origin = req.headers.get("Origin");
    const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin",
      "Access-Control-Allow-Origin": origin && ORIGINS.has(origin) ? origin : SITE_URL,
      "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    if (origin && !ORIGINS.has(origin)) return reply({ error: "Origin not allowed" }, 403);
    try {
      if (action === "webhook") return reply(await webhook(rt, req));
      if (action === "platform-status") {
        const apiKey = req.headers.get("apikey");
        if (!apiKey || ![PUBLISHABLE_KEY, rt.env("SUPABASE_ANON_KEY")].includes(apiKey)) throw new PaymentError(401, "UNAUTHORIZED", "Missing StarRise client key.");
        return reply(await rt.platformStatus());
      }
      const user = await rt.user(req);
      const body = await req.json().catch(() => ({}));
      if (action === "seller-start") return reply(await startSeller(rt, user, body));
      if (action === "seller-status") {
        const platform = await rt.platformStatus();
        const seller = platform.onboarding_available ? await refreshSeller(rt, user.id) : { ready: false, account_status: "not_connected" };
        const { granted_scopes: _scopes, paypal_merchant_id: merchant, ...safe } = seller as any;
        return reply({ platform, seller: { ...safe, account_suffix: merchant ? merchant.slice(-6) : null } });
      }
      if (action === "service-create" || action === "marketplace-create") return reply(await createCheckout(rt, action === "service-create" ? "service" : "marketplace", user, body));
      if (action === "service-capture" || action === "marketplace-capture") return reply(await captureCheckout(rt, action === "service-capture" ? "service" : "marketplace", user, body));
      if (action === "service-refund" || action === "marketplace-refund") return reply(await refundCheckout(rt, action === "service-refund" ? "service" : "marketplace", user, body));
      if (action === "service-complete") return reply(await completeService(rt, user, body));
      throw new PaymentError(404, "UNKNOWN_ACTION", "Unknown payment action.");
    } catch (e) {
      const known = e instanceof PaymentError;
      if (!known) console.error("StarRise PayPal handler failed", action, e instanceof Error ? e.name : "error");
      return reply({ error: known ? e.message : "StarRise could not verify this payment. Please retry or contact support.", code: known ? e.code : "PAYMENT_ERROR" }, known ? e.status : 500);
    }
  };
}

