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
    version: "2.1",
  });
});

// Webhook endpoint — use raw body for signature verification
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("🎯 NEW VERSION 2.1 - Webhook endpoint hit");

    let totalLength = 0;
    req.on('data', chunk => {
      totalLength += chunk.length;
      console.log(`📦 Received chunk, total length so far: ${totalLength}`);
    });

    req.on('end', () => {
      console.log('🏁 Request body complete');
      console.log('📊 Final stats:');
      console.log('- Body length:', req.body.length);
      console.log('- Body type:', typeof req.body);
      console.log('- First 50 chars:', req.body.toString().substring(0, 50));
      console.log('- Signature header:', req.headers["stripe-signature"] ? 'Present' : 'Missing');
    });

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      console.log("🔐 Attempting signature verification...");
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
      console.log("✅ Event processed successfully");
    } catch (err) {
      console.error("❌ Processing error:", err);
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
    // Get additional data from Stripe if needed
    const customer = session.customer ? await stripe.customers.retrieve(session.customer) : null;
    const subscription = session.subscription ? await stripe.subscriptions.retrieve(session.subscription) : null;
    
    await storeSubscription(session, customer, subscription);
    console.log("✅ Subscription stored in Airtable");
  } catch (err) {
    console.error("❌ Processing error:", err);
  }
}

//
// === Airtable integration ===
//

async function storeSubscription(session, customer = null, subscription = null) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;

  if (!baseId || !apiKey) {
    throw new Error("Missing Airtable credentials");
  }

  const tableName = "Stripes Signups"; // Updated to correct table name
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;

  // Map session data to your Airtable fields
  const record = {
    fields: {
      "Email": session.customer_details?.email || session.customer_email,
      "Full Name": session.customer_details?.name || customer?.name || "",
      "Stripe Customer ID": session.customer || "",
      "Stripe Subscription ID": session.subscription || "",
      "Plan": subscription?.items?.data[0]?.price?.nickname || subscription?.items?.data[0]?.price?.id || "",
      "Status": session.payment_status || "paid",
      // Optional fields - you can populate these from session metadata if available
      "Phenom_Partner": session.metadata?.phenom_partner || "",
      "UTM_Source": session.metadata?.utm_source || "",
      "UTM_Medium": session.metadata?.utm_medium || "",
      "UTM_Campaign": session.metadata?.utm_campaign || "",
      "Promo Code": session.discount?.coupon?.id || "",
      // Next Invoice Date will be calculated by Stripe for subscriptions
      "Next Invoice Date": subscription?.current_period_end ? 
        new Date(subscription.current_period_end * 1000).toISOString().split('T')[0] : ""
    },
  };

  console.log("📤 Sending record to Airtable:", JSON.stringify(record, null, 2));

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
    console.error(`❌ Airtable error details:`, {
      status: res.status,
      statusText: res.statusText,
      response: errorText,
      url,
      baseId,
      tableName,
      apiKeyPrefix: apiKey?.slice(0, 8) + '...'
    });
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
  console.log("✅ Version 2.1 ready");
});
