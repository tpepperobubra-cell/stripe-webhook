// server.js
import express from "express";
import Stripe from "stripe";
import "dotenv/config"; // load .env locally

const app = express();
const port = process.env.PORT || 8080;

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Root health endpoint (Railway pings)
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Server alive", timestamp: new Date() });
});

// Debug endpoint
app.get("/api/debug", (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
  });
});

// Stripe webhook (raw body)
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

    await storeSubscription(session, customer, subscription);
    console.log("✅ Session stored in Airtable");
  } catch (err) {
    console.error("❌ Failed to store session:", err);
  }
}

// --- Airtable integration ---
async function storeSubscription(session, customer = null, subscription = null) {
  const { AIRTABLE_BASE_ID, AIRTABLE_API_KEY } = process.env;
  if (!AIRTABLE_BASE_ID || !AIRTABLE_API_KEY) {
    throw new Error("Missing Airtable credentials");
  }

  const tableName = "Stripe Signups"; // Existing table
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    tableName
  )}`;

  // Only include fields that exist in your table
  const recordFields = {
    "Session ID": session.id,
    "Customer Email": session.customer_details?.email || session.customer_email || "",
    "Customer Name": session.customer_details?.name || customer?.name || "",
    "Stripe Customer ID": session.customer || "",
    "Stripe Subscription ID": session.subscription || "",
    "Amount Total": session.amount_total ? session.amount_total / 100 : 0,
    "Currency": session.currency?.toUpperCase() || "",
    "Payment Status": session.payment_status || "",
    "Plan Name":
      subscription?.items?.data?.[0]?.price?.nickname ||
      subscription?.items?.data?.[0]?.price?.id ||
      "",
    "Subscription Status": subscription?.status || "",
    "Created At": new Date().toISOString(),
    "Promo Code": session.total_details?.breakdown?.discounts?.[0]?.discount?.coupon?.id || "",
    "UTM Source": session.metadata?.utm_source || "",
    "UTM Medium": session.metadata?.utm_medium || "",
    "UTM Campaign": session.metadata?.utm_campaign || "",
    "Source Channel": session.metadata?.source_channel || "",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records: [{ fields: recordFields }] }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Airtable insert failed: ${errorText}`);
  }

  const data = await res.json();
  console.log("✅ Airtable response:", data);
  return data;
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
