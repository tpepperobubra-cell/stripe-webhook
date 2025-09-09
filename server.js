import express from "express";
import Stripe from "stripe";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 8080;

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// Middleware to parse JSON
app.use(express.json());

// 🔹 Health check (Railway uses this to verify the service is alive)
app.get("/", (req, res) => {
  res.status(200).send("✅ Server is alive");
});

// 🔹 Webhook endpoint
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Checkout session completed:", session.id);

    // Example: send to Airtable (via axios)
    if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) {
      axios.post(
        `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Payments`,
        {
          fields: {
            sessionId: session.id,
            amount_total: session.amount_total,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      )
      .then(() => console.log("📤 Saved to Airtable"))
      .catch((err) => console.error("❌ Airtable error:", err.message));
    }
  }

  res.json({ received: true });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
  console.log("📋 Env check:");
  console.log("- Stripe key set:", !!process.env.STRIPE_SECRET_KEY);
  console.log("- Webhook secret set:", !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log("- Airtable base set:", !!process.env.AIRTABLE_BASE_ID);
  console.log("- Airtable key set:", !!process.env.AIRTABLE_API_KEY);
  console.log("✅ Version 2.4 ready");
});
