import express from 'express';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for demo (replace with DB for production)
const processedEvents = new Set();
const stripeEvents = [];

// CRITICAL: Handle webhook route with custom raw body parsing
// This completely bypasses Express middleware to preserve the raw body
app.use('/api/webhook', (req, res, next) => {
  if (req.method !== 'POST') return next();
  
  let data = '';
  req.setEncoding('utf8');
  
  req.on('data', (chunk) => {
    data += chunk;
  });
  
  req.on('end', async () => {
    const sig = req.headers['stripe-signature'];
    
    // Debug logging
    console.log('🔍 Webhook received (raw parsing):');
    console.log('- Raw data type:', typeof data);
    console.log('- Raw data length:', data.length);
    console.log('- Signature present:', !!sig);
    console.log('- Signature value:', sig ? sig.substring(0, 20) + '...' : 'MISSING');
    console.log('- Webhook secret set:', !!process.env.STRIPE_WEBHOOK_SECRET);
    console.log('- Raw data preview:', data.substring(0, 100));

    if (!sig) {
      console.error('❌ No Stripe signature header found');
      return res.status(400).send('No Stripe signature header found');
    }

    if (!data || data.length === 0) {
      console.error('❌ Empty request body');
      return res.status(400).send('Empty request body');
    }

    let event;
    try {
      // Convert string to Buffer for Stripe verification
      const bodyBuffer = Buffer.from(data, 'utf8');
      console.log('- Buffer created, length:', bodyBuffer.length);
      
      event = stripe.webhooks.constructEvent(
        bodyBuffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook signature verified for event:', event.id);
    } catch (err) {
      console.error('❌ Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Process the webhook
    try {
      // Idempotency check
      if (processedEvents.has(event.id)) {
        console.log(`🔄 Event ${event.id} already processed - SKIPPING`);
        return res.json({ received: true, processed: false, reason: 'duplicate', event_id: event.id });
      }

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
  });
  
  req.on('error', (err) => {
    console.error('❌ Request error:', err);
    res.status(400).send('Request error');
  });
});

// Apply JSON middleware for all other routes AFTER the webhook route
app.use(express.json());

// Root route for health checks
app.get('/', (req, res) => {
  res.json({ 
    status: 'Stripe webhook server running',
    timestamp: new Date().toISOString()
  });
});

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

// Debug route to check environment variables (remove in production)
app.get('/api/debug', (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    webhook_secret_starts_with: process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 6),
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY
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

  // PHENOM100 coupon detection
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
  const airtablePayload = {
    records: [{
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
        'Amount': record.amount_total,
        'Currency': record.currency,
        'Created': record.created_at
      }
    }]
  };

  // Using built-in fetch (available in Node.js 18+)
  const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Subscriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(airtablePayload)
  });

  if (!response.ok) {
    throw new Error(`Airtable API error: ${response.statusText}`);
  }

  console.log('🎯 Stored subscription in Airtable:', record.subscription_id);
}

// Start server with explicit host binding for Railway
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
  console.log(`Environment check:`);
  console.log(`- Stripe key set: ${!!process.env.STRIPE_SECRET_KEY}`);
  console.log(`- Webhook secret set: ${!!process.env.STRIPE_WEBHOOK_SECRET}`);
  console.log(`- Webhook secret starts with: ${process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 6) || 'NOT_SET'}`);
  
  // Log successful startup to confirm server is ready
  console.log('✅ Server is ready to receive requests');
});

// Handle server errors
server.on('error', (err) => {
  console.error('❌ Server error:', err);
});

// Graceful shutdown handlers
const gracefulShutdown = () => {
  console.log('📝 Received shutdown signal, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.log('⚠️  Forcing exit...');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Keep process alive
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});
