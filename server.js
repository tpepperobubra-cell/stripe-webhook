// server.js
import express from "express";
import Stripe from "stripe";
import "dotenv/config"; // load .env locally
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 8080;

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const zapierWebhookUrl = process.env.ZAPIER_WEBHOOK_URL;

// Root health endpoint
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Server alive", timestamp: new Date() });
});

// Debug endpoint
app.get("/api/debug", (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    zapier_webhook_set: !!process.env.ZAPIER_WEBHOOK_URL,
  });
});

// Stripe webhook (raw body required)
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      console.log(`✅ Verified event: ${event.id} (${event.type})`);
    } catch (err) {
      console.error("❌ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        await processCheckoutCompleted(event);
      } else {
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }
    } catch (err) {
      console.error("❌ Event processing failed:", err);
      return res.status(500).send("Internal Server Error");
    }

    res.json({ received: true });
  }
);

// --- Handlers ---
async function processCheckoutCompleted(event) {
  const session = event.data.object;
  console.log("💳 Processing checkout session:", session.id);

  let customer = null;
  let subscription = null;

  try {
    if (session.customer) {
      customer = await stripe.customers.retrieve(session.customer);
    }
    if (session.subscription) {
      subscription = await stripe.subscriptions.retrieve(session.subscription);
    }

    await sendToZapier(session, customer, subscription);
    console.log("✅ Session sent to Zapier");
  } catch (err) {
    console.error("❌ Failed to send session to Zapier:", err);
  }
}

// --- Zapier integration ---
async function sendToZapier(session, customer = null, subscription = null) {
  if (!zapierWebhookUrl) throw new Error("Missing Zapier webhook URL");

  const payload = {
    session_id: session.id,
    customer_email: session.customer_details?.email || session.customer_email || "",
    customer_name: session.customer_details?.name || customer?.name || "",
    stripe_customer_id: session.customer || "",
    stripe_subscription_id: session.subscription || "",
    amount_total: session.amount_total ? session.amount_total / 100 : 0,
    currency: session.currency?.toUpperCase() || "",
    payment_status: session.payment_status || "",
    plan_name:
      subscription?.items?.data?.[0]?.price?.nickname ||
      subscription?.items?.data?.[0]?.price?.id ||
      "",
    subscription_status: subscription?.status || "",
    created_at: new Date().toISOString(),
    promo_code: session.total_details?.breakdown?.discounts?.[0]?.discount?.coupon?.id || "",
    utm_source: session.metadata?.utm_source || "",
    utm_medium: session.metadata?.utm_medium || "",
    utm_campaign: session.metadata?.utm_campaign || "",
    source_channel: session.metadata?.source_channel || "",
  };

  const res = await fetch(zapierWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zapier webhook failed: ${text}`);
  }

  console.log("✅ Zapier webhook call successful");
  return await res.json();
}

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${port}`);
  console.log("✅ Ready to receive webhooks");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down...");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down...");
  process.exit(0);
});
