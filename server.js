import express from "express";
import Stripe from "stripe";
import axios from "axios";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for demo (replace with DB for production)
const processedEvents = new Set();
const stripeEvents = [];

// --- Stripe Webhook Raw Body Handler ---
app.use("/api/webhook", (req, res, next) => {
  if (req.method !== "POST") return next();

  let data = "";
  req.setEncoding("utf8");

  req.on("data", (chunk) => {
    data += chunk;
  });

  req.on("end", async () => {
    const sig = req.headers["stripe-signature"];

    console.log("🔍 Webhook received:");
    console.log("- Raw data length:", data.length);
    console.log("- Signature present:", !!sig);

    if (!sig) {
      console.error("❌ No Stripe signature header found");
      return res.status(400).send("Missing signature");
    }

    if (!data) {
      console.error("❌ Empty body");
      return res.status(400).send("Empty body");
    }

    let event;
    try {
      const bodyBuffer = Buffer.from(data, "utf8");
      event = stripe.webhooks.constructEvent(
        bodyBuffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("✅ Signature verified:", event.id);
    } catch (err) {
      console.error("❌ Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // Idempotency check
      if (processedEvents.has(event.id)) {
        console.log(`🔄 Event ${event.id} already processed`);
        return res.json({ received: true, processed: false });
      }

      const rawEventRecord = {
        event_id: event.id,
        type: event.type,
        created: event.created,
        raw_payload: event,
        processed_at: new Date().toISOString(),
      };

      stripeEvents.push(rawEventRecord);
      processedEvents.add(event.id);

      if (event.type === "checkout.session.completed") {
        await processCheckoutCompleted(event.data.object);
      }

      console.log(`✅ Processed event: ${event.id}`);
      res.json({ received: true, processed: true });
    } catch (error) {
      console.error("❌ Error processing webhook:", error);
      processedEvents.delete(event.id);
      res.status(500).json({ error: "Processing failed" });
    }
  });

  req.on("error", (err) => {
    console.error("❌ Request error:", err);
    res.status(400).send("Request error");
  });
});

// Apply JSON middleware for all other routes AFTER webhook
app.use(express.json());

// Root route for health check
app.get("/", (req, res) => {
  res.json({
    status: "Stripe webhook server running",
    timestamp: new Date().toISOString(),
  });
});

// Webhook status check
app.get("/api/webhook", (req, res) => {
  res.json({
    status: "healthy",
    processed_events: processedEvents.size,
    logged_events: stripeEvents.length,
    recent_events: stripeEvents.slice(-5).map((e) => ({
      id: e.event_id,
      type: e.type,
      processed_at: e.processed_at,
    })),
  });
});

// Debug route (remove in production)
app.get("/api/debug", (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
  });
});

// --- Helpers ---
async function processCheckoutCompleted(session) {
  console.log("Processing checkout:", session.id);

  const subscriptionRecord = {
    customer_id: session.customer,
    subscription_id: session.subscription,
    session_id: session.id,
    price_id: session.line_items?.data?.[0]?.price?.id || null,
    product_id: session.line_items?.data?.[0]?.price?.product || null,
    source_channel: session.metadata?.source_channel || "",
    utm_source: session.metadata?.utm_source || "",
    utm_medium: session.metadata?.utm_medium || "",
    utm_campaign: session.metadata?.utm_campaign || "",
    created_at: new Date().toISOString(),
    amount_total: session.amount_total,
    currency: session.currency,
  };

  // Detect coupon
  if (session.total_details?.breakdown?.discounts) {
    for (const discount of session.total_details.breakdown.discounts) {
      if (discount.discount?.coupon?.id === "PHENOM100") {
        subscriptionRecord.phenom_code = "PHENOM100";
        subscriptionRecord.phenom_partner = true;
        console.log("🎯 PHENOM100 coupon detected");
        break;
      }
    }
  }

  await storeSubscription(subscriptionRecord);
  console.log("✅ Subscription saved:", subscriptionRecord.subscription_id);
}

async function storeSubscription(record) {
  const airtablePayload = {
    records: [{ fields: record }],
  };

  const response = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Subscriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(airtablePayload),
    }
  );

  if (!response.ok) {
    throw new Error(`Airtable API error: ${response.statusText}`);
  }
  console.log("🎯 Sent subscription to Airtable");
}

// --- Start server ---
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
  console.log(`✅ Ready to receive requests`);
});

// Handle server errors
server.on("error", (err) => {
  console.error("❌ Server error:", err);
});

// --- Keep Alive Hack ---
// Self-ping every 5 minutes to avoid idle shutdown
setInterval(() => {
  axios
    .get(`http://localhost:${PORT}/`)
    .then(() => console.log("🔄 Keep-alive ping sent"))
    .catch((err) => console.error("❌ Keep-alive ping failed:", err.message));
}, 5 * 60 * 1000);

// --- Ignore termination signals ---
process.on("SIGTERM", () => {
  console.log("⚠️  SIGTERM received but ignored to keep server alive");
});
process.on("SIGINT", () => {
  console.log("⚠️  SIGINT received but ignored to keep server alive");
});

// --- Error handlers ---
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Rejection:", err);
});
