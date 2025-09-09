// server.js
import express from "express";
import Stripe from "stripe";
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
    airtable_base_id: process.env.AIRTABLE_BASE_ID?.slice(0, 10) + "..." || "NOT_SET",
    airtable_key_prefix: process.env.AIRTABLE_API_KEY?.slice(0, 10) + "..." || "NOT_SET",
    version: "2.3",
  });
});

// Test Airtable connection endpoint
app.get("/api/test-airtable", async (req, res) => {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    
    if (!baseId || !apiKey) {
      return res.status(500).json({ error: "Missing Airtable credentials" });
    }

    const tableName = "Stripes Signups";
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?maxRecords=1`;
    
    console.log("🧪 Testing Airtable connection...");
    console.log("URL:", url);
    console.log("Base ID:", baseId);
    console.log("API Key prefix:", apiKey.slice(0, 10) + "...");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    console.log("Response status:", response.status);
    console.log("Response headers:", Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Airtable error:", errorText);
      return res.status(response.status).json({
        error: "Airtable API error",
        status: response.status,
        statusText: response.statusText,
        response: errorText
      });
    }

    const data = await response.json();
    console.log("✅ Airtable connection successful");
    
    res.json({
      success: true,
      message: "Airtable connection working",
      recordCount: data.records?.length || 0,
      fields: data.records?.[0]?.fields ? Object.keys(data.records[0].fields) : []
    });

  } catch (error) {
    console.error("Test error:", error);
    res.status(500).json({
      error: "Test failed",
      message: error.message
    });
  }
});

// Webhook endpoint — use raw body for signature verification
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("🎯 NEW VERSION 2.3 - Webhook endpoint hit");

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

  // Create a new table name with timestamp to avoid conflicts
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const tableName = `Stripe_Webhooks_${timestamp}`;
  
  console.log("📋 Creating new table:", tableName);

  // First, create the table with proper field definitions
  const createTableUrl = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
  
  const tableSchema = {
    name: tableName,
    description: "Stripe webhook data from checkout sessions",
    fields: [
      { name: "Session ID", type: "singleLineText" },
      { name: "Customer Email", type: "email" },
      { name: "Customer Name", type: "singleLineText" },
      { name: "Stripe Customer ID", type: "singleLineText" },
      { name: "Stripe Subscription ID", type: "singleLineText" },
      { name: "Amount Total", type: "currency", options: { precision: 2 } },
      { name: "Currency", type: "singleLineText" },
      { name: "Payment Status", type: "singleSelect", options: { 
        choices: [
          { name: "paid" },
          { name: "unpaid" },
          { name: "no_payment_required" }
        ]
      }},
      { name: "Plan Name", type: "singleLineText" },
      { name: "Subscription Status", type: "singleLineText" },
      { name: "Created At", type: "dateTime" },
      { name: "Metadata", type: "longText" }
    ]
  };

  console.log("🏗️ Creating table with schema...");
  
  const createRes = await fetch(createTableUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tableSchema),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    console.error(`❌ Table creation error:`, {
      status: createRes.status,
      statusText: createRes.statusText,
      response: errorText
    });
    throw new Error(`Failed to create table: ${createRes.status} ${errorText}`);
  }

  const tableData = await createRes.json();
  console.log("✅ Table created successfully:", tableData.name);

  // Wait a moment for table to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Now insert the record into the new table
  const recordsUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;

  const record = {
    fields: {
      "Session ID": session.id || "",
      "Customer Email": session.customer_details?.email || session.customer_email || "",
      "Customer Name": session.customer_details?.name || customer?.name || "",
      "Stripe Customer ID": session.customer || "",
      "Stripe Subscription ID": session.subscription || "",
      "Amount Total": session.amount_total ? session.amount_total / 100 : 0,
      "Currency": session.currency?.toUpperCase() || "",
      "Payment Status": session.payment_status || "",
      "Plan Name": subscription?.items?.data[0]?.price?.nickname || 
                   subscription?.items?.data[0]?.price?.id || "",
      "Subscription Status": subscription?.status || "",
      "Created At": new Date().toISOString(),
      "Metadata": JSON.stringify({
        session_metadata: session.metadata || {},
        subscription_metadata: subscription?.metadata || {},
        utm_source: session.metadata?.utm_source,
        utm_medium: session.metadata?.utm_medium,
        utm_campaign: session.metadata?.utm_campaign,
        promo_code: session.discount?.coupon?.id
      }, null, 2)
    },
  };

  console.log("📤 Sending record to new table:", JSON.stringify(record, null, 2));

  const res = await fetch(recordsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records: [record] }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`❌ Record insertion error:`, {
      status: res.status,
      statusText: res.statusText,
      response: errorText,
      tableName
    });
    throw new Error(`Failed to insert record: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  console.log("✅ Record created in new table:", JSON.stringify(data, null, 2));
  console.log(`🎉 Data stored in table: ${tableName}`);
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
  console.log("✅ Version 2.3 ready");
});
