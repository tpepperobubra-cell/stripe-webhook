const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
// In-memory storage for processed events (use database in production)
const processedEvents = new Set();
const stripeEvents = [];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const rawBody = JSON.stringify(req.body);
  let event;

  try {
    // REQUIREMENT 1: Signature verification BEFORE any writes
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Webhook signature verified for event:', event.id);
  } catch (err) {
    console.log('❌ Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // REQUIREMENT 2: Idempotency - check event.id, skip if already processed
  if (processedEvents.has(event.id)) {
    console.log(`🔄 Event ${event.id} already processed (retry detected) - SKIPPING`);
    return res.json({ 
      received: true, 
      processed: false, 
      reason: 'duplicate',
      event_id: event.id 
    });
  }

  try {
    // REQUIREMENT 3: Raw event logging - persist full payload FIRST
    const rawEventRecord = {
      event_id: event.id,
      type: event.type,
      created: event.created,
      raw_payload: event,
      processed_at: new Date().toISOString(),
      retry_detected: false
    };
    
    stripeEvents.push(rawEventRecord);
    console.log('📝 Raw event logged:', event.id, event.type);

    // Mark as processed for idempotency
    processedEvents.add(event.id);

    // Process checkout.session.completed events
    if (event.type === 'checkout.session.completed') {
      await processCheckoutCompleted(event.data.object);
    }

    console.log(`✅ Successfully processed event: ${event.id}`);
    return res.json({ 
      received: true, 
      processed: true,
      event_id: event.id,
      event_type: event.type
    });

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    // Remove from processed set so retry can work
    processedEvents.delete(event.id);
    
    return res.status(500).json({ 
      error: 'Processing failed',
      event_id: event.id 
    });
  }
}

async function processCheckoutCompleted(session) {
  console.log('Processing checkout for session:', session.id);

  // REQUIREMENT 4: Extract required fields for Subscriptions table
  const subscriptionRecord = {
    // Core Stripe IDs
    customer_id: session.customer,
    subscription_id: session.subscription,
    session_id: session.id,
    
    // Product/pricing info
    price_id: null,
    product_id: null,
    
    // Phenom tracking - defaults
    phenom_code: '',
    phenom_partner: false,
    source_channel: '',
    
    // UTM tracking - from session metadata
    utm_source: session.metadata?.utm_source || '',
    utm_medium: session.metadata?.utm_medium || '',
    utm_campaign: session.metadata?.utm_campaign || '',
    
    // Timestamps
    created_at: new Date().toISOString(),
    amount_total: session.amount_total,
    currency: session.currency
  };

  // Extract price_id and product_id from line items
  if (session.line_items?.data?.[0]) {
    const lineItem = session.line_items.data[0];
    subscriptionRecord.price_id = lineItem.price?.id;
    subscriptionRecord.product_id = lineItem.price?.product;
  }

  // Check for PHENOM100 coupon in discounts
  if (session.total_details?.breakdown?.discounts) {
    for (const discount of session.total_details.breakdown.discounts) {
      if (discount.discount?.coupon?.id === 'PHENOM100') {
        subscriptionRecord.phenom_code = 'PHENOM100';
        subscriptionRecord.phenom_partner = true;
        console.log('🎯 PHENOM100 coupon detected - setting phenom_partner=true');
        break;
      }
    }
  }

  // Determine source_channel from metadata or client_reference_id
  if (session.metadata?.source_channel) {
    subscriptionRecord.source_channel = session.metadata.source_channel;
  } else if (session.client_reference_id) {
    // Parse from client_reference_id patterns
    const ref = session.client_reference_id.toLowerCase();
    if (ref.includes('social')) subscriptionRecord.source_channel = 'social';
    else if (ref.includes('sms')) subscriptionRecord.source_channel = 'sms';
    else if (ref.includes('email')) subscriptionRecord.source_channel = 'email';
    else if (ref.includes('phenom_landing')) subscriptionRecord.source_channel = 'phenom_landing';
  }

  // Store subscription record (simulated - replace with actual Airtable API)
  await storeSubscription(subscriptionRecord);
  
  console.log('✅ Subscription record processed:', {
    session_id: subscriptionRecord.session_id,
    phenom_partner: subscriptionRecord.phenom_partner,
    phenom_code: subscriptionRecord.phenom_code,
    source_channel: subscriptionRecord.source_channel
  });
}

async function storeSubscription(record) {
  // TODO: Replace with actual Airtable API call
  // For now, just log the record that would be stored
  console.log('📊 Storing subscription record:', record);
  
  // Simulate Airtable API call
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
  
  console.log('🎯 Would store to Airtable:', airtablePayload);
  
  // Uncomment and configure for actual Airtable integration:
  /*
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
  */
}

// Health check endpoint for monitoring
export async function GET(req, res) {
  return res.json({
    status: 'healthy',
    processed_events: processedEvents.size,
    logged_events: stripeEvents.length,
    recent_events: stripeEvents.slice(-5).map(e => ({
      id: e.event_id,
      type: e.type,
      processed_at: e.processed_at
    }))
  });
}
