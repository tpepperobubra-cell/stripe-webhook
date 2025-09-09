import express from "express";
import Stripe from "stripe";
import Airtable from "airtable";
import pino from "pino";
import retry from "p-retry";

const logger = pino();
const app = express();
const port = process.env.PORT || 8080;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    logger.error(`Missing environment variable: ${envVar}`);
    process.exit(1);
  }
});

// Webhook endpoint
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      logger.info({ eventId: event.id, eventType: event.type }, "Webhook received");

      switch (event.type) {
        case "checkout.session.completed":
          const session = event.data.object;
          // Check for duplicate session
          const existingRecords = await table
            .select({ filterByFormula: `{SessionId} = "${session.id}"` })
            .firstPage();
          if (existingRecords.length > 0) {
            logger.warn({ sessionId: session.id }, "Duplicate session, skipping");
            return res.json({ received: true });
          }

          // Create Airtable record with retry
          await retry(
            () =>
              table.create([
                {
                  fields: {
                    Email: session.customer_details?.email || "unknown",
                    Amount: session.amount_total / 100,
                    Status: session.payment_status,
                    SessionId: session.id,
                    Created: new Date().toISOString(),
                  },
                },
              ]),
            { retries: 3 }
          );
          logger.info({ sessionId: session.id }, "Airtable record created");
          break;

        default:
          logger.info({ eventType: event.type }, "Unhandled event type");
      }

      res.json({ received: true });
    } catch (err) {
      logger.error({ error: err.message }, "Webhook verification failed");
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// JSON parsing for other routes
app.use(express.json());

// Health check
app.get("/health", async (req, res) => {
  try {
    await stripe.balance.retrieve();
    await table.select({ maxRecords: 1 }).firstPage();
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "unhealthy", error: err.message });
  }
});

app.listen(port, "0.0.0.0", () => {
  logger.info(`Server listening on port ${port}`);
});
