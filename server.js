// server.js
import express from "express";
import Stripe from "stripe";
import "dotenv/config"; // load .env locally
import fetch from "node-fetch"; // ensure installed: npm install node-fetch

const app = express();
const port = process.env.PORT || 8080;

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Health/debug endpoint
app.get("/api/debug", (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    webhook_secret_prefix: process.env.STRIPE_WEBHOOK_SECRET?.slice(0, 6) || "NOT_SET",
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
    version: "2.0",
  });
});

// Webhook endpoint — use raw body for signature verification
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("🎯 Webhook endpoint hit");

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        webhookSecret
      );
      console.log(`✅ SUCCESS! Event verified: ${event.id} ${event.type}`);
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await processCheckoutCompleted(event);
          break;
        case "customer.subscription.created":
          console.log("📦 Subscription created:", event.data.object.id);
          // TODO: could also call storeSubscription with subscription object
          break;
        default:
          console.log(`ℹ️ Unhandled event type ${event.type}`);
      }
    } catch (err) {
      console.error("❌ Error processing event:", err);
      return res.status(500).send("Internal Server Error");
    }

    res.json({ received: true });
  }
);

//
// === Handlers ===
//

async function processCheckoutCompleted(event) {
  const session = event.data.object;

  console.log("💳 Processing checkout completion...");
  console.log("Processing checkout for session:", session.id);

  try {
    await storeSubscription(session);
    console.log("✅ Subscription stored in Airtable");
  } catch (err) {
    console.error("❌ Processing error:", err);
  }
}

//
// === Airtable integration ===
//

async function storeSubscription(session) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;

  if (!baseId || !apiKey) {
    throw new Error("Missing Airtable credentials");
  }

  const tableName = "Subscriptions"; // Change if your Airtable table has a different name
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;

  const record = {
    fields: {
      StripeSessionId: session.id,
      CustomerEmail: session.customer_email,
      AmountTotal: session.amount_total ? session.amount_total / 100 : null,
      Currency: session.currency,
      Status: session.payment_status,
    },
  };

  console.log("📤 Sending record to Airtable:", record);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records: [record] }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Airtable API error: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  console.log("✅ Airtable record created:", JSON.stringify(data, null, 2));
  return data;
}

//
// === Start server ===
//

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${port}`);
  console.log("📋 Environment check:");
  console.log("- Stripe key set:", !!process.env.STRIPE_SECRET_KEY);
  console.log("- Webhook secret set:", !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log(
    "- Webhook secret starts with:",
    process.env.STRIPE_WEBHOOK_SECRET?.slice(0, 6) || "NOT_SET"
  );
  console.log("✅ Version 2.0 ready");
});
