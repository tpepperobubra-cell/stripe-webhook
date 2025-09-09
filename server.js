import express from "express";
import Stripe from "stripe";
import Airtable from "airtable";

const app = express();
const port = process.env.PORT || 8080;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16", // Use a stable API version to avoid issues with "2025-06-30.basil"
});

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);
const table = base(process.env.AIRTABLE_TABLE_NAME);

// Validate environment variables
const requiredEnvVars = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "AIRTABLE_API_KEY",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_TABLE_NAME",
];
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.error(`❌ Missing environment variable: ${envVar}`);
    process.exit(1);
  }
});

// Webhook endpoint
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    console.log("🔍 Webhook Debug Info:", {
      signature: sig || "Missing",
      bodyType: typeof req.body,
      isBuffer: Buffer.isBuffer(req.body),
      bodyLength: req.body?.length,
      bodyPreview: req.body ? req.body.toString().slice(0, 100) : "Empty",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ? "Set (hidden)" : "Missing",
      headers: req.headers, // Log all headers for inspection
    });

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("✅ Verified event:", event.id, event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        try {
          const created = await table.create([
            {
              fields: {
                Email: session.customer_details?.email || "unknown",
                Amount: session.amount_total / 100,
                Status: session.payment_status,
                SessionId: session.id,
                Created: new Date().toISOString(),
              },
            },
          ]);
          console.log("📦 Airtable record created:", created[0].id);
        } catch (err) {
          console.error("❌ Airtable insert failed:", err.message, err.stack);
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook verification failed:", err.message, err.stack);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// JSON parsing for other routes
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("✅ Server running at " + new Date().toISOString());
});

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${port}`);
  console.log("- Stripe key set:", !!process.env.STRIPE_SECRET_KEY);
  console.log("- Webhook secret set:", !!process.env.STRIPE_WEBHOOK_SECRET);
});
