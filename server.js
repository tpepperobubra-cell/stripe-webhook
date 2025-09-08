import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for demonstration (use a database in production)
const processedEvents = new Set();
const stripeEvents = [];

// Stripe requires raw body for signature verification
app.post(
  '/api/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook signature verified for event:', event.id);
    } catch (err) {
      console.error('❌ Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency check
    if (processedEvents.has(event.id)) {
      console.log(`🔄 Event ${event.id} already processed - SKIPPING`);
      return res.json({ received: true, processed: false, reason: 'duplicate', event_id: event.id });
    }

    try {
      const rawEventRecord = {
        event_id: event.id,
        type: event.type,
        created: event.created,
        raw_payload: event,
        processed_at: new Date().toISOString(),
        retry_detected: false
      };

      stripeEvents.push(rawEventRecord);
      processedEvents.add(event.id);
      console.log('📝 Raw event logged:', event.id, event.type);

      if (event.type === 'checkout.session.completed') {
        await processCheckoutCompleted(event.data.object);
      }

      console.log(`✅ Successfully processed event: ${event.id}`);
      res.json({ received: true, processed: true, event_id: event.id, event_type: event.type });

    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      processedEvents.delete(event.id);
      res.status(500).json({ error: 'Processing failed', event_id: event.id });
    }
  }
);

// Health check
app.get('/api/webhook', (req, res) => {
  res.json({
    status: 'healthy',
    processed_events: processedEvents.size,
    logged_events: stripeEvents.length,
    recent_events: stripeEvents.slice(-5).map(e => ({
      id: e.event_id,
      type: e.type,
      processed_at: e.processed_at
    }))
  });
});

// --- Helper functions ---

async function processCheckoutCompleted(session) {
  console.log('Processing checkout for session:', session.id);

  const subscriptionRecord = {
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
    currency: session.currency
  };

  // Check for PHENOM100 coupon
  if (session.total_details?.breakdown?.discounts) {
    for (const discount of session.total_details.breakdown.discounts) {
      if (discount.discount?.coupon?.id === 'PHENOM100') {
        subscriptionRecord.phenom_code = 'PHENOM100';
        subscriptionRecord.phenom_partner = true;
        console.log('🎯 PHENOM100 coupon detected');
        break;
      }
    }
  }

  // Infer source_channel from client_reference_id if metadata missing
  if (!subscriptionRecord.source_channel && session.client_reference_id) {
    const ref = session.client_reference_id.toLowerCase();
    if (ref.includes('social')) subscriptionRecord.source_channel = 'social';
    else if (ref.includes('sms')) subscriptionRecord.source_channel = 'sms';
    else if (ref.includes('email')) subscriptionRecord.source_channel = 'email';
    else if (ref.includes('phenom_landing')) subscriptionRecord.source_channel = 'phenom_landing';
  }

  await storeSubscription(subscriptionRecord);
  console.log('✅ Subscription record processed:', subscriptionRecord);
}

async function storeSubscription(record) {
  console.log('📊 Storing subscription record:', record);

  // Simulate Airtable API
  /*
  const airtablePayload = {
    records: [{ fields: { ... } }]
  };
  const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Subscriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(airtablePayload)
  });
  if (!response.ok) throw new Error(`Airtable API error: ${response.statusText}`);
  */
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
