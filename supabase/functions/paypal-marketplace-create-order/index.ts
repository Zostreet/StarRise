
const SITE_URL = "https://starrisebyfament.com";
const PAYPAL_API = "https://api-m.sandbox.paypal.com";

const ALLOWED_ORIGINS = new Set([
  SITE_URL,
  "https://www.starrisebyfament.com",
  "https://zostreet.github.io",
]);

// Fixed $10 sandbox test, with a 10% StarRise fee.
// Never accept an amount or seller ID from the browser.
const TEST_AMOUNT_CENTS = 1000;
const PLATFORM_FEE_PERCENT = 10;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, cors);
  }

  try {
    if (
      Deno.env.get("PAYPAL_ENVIRONMENT")?.toLowerCase() !==
        "sandbox"
    ) {
      throw new HttpError(
        409,
        "This test is only available in PayPal sandbox mode.",
      );
    }

    const adminId = await requireAdmin(request);

    // Must be the PayPal sandbox merchant ID of the
    // connected test seller, not the buyer's account.
    const sellerId = requiredEnv(
      "PAYPAL_SANDBOX_SELLER_MERCHANT_ID",
    );

    const feeCents = Math.round(
      TEST_AMOUNT_CENTS * PLATFORM_FEE_PERCENT / 100,
    );

    const accessToken = await getPayPalAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
    };

    const attribution = Deno.env.get(
      "PAYPAL_PARTNER_ATTRIBUTION_ID",
    )?.trim();

    if (attribution) {
      headers["PayPal-Partner-Attribution-Id"] = attribution;
    }

    const orderBody = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: crypto.randomUUID(),
          custom_id: adminId,
          description: "StarRise 10% marketplace fee test",
          payee: {
            merchant_id: sellerId,
          },
          amount: {
            currency_code: "USD",
            value: money(TEST_AMOUNT_CENTS),
          },
          payment_instruction: {
            disbursement_mode: "INSTANT",
            platform_fees: [
              {
                amount: {
                  currency_code: "USD",
                  value: money(feeCents),
                },
              },
            ],
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "StarRise by FAM ENT",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url:
              `${SITE_URL}/paypal-sandbox-checkout.html?paypal=return`,
            cancel_url:
              `${SITE_URL}/paypal-sandbox-checkout.html?paypal=cancel`,
          },
        },
      },
    };

    const response = await fetch(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(orderBody),
      },
    );

    const paypalOrder = await response.json()
      .catch(() => null);

    if (!response.ok || !paypalOrder?.id) {
      console.error(
        "PayPal marketplace order creation failed",
        response.status,
        paypalOrder?.name,
        paypalOrder?.debug_id,
        paypalOrder?.details,
      );

      throw new HttpError(
        502,
        "PayPal rejected the marketplace fee order. Check function logs and partner permissions.",
      );
    }

    const approvalUrl = paypalOrder.links?.find(
      (link: { rel?: string }) =>
        link.rel === "payer-action" ||
        link.rel === "approve",
    )?.href;

    if (
      typeof approvalUrl !== "string" ||
      !approvalUrl.startsWith(
        "https://www.sandbox.paypal.com/",
      )
    ) {
      throw new HttpError(
        502,
        "PayPal did not provide a valid sandbox approval URL.",
      );
    }

    return json({
      success: true,
      environment: "sandbox",
      order_id: paypalOrder.id,
      approval_url: approvalUrl,
      amount: money(TEST_AMOUNT_CENTS),
      currency: "USD",
      platform_fee_percent: PLATFORM_FEE_PERCENT,
      platform_fee: money(feeCents),
      seller_amount_before_processing_fees:
        money(TEST_AMOUNT_CENTS - feeCents),
      status: "CREATED",
      message:
        "Order created. Fee collection is not confirmed until the order is captured and reconciled.",
    }, 200, cors);
  } catch (error) {
    const status = error instanceof HttpError
      ? error.status
      : 500;

    console.error(
      "StarRise marketplace fee test error",
      status,
      error instanceof Error ? error.message : error,
    );

    return json({
      error: status >= 500
        ? "Unable to create marketplace sandbox order."
        : (error as Error).message,
    }, status, cors);
  }
});

async function requireAdmin(
  request: Request,
): Promise<string> {
  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "Sign in required");
  }

  const url = requiredEnv("SUPABASE_URL");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const userResponse = await fetch(
    `${url}/auth/v1/user`,
    {
      headers: {
        Authorization: authorization,
        apikey: key,
      },
    },
  );

  if (!userResponse.ok) {
    throw new HttpError(401, "Invalid session");
  }

  const user = await userResponse.json();

  if (!user?.id || user.is_anonymous === true) {
    throw new HttpError(401, "Invalid user");
  }

  const adminResponse = await fetch(
    `${url}/rest/v1/platform_admins?user_id=eq.${
      encodeURIComponent(user.id)
    }&select=user_id`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
    },
  );

  if (!adminResponse.ok) {
    throw new HttpError(
      500,
      "Could not verify administrator access",
    );
  }

  const admins = await adminResponse.json();

  if (!Array.isArray(admins) || admins.length === 0) {
    throw new HttpError(
      403,
      "Administrator access required",
    );
  }

  return user.id;
}

async function getPayPalAccessToken(): Promise<string> {
  const clientId = requiredEnv("PAYPAL_CLIENT_ID");
  const secret = requiredEnv("PAYPAL_CLIENT_SECRET");

  const response = await fetch(
    `${PAYPAL_API}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Basic ${btoa(`${clientId}:${secret}`)}`,
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    },
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    throw new HttpError(
      502,
      "PayPal sandbox authentication failed",
    );
  }

  return data.access_token;
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();

  if (!value) {
    throw new HttpError(
      500,
      `Missing server configuration: ${name}`,
    );
  }

  return value;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "";

  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGINS.has(origin) ? origin : SITE_URL,
    "Access-Control-Allow-Headers":
      "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
