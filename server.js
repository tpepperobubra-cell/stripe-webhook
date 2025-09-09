// server.js
import express from "express";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 8080;

// --- Stripe keys ---
const stripeKeys = {
  live: process.env.STRIPE_SECRET_KEY_LIVE,       // live key
  test: process.env.STRIPE_SECRET_KEY_TEST        // test key
};

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const zapierWebhookURL = process.env.ZAPIER_WEBHOOK_URL; // Zapier Webhook

// --- Helper: Create Stripe instance ---
function getStripeInstance(key) {
  return new Stripe(key, { apiVersion: "2023-10-16" });
}

// --- Select Stripe key based on livemode ---
function stripeForEvent(event) {
  const key = event.livemode ? stripeKeys.live : stripeKeys.test;
  if (!key) throw new Error(`Missing Stripe key for ${event.livemode ? "live" : "test"} mode`);
  return getStripeInstance(key);
}

// --- Health endpoint ---
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Server alive", timestamp: new Date() });
});

// --- Debug endpoint ---
app.get("/api/debug", (req, res) => {
  res.json({
    stripe_keys_set: {
      live: !!stripeKeys.live,
      test: !!stripeKeys.test
    },
    webhook_secret_set: !!webhookSecret,
    zapier_webhook_set: !!zapierWebhookURL
  });
});

// --- Stripe Webhook endpoint ---
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      // Use live key for webhook verification by default
      const stripe = getStripeInstance(stripeKeys.live || stripeKeys.test);
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

// --- Process checkout session ---
async function processCheckoutCompleted(event) {
  const session = event.data.object;
  console.log("💳 Processing checkout session:", session.id);

  let customer = null;
  let subscription = null;

  const stripe = stripeForEvent(event);

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
    console.error("❌ Failed to process session:", err);
  }
}

// --- Send session to Zapier webhook ---
async function sendToZapier(session, customer = null, subscription = null) {
  if (!zapierWebhookURL) throw new Error("Missing ZAPIER_WEBHOOK_URL");

  const payload = {
    sessionId: session.id,
    customerEmail: session.customer_details?.email || session.customer_email || "",
    customerName: session.customer_details?.name || customer?.name || "",
    stripeCustomerId: session.customer || "",
    stripeSubscriptionId: session.subscription || "",
    amountTotal: session.amount_total ? session.amount_total / 100 : 0,
    currency: session.currency?.toUpperCase() || "",
    paymentStatus: session.payment_status || "",
    planName:
      subscription?.items?.data?.[0]?.price?.nickname ||
      subscription?.items?.data?.[0]?.price?.id ||
      "",
    subscriptionStatus: subscription?.status || "",
    promoCode: session.total_details?.breakdown?.discounts?.[0]?.discount?.coupon?.id || "",
    utmSource: session.metadata?.utm_source || "",
    utmMedium: session.metadata?.utm_medium || "",
    utmCampaign: session.metadata?.utm_campaign || "",
    sourceChannel: session.metadata?.source_channel || "",
    livemode: session.livemode,
    createdAt: new Date().toISOString()
  };

  const res = await fetch(zapierWebhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zapier webhook failed: ${text}`);
  }
}

// --- Start server ---
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${port}`);
  console.log("✅ Ready to receive webhooks");
});

// --- Graceful shutdown ---
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down...");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down...");
  process.exit(0);
});
