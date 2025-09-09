import express from "express";
import Stripe from "stripe";
import { AbortController } from "node-abort-controller";

const app = express();
const port = process.env.PORT || 8080;

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Middleware
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM. Performing graceful shutdown...");
  server.close(() => {
    console.log("✅ Server closed. Exiting process...");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT. Performing graceful shutdown...");
  server.close(() => {
    console.log("✅ Server closed. Exiting process...");
    process.exit(0);
  });
});

// Root health endpoint
app.get("/", (req, res) => {
  console.log("🩺 Health check accessed");
  res.status(200).json({
    status: "healthy",
    service: "stripe-webhook-server",
    version: "2.5.1", // Updated version
    timestamp: new Date().toISOString(),
  });
});

// Debug endpoint
app.get("/api/debug", (req, res) => {
  console.log("🔍 Debug endpoint accessed");
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    webhook_secret_prefix: process.env.STRIPE_WEBHOOK_SECRET?.slice(0, 6) || "NOT_SET",
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
    airtable_base_id: process.env.AIRTABLE_BASE_ID?.slice(0, 10) + "..." || "NOT_SET",
    airtable_key_prefix: process.env.AIRTABLE_API_KEY?.slice(0, 10) + "..." || "NOT_SET",
    version: "2.5.1",
  });
});

// Test Airtable connection
app.get("/api/test-airtable", async (req, res) => {
  console.log("🧪 Testing Airtable connection");
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    if (!baseId || !apiKey) {
      console.error("❌ Missing Airtable credentials");
      return res.status(400).json({ error: "Missing Airtable credentials" });
    }

    const tableName = "Stripe Signups";
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?maxRecords=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Airtable API error:", errorText);
      return res.status(response.status).json({
        error: "Airtable API error",
        status: response.status,
        response: errorText,
      });
    }

    const data = await response.json();
    console.log("✅ Airtable connection successful");
    res.json({
      success: true,
      message: "Airtable connection successful",
      recordCount: data.records?.length || 0,
      fields: data.records?.[0]?.fields ? Object.keys(data.records[0].fields) : [],
    });
  } catch (error) {
    console.error("❌ Airtable test failed:", error.message, error.stack);
    res.status(500).json({ error: "Test failed", message: error.message });
  }
});

// Stripe webhook endpoint
app.post("/webhook", async (req, res) => {
  console.log("🎯 Webhook received");
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log(`✅ Verified event: ${event.id} ${event.type}`);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message, err.stack);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await processCheckoutCompleted(event);
        break;
      case "customer.subscription.created":
        console.log("📦 Subscription created:", event.data.object.id);
        break;
      case "customer.subscription.updated":
        console.log("🔄 Subscription updated:", event.data.object.id);
        break;
      case "customer.subscription.deleted":
        console.log("🗑️ Subscription deleted:", event.data.object.id);
        break;
      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }
    console.log("✅ Event processed successfully");
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Processing error:", err.message, err.stack);
    return res.status(500).send(`Internal Server Error: ${err.message}`);
  }
});

//
// === Handlers ===
//
async function processCheckoutCompleted(event) {
  const session = event.data.object;
  console.log("💳 Processing checkout session:", session.id);

  try {
    const customer = session.customer ? await stripe.customers.retrieve(session.customer) : null;
    const subscription = session.subscription ? await stripe.subscriptions.retrieve(session.subscription) : null;

    await storeSubscription(session, customer, subscription);
    console.log("✅ Subscription stored in Airtable");
  } catch (err) {
    console.error("❌ Checkout processing error:", err.message, err.stack);
    throw err;
  }
}

//
// === Airtable Integration ===
//
async function storeSubscription(session, customer = null, subscription = null) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;

  if (!baseId || !apiKey) {
    console.error("❌ Missing Airtable credentials");
    throw new Error("Missing Airtable credentials");
  }

  const tableName = "Stripe Signups";
  const recordsUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;

  const fields = {
    "Session ID": session.id,
    "Customer Email": session.customer_details?.email || session.customer_email,
    "Customer Name": session.customer_details?.name || customer?.name,
    "Stripe Customer ID": session.customer,
    "Stripe Subscription ID": session.subscription,
    "Amount Total": session.amount_total ? session.amount_total / 100 : undefined,
    "Currency": session.currency?.toUpperCase(),
    "Payment Status": session.payment_status,
    "Plan Name": subscription?.items?.data[0]?.price?.nickname || subscription?.items?.data[0]?.price?.id,
    "Subscription Status": subscription?.status,
    "Created At": new Date().toISOString(),
    "Metadata": JSON.stringify(
      {
        session_metadata: session.metadata || {},
        subscription_metadata: subscription?.metadata || {},
        utm_source: session.metadata?.utm_source,
        utm_medium: session.metadata?.utm_medium,
        utm_campaign: session.metadata?.utm_campaign,
        promo_code: session.discount?.coupon?.id,
      },
      null,
      2
    ),
  };

  // Remove undefined or null fields
  Object.keys(fields).forEach((key) => {
    if (fields[key] === undefined || fields[key] === null) {
      delete fields[key];
    }
  });

  const record = { fields };
  console.log("📤 Inserting record:", JSON.stringify(record, null, 2));

  // Retry logic
  const retry = async (fn, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === retries - 1) throw err;
        console.log(`🔄 Retrying Airtable request (${i + 1}/${retries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const res = await retry(() =>
    fetch(recordsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [record] }),
      signal: controller.signal,
    })
  );

  clearTimeout(timeoutId);

  if (!res.ok) {
    const errorText = await res.text();
    console.error("❌ Airtable insert error:", errorText);
    throw new Error(`Failed to insert record: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  console.log("✅ Record stored:", JSON.stringify(data, null, 2));
  return data;
}

//
// === Start Server ===
//
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${port}`);
  console.log("📋 Environment check:");
  console.log("- Stripe key set:", !!process.env.STRIPE_SECRET_KEY);
  console.log("- Webhook secret set:", !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log("- Airtable base set:", !!process.env.AIRTABLE_BASE_ID);
  console.log("- Airtable key set:", !!process.env.AIRTABLE_API_KEY);
  console.log("✅ Version 2.5.1 ready");
});
