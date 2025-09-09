import express from 'express';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for demo (replace with DB for production)
const processedEvents = new Set();
const stripeEvents = [];

// Root route for health checks
app.get('/', (req, res) => {
  res.json({ 
    status: 'Stripe webhook server running',
    timestamp: new Date().toISOString(),
    version: '2.0'  // Version bump to confirm new deployment
  });
});

// Health check
app.get('/api/webhook', (req, res) => {
  res.json({
    status: 'healthy',
    processed_events: processedEvents.size,
    logged_events: stripeEvents.length,
    version: '2.0',
    recent_events: stripeEvents.slice(-5).map(e => ({
      id: e.event_id,
      type: e.type,
      processed_at: e.processed_at
    }))
  });
});

// Debug route to check environment variables
app.get('/api/debug', (req, res) => {
  res.json({
    stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    webhook_secret_starts_with: process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 6),
    airtable_base_set: !!process.env.AIRTABLE_BASE_ID,
    airtable_key_set: !!process.env.AIRTABLE_API_KEY,
    version: '2.0'
  });
});

// Webhook endpoint with raw body parsing
app.post('/api/webhook', (req, res) => {
  console.log('🎯 NEW VERSION 2.0 - Webhook endpoint hit');
  
  let rawBody = '';
  
  // Set encoding to get string data
  req.setEncoding('utf8');
  
  req.on('data', (chunk) => {
    rawBody += chunk;
    console.log('📦 Received chunk, total length so far:', rawBody.length);
  });
  
  req.on('end', async () => {
    console.log('🏁 Request body complete');
    console.log('📊 Final stats:');
    console.log('- Body length:', rawBody.length);
    console.log('- Body type:', typeof rawBody);
    console.log('- First 50 chars:', rawBody.substring(0, 50));
    console.log('- Signature header:', req.headers['stripe-signature'] ? 'Present' : 'Missing');
    
    const sig = req.headers['stripe-signature'];
    
    if (!sig) {
      console.error('❌ No signature header');
      return res.status(400).send('No signature');
    }
    
    if (!rawBody) {
      console.error('❌ Empty body');
      return res.status(400).send('Empty body');
    }
    
    let event;
    try {
      console.log('🔐 Attempting signature verification...');
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
      console.log('✅ SUCCESS! Event verified:', event.id, event.type);
    } catch (err) {
      console.error('❌ Verification failed:', err.message);
      return res.status(400).send('Verification failed');
    }
    
    // Process the event
    try {
      if (processedEvents.has(event.id)) {
        console.log('🔄 Duplicate event, skipping');
        return res.json({ received: true, processed: false, reason: 'duplicate' });
      }
      
      processedEvents.add(event.id);
      stripeEvents.push({
        event_id: event.id,
        type: event.type,
        created: event.created,
        processed_at: new Date().toISOString()
      });
      
      if (event.type === 'checkout.session.completed') {
        console.log('💳 Processing checkout completion...');
        await processCheckoutCompleted(event.data.object);
      }
      
      console.log('✅ Event processed successfully');
      res.json({ received: true, processed: true, event_id: event.id });
      
    } catch (error) {
      console.error('❌ Processing error:', error);
      processedEvents.delete(event.id);
      res.status(500).json({ error: 'Processing failed' });
    }
  });
  
  req.on('error', (err) => {
    console.error('❌ Request error:', err);
    res.status(400).send('Request error');
  });
});

// Apply JSON middleware for other routes
app.use(express.json());

// Helper function
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

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server listening on 0.0.0.0:' + PORT);
  console.log('📋 Environment check:');
  console.log('- Stripe key set:', !!process.env.STRIPE_SECRET_KEY);
  console.log('- Webhook secret set:', !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log('- Webhook secret starts with:', process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 6) || 'NOT_SET');
  console.log('✅ Version 2.0 ready');
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('📝 Received shutdown signal...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
