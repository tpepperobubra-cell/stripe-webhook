import express from 'express';
import Stripe from 'stripe';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 8080;

// In-memory storage (replace with DB in production)
const processedEvents = new Set();
const stripeEvents = [];

/**
 * 🔐 Stripe Webhook Route
 * MUST come BEFORE express.json() so body is untouched
 */
app.post(
  '/api/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    if (!sig) {
      console.error('❌ No Stripe signature header found');
      return res.status(400).send('No Stripe signature header found');
    }

    try {
      // ✅ Pass raw buffer directly
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Signature verification failed:', err.message);
      console.error(
        '❌ Body preview (first 100 chars):',
        req.body.toString().substring(0, 100)
      );
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Prevent double-processing
    if (processedEvents.has(event.id)) {
      console.log(`🔄 Duplicate event ${event.id} skipped`);
      return res.json({
        received: true,
        processed: false,
        reason: 'duplicate',
        event_id: event.id,
      });
    }

    try {
      // Log raw event
      stripeEvents.push({
        event_id: event.id,
        type: event.type,
        created: event.created,
        raw_payload: event,
        processed_at: new Date().toISOString(),
      });
      processedEvents.add(event.id);

      console.log(`✅ Event received: ${event.id} (${event.type})`);

      // Handle subscription flow
      if (event.type === 'checkout.session.completed') {
        await processCheckoutCompleted(event.data.object);
      }

      res.json({
        received: true,
        processed: true,
        event_id: event.id,
        event_type: event.type,
      });
    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      processedEvents.delete(event.id);
      res.status(500).json({ error: 'Processing failed', event_id: event.id });
    }
  }
);

/**
 * 👇 All other routes use JSON body parsing
 */
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'Stripe webhook server running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/webhook', (req, res) => {
  res.json({
    status: 'healthy',
    processed_events: processedEvents.size,
    logged_events: stripeEvents.length,
    recent_events: stripeEvents.slice(-5).map((e) => ({
      id: e.event_id,
      type: e.type,
      processed_at: e.processed_at,
    })),
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    webhook_secret_starts_with:
      process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 6),
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
  });
});

/**
 * 📦 Checkout Session Processor
 */
async function processCheckoutCompleted(session) {
  console.log(`Processing checkout.session.completed: ${session.id}`);

  const record = {
    customer_id: session.customer,
    subscription_id: session.subscription,
    session_id: session.id,
    price_id: session.line_items?.data?.[0]?.price?.id || null,
    product_id: session.line_items?.data?.[0]?.price?.product || null,
    phenom_code: '',
    phenom_partner: false,
    source_channel: session.metadata?.source_channel || '',
    utm_source: session.metadata?.utm_source || '',
    utm_medium: session.metadata?.utm_medium || '',
    utm_campaign: session.metadata?.utm_campaign || '',
    created_at: new Date().toISOString(),
    amount_total: session.amount_total,
    currency: session.currency,
  };

  // Detect PHENOM100 coupon
  if (session.total_details?.breakdown?.discounts) {
    for (const discount of session.total_details.breakdown.discounts) {
      if (discount.discount?.coupon?.id === 'PHENOM100') {
        record.phenom_code = 'PHENOM100';
        record.phenom_partner = true;
        console.log('🎯 PHENOM100 coupon detected');
        break;
      }
    }
  }

  // Infer source_channel
  if (!record.source_channel && session.client_reference_id) {
    const ref = session.client_reference_id.toLowerCase();
    if (ref.includes('social')) record.source_channel = 'social';
    else if (ref.includes('sms')) record.source_channel = 'sms';
    else if (ref.includes('email')) record.source_channel = 'email';
    else if (ref.includes('phenom_landing'))
      record.source_channel = 'phenom_landing';
  }

  await storeSubscription(record);
  console.log('✅ Subscription record stored:', record.session_id);
}

/**
 * 🗄️ Airtable storage
 */
async function storeSubscription(record) {
  const payload = {
    records: [
      {
        fields: {
          'Customer ID': record.customer_id,
          'Subscription ID': record.subscription_id,
          'Price ID': record.price_id,
          'Product ID': record.product_id,
          'Phenom Code': record.phenom_code,
          'Phenom Partner': record.phenom_partner,
          'Source Channel': record.source_channel,
          'UTM Source': record.utm_source,
          'UTM Medium': record.utm_medium,
          'UTM Campaign': record.utm_campaign,
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
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    throw new Error(`Airtable API error: ${response.statusText}`);
  }

  console.log('🎯 Stored subscription in Airtable:', record.subscription_id);
}

/**
 * 🚀 Start server
 */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
  console.log('- Stripe key set:', !!process.env.STRIPE_SECRET_KEY);
  console.log('- Webhook secret set:', !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log('✅ Server is ready to receive requests');
});

/**
 * 🛑 Graceful shutdown
 */
const gracefulShutdown = () => {
  console.log('📝 Shutdown signal received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('⚠️ Forcing exit...');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});
