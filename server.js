import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 8080;

// --- In-memory storage (replace with DB in production) ---
const processedEvents = new Set();
const stripeEvents = [];

// --- Webhook handler with raw body parsing ---
app.use("/api/webhook", (req, res, next) => {
  if (req.method !== "POST") return next();

  let data = "";
  req.setEncoding("utf8");

  req.on("data", (chunk) => {
    data += chunk;
  });

  req.on("end", async () => {
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      console.error("❌ Missing Stripe signature header");
      return res.status(400).send("Missing Stripe signature header");
    }

    let event;
    try {
      const bodyBuffer = Buffer.from(data, "utf8");
      event = stripe.webhooks.constructEvent(
        bodyBuffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log(`✅ Verified webhook event: ${event.id} (${event.type})`);
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (processedEvents.has(event.id)) {
        console.log(`🔄 Skipping duplicate event: ${event.id}`);
        return res.json({ received: true, processed: false });
      }

      // Store the event
      const record = {
        id: event.id,
        type: event.type,
        created: event.created,
        raw: event,
        processed_at: new Date().toISOString(),
      };
      stripeEvents.push(record);
      processedEvents.add(event.id);

      if (event.type === "checkout.session.completed") {
        await processCheckoutCompleted(event.data.object);
      }

      res.json({ received: true, processed: true });
    } catch (err) {
      console.error("❌ Error handling webhook:", err);
      processedEvents.delete(event.id);
      res.status(500).json({ error: "Failed to process event" });
    }
  });

  req.on("error", (err) => {
    console.error("❌ Request stream error:", err);
    res.status(400).send("Invalid request stream");
  });
});

// --- JSON middleware for other routes ---
app.use(express.json());

// --- Healthcheck ---
app.get("/", (req, res) => {
  res.status(200).json({
    status: "✅ Alive",
    timestamp: new Date().toISOString(),
  });
});

// --- Debug info (remove in production) ---
app.get("/api/debug", (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
  });
});

// --- Webhook status ---
app.get("/api/webhook", (req, res) => {
  res.json({
    status: "healthy",
    processed: processedEvents.size,
    logged: stripeEvents.length,
    recent: stripeEvents.slice(-5).map((e) => ({
      id: e.id,
      type: e.type,
      processed_at: e.processed_at,
    })),
  });
});

// --- Helpers ---
async function processCheckoutCompleted(session) {
  console.log("📝 Processing checkout:", session.id);

  const subscriptionRecord = {
    customer_id: session.customer,
    subscription_id: session.subscription,
    session_id: session.id,
    created_at: new Date().toISOString(),
    amount_total: session.amount_total,
    currency: session.currency,
  };

  await storeSubscription(subscriptionRecord);
  console.log("✅ Stored subscription:", subscriptionRecord.subscription_id);
}

async function storeSubscription(record) {
  const payload = {
    records: [
      {
        fields: {
          "Customer ID": record.customer_id,
          "Subscription ID": record.subscription_id,
          "Session ID": record.session_id,
          Amount: record.amount_total,
          Currency: record.currency,
          Created: record.created_at,
        },
      },
    ],
  };

  const response = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Subscriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    throw new Error(`Airtable API error: ${response.statusText}`);
  }
}

// --- Start server ---
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  console.log("📋 Env check:");
  console.log("- Stripe key set:", !!process.env.STRIPE_SECRET_KEY);
  console.log("- Webhook secret set:", !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log("- Airtable base set:", !!process.env.AIRTABLE_BASE_ID);
  console.log("- Airtable key set:", !!process.env.AIRTABLE_API_KEY);
  console.log("✅ Ready");
});

// --- Graceful shutdown ---
const shutdown = (signal) => {
  console.log(`🛑 Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });

  // Fallback: force exit after 10s
  setTimeout(() => {
    console.log("⚠️ Force exiting...");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
