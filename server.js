import express from "express";
import Stripe from "stripe";
import Airtable from "airtable";

const app = express();
const port = process.env.PORT || 8080;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);
const table = base(process.env.AIRTABLE_TABLE_NAME);

// ✅ Webhook route first
app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      console.log("✅ Verified event:", event.id, event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        console.log("💰 Checkout completed:", session.id);

        try {
          // Example: write to Airtable
          const created = await table.create([
            {
              fields: {
                Email: session.customer_details?.email || "unknown",
                Amount: session.amount_total / 100, // convert cents to $
                Status: session.payment_status,
                SessionId: session.id,
                Created: new Date().toISOString(),
              },
            },
          ]);

          console.log("📦 Airtable record created:", created[0].id);
        } catch (err) {
          console.error("❌ Airtable insert failed:", err.message);
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ✅ Normal JSON parsing for other API routes
app.use(express.json());

// Health check (Railway needs this)
app.get("/", (req, res) => {
  res.send("✅ Server running - " + new Date().toISOString());
});

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${port}`);
  console.log("- Stripe key set:", !!process.env.STRIPE_SECRET_KEY);
  console.log("- Webhook secret set:", !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log("- Airtable key set:", !!process.env.AIRTABLE_API_KEY);
});
