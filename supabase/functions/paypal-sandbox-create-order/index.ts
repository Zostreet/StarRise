const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";
const SITE_URL = "https://starrisebyfament.com";
const ALLOWED_ORIGINS = new Set([
  SITE_URL,
  "https://www.starrisebyfament.com",
  "https://zostreet.github.io",
]);

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  try {
    requireSandbox();
    const user = await requireAdmin(request);
    const accessToken = await getPayPalAccessToken();
    const attributionId = Deno.env.get("PAYPAL_PARTNER_ATTRIBUTION_ID")?.trim();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
    };
    if (attributionId) headers["PayPal-Partner-Attribution-Id"] = attributionId;

    const paypalResponse = await fetch(`${PAYPAL_SANDBOX}/v2/checkout/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        intent: "CAPTURE",
        payment_source: {
          paypal: {
            experience_context: {
              payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
              brand_name: "StarRise by FAM ENT",
              landing_page: "LOGIN",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: `${SITE_URL}/paypal-sandbox-checkout.html?paypal=return`,
              cancel_url: `${SITE_URL}/paypal-sandbox-checkout.html?paypal=cancel`,
            },
          },
        },
        purchase_units: [{
          reference_id: "STARRISE-SANDBOX-TEST",
          custom_id: user.id,
          description: "StarRise PayPal sandbox checkout test",
          amount: { currency_code: "USD", value: "1.00" },
        }],
      }),
    });

    const paypalOrder = await paypalResponse.json().catch(() => null);
    if (!paypalResponse.ok || !paypalOrder?.id) {
      console.error(
        "PayPal create order failed",
        paypalResponse.status,
        paypalOrder?.name,
        paypalOrder?.debug_id,
      );
      throw new HttpError(502, "PayPal could not create the sandbox order.");
    }

    const approvalUrl = Array.isArray(paypalOrder.links)
      ? paypalOrder.links.find((link: { rel?: string }) =>
        link.rel === "payer-action" || link.rel === "approve"
      )?.href
      : undefined;
    if (!approvalUrl) throw new HttpError(502, "PayPal did not return an approval link.");

    await insertSandboxOrder(user.id, paypalOrder.id);

    return json({
      order_id: paypalOrder.id,
      approval_url: approvalUrl,
      amount: "1.00",
      currency: "USD",
      environment: "sandbox",
    }, 200, cors);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("PayPal sandbox create order error", status, message);
    return json({
      error: status >= 500 ? "Unable to start the sandbox checkout." : message,
    }, status, cors);
  }
});

function requireSandbox() {
  if ((Deno.env.get("PAYPAL_ENVIRONMENT") || "").toLowerCase() !== "sandbox") {
    throw new HttpError(409, "PayPal sandbox checkout is disabled outside sandbox mode.");
  }
}

async function requireAdmin(request: Request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "Unauthorized");

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: serviceKey },
  });
  if (!userResponse.ok) throw new HttpError(401, "Unauthorized");

  const user = await userResponse.json();
  if (!user?.id || user?.is_anonymous === true) throw new HttpError(401, "Unauthorized");

  const adminResponse = await fetch(
    `${supabaseUrl}/rest/v1/platform_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
    { headers: serviceHeaders(serviceKey) },
  );
  const admins = await adminResponse.json().catch(() => null);
  if (!adminResponse.ok) throw new Error("Administrator lookup failed");
  if (!Array.isArray(admins) || !admins.length) {
    throw new HttpError(403, "Administrator access required");
  }
  return user as { id: string };
}

async function getPayPalAccessToken() {
  const clientId = requiredEnv("PAYPAL_CLIENT_ID");
  const secret = requiredEnv("PAYPAL_CLIENT_SECRET");
  const response = await fetch(`${PAYPAL_SANDBOX}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) throw new Error("PayPal authentication failed");
  return body.access_token as string;
}

async function insertSandboxOrder(userId: string, paypalOrderId: string) {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${supabaseUrl}/rest/v1/paypal_sandbox_orders`, {
    method: "POST",
    headers: {
      ...serviceHeaders(serviceKey),
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      paypal_order_id: paypalOrderId,
      amount_cents: 100,
      currency: "USD",
      status: "CREATED",
    }),
  });
  if (!response.ok) {
    console.error("Sandbox order database insert failed", response.status, paypalOrderId);
    throw new Error("StarRise could not record the sandbox order");
  }
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : SITE_URL,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function serviceHeaders(key: string) {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
    }
