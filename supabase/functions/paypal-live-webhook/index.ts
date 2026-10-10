import { handler } from "../_shared/paypal-handlers.ts";
Deno.serve(handler("webhook"));

