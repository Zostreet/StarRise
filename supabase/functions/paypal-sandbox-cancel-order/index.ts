const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";
const SITE_URL = "https://starrisebyfament.com";
const ALLOWED_ORIGINS = new Set([
  SITE_URL,
  "https://www.starrisebyfament.com",
  "https://zostreet.github.io",
]);

type SandboxOrder = {
  paypal_order_id: string;
  paypal_capture_id: string | null;
  status: string;
};

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
    const body = await request.json().catch(() => ({}));
    const orderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";
    if (!/^[A-Z0-9]{8,30}$/i.test(orderId)) {
      throw new HttpError(400, "Invalid PayPal order ID");
    }

    const existing = await getSandboxOrder(user.id, orderId);
    if (!existing) throw new HttpError(404, "This sandbox order was not found.");
    if (existing.status === "COMPLETED" || existing.paypal_capture_id) {
      throw new HttpError(409, "This sandbox order has a capture record and cannot be canceled.");
    }
    if (existing.status === "CANCELLED") {
      return json({ order_id: orderId, status: "CANCELLED", already_canceled: true }, 200, cors);
    }

    const accessToken = await getPayPalAccessToken();
    const paypalOrder = await getPayPalOrder(orderId, accessToken);
    verifyPayPalOrder(paypalOrder, user.id, orderId);

    const capture = findCapture(paypalOrder);
    if (capture?.id) {
      throw new HttpError(
        409,
        `PayPal already has a ${capture.status || "recorded"} capture. Resume reconciliation instead.`,
      );
    }
    if (["APPROVED", "COMPLETED"].includes(paypalOrder?.status)) {
      throw new HttpError(409, "This PayPal order was approved. Resume capture instead of canceling it.");
    }
    if (!["CREATED", "SAVED", "PAYER_ACTION_REQUIRED", "VOIDED"].includes(paypalOrder?.status)) {
      throw new HttpError(409, "PayPal did not return a safely cancelable order state.");
    }

    await updateSandboxOrder(user.id, orderId, { status: "CANCELLED" });
    return json({ order_id: orderId, status: "CANCELLED" }, 200, cors);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("PayPal sandbox cancel error", status, message);
    return json({
      error: status >= 500 ? "Unable to cancel the sandbox checkout." : message,
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

async function getSandboxOrder(userId: string, orderId: string): Promise<SandboxOrder | null> {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(
    `${supabaseUrl}/rest/v1/paypal_sandbox_orders?user_id=eq.${encodeURIComponent(userId)}` +
      `&paypal_order_id=eq.${encodeURIComponent(orderId)}` +
      "&select=paypal_order_id,paypal_capture_id,status&limit=1",
    { headers: serviceHeaders(serviceKey) },
  );
  const rows = await response.json().catch(() => null);
  if (!response.ok) throw new Error("StarRise could not verify the sandbox order");
  return Array.isArray(rows) ? rows[0] || null : null;
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

async function getPayPalOrder(orderId: string, accessToken: string) {
  const response = await fetch(
    `${PAYPAL_SANDBOX}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id) {
    console.error("PayPal order lookup failed", response.status, body?.name, body?.debug_id);
    throw new HttpError(502, "PayPal could not verify this sandbox order.");
  }
  return body;
}

function verifyPayPalOrder(paypalOrder: any, userId: string, orderId: string) {
  const purchaseUnits = Array.isArray(paypalOrder?.purchase_units) ? paypalOrder.purchase_units : [];
  const unit = purchaseUnits[0];
  if (
    paypalOrder?.id !== orderId ||
    purchaseUnits.length !== 1 ||
    unit?.reference_id !== "STARRISE-SANDBOX-TEST" ||
    unit?.custom_id !== userId ||
    unit?.amount?.value !== "1.00" ||
    unit?.amount?.currency_code !== "USD"
  ) {
    throw new HttpError(409, "The PayPal order does not match the StarRise sandbox test.");
  }
}

function findCapture(paypalOrder: any) {
  const units = Array.isArray(paypalOrder?.purchase_units) ? paypalOrder.purchase_units : [];
  for (const unit of units) {
    const captures = Array.isArray(unit?.payments?.captures) ? unit.payments.captures : [];
    if (captures.length) return captures[0];
  }
  return null;
}

async function updateSandboxOrder(
  userId: string,
  orderId: string,
  changes: Record<string, unknown>,
) {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(
    `${supabaseUrl}/rest/v1/paypal_sandbox_orders?user_id=eq.${encodeURIComponent(userId)}` +
      `&paypal_order_id=eq.${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      headers: {
        ...serviceHeaders(serviceKey),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ ...changes, updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) throw new Error("StarRise could not save the sandbox cancellation");
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
