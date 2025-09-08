const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const app = express();

// In-memory store for processed events (use Redis in production)
const processedEvents = new Set();

// Store for raw event logging (use proper database in production)
const eventLog = [];

// Middleware to get raw body for signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;

  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ Webhook signature verified');
  } catch (err) {
    console.log('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log raw event
  const eventRecord = {
    id: event.id,
    type: event.type,
    created: event.created,
    timestamp: new Date().toISOString(),
    data: event.data,
    isRetry: processedEvents.has(event.id)
  };
  eventLog.push(eventRecord);

  // Check for idempotency (prevent duplicate processing)
  if (processedEvents.has(event.id)) {
    console.log(`🔄 Event ${event.id} already processed (retry detected)`);
    eventLog[eventLog.length - 1].action = 'SKIPPED_DUPLICATE';
    return res.json({ received: true, processed: false, reason: 'duplicate' });
  }

  // Mark event as processed
  processedEvents.add(event.id);
  eventRecord.action = 'PROCESSED';

  try {
    // Process relevant events
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === 'customer.subscription.created') {
      await handleSubscriptionCreated(event.data.object);
    } else if (event.type === 'invoice.payment_succeeded') {
      await handlePaymentSucceeded(event.data.object);
    }

    console.log(`✅ Successfully processed event: ${event.id} (${event.type})`);
    res.json({ received: true, processed: true });

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    eventRecord.action = 'ERROR';
    eventRecord.error = error.message;
    
    // Remove from processed set so it can be retried
    processedEvents.delete(event.id);
    
    res.status(500).json({ error: 'Processing failed' });
  }
});

async function handleCheckoutCompleted(session) {
  console.log('Processing checkout.session.completed:', session.id);
  
  // Extract metadata for Phenom tracking
  const metadata = {
    stripe_customer_id: session.customer,
    stripe_session_id: session.id,
    stripe_subscription_id: session.subscription,
    amount_total: session.amount_total,
    currency: session.currency,
    payment_status: session.payment_status,
    
    // Phenom-specific fields
    phenom_partner: false,
    phenom_code: '',
    source_channel: '',
    
    // UTM fields (from session metadata if stored there)
    utm_source: session.metadata?.utm_source || '',
    utm_medium: session.metadata?.utm_medium || '',
    utm_campaign: session.metadata?.utm_campaign || '',
    utm_term: session.metadata?.utm_term || '',
    utm_content: session.metadata?.utm_content || ''
  };

  // Check for PHENOM100 coupon
  if (session.total_details?.breakdown?.discounts) {
    for (const discount of session.total_details.breakdown.discounts) {
      if (discount.discount?.coupon?.id === 'PHENOM100') {
        metadata.phenom_partner = true;
        metadata.phenom_code = 'PHENOM100';
        break;
      }
    }
  }

  // Determine source channel from metadata or client_reference_id
  if (session.metadata?.source_channel) {
    metadata.source_channel = session.metadata.source_channel;
  } else if (session.client_reference_id) {
    // Parse from client_reference_id if you're encoding it there
    if (session.client_reference_id.includes('social')) metadata.source_channel = 'social';
    else if (session.client_reference_id.includes('sms')) metadata.source_channel = 'sms';
    else if (session.client_reference_id.includes('email')) metadata.source_channel = 'email';
    else if (session.client_reference_id.includes('phenom_landing')) metadata.source_channel = 'phenom_landing';
  }

  // Forward to your existing Zapier webhook
  await forwardToZapier(metadata, 'checkout_completed');
}

async function handleSubscriptionCreated(subscription) {
  console.log('Processing customer.subscription.created:', subscription.id);
  
  const metadata = {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer,
    plan_id: subscription.items.data[0]?.price?.id,
    status: subscription.status,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end
  };

  await forwardToZapier(metadata, 'subscription_created');
}

async function handlePaymentSucceeded(invoice) {
  console.log('Processing invoice.payment_succeeded:', invoice.id);
  
  const metadata = {
    stripe_invoice_id: invoice.id,
    stripe_customer_id: invoice.customer,
    stripe_subscription_id: invoice.subscription,
    amount_paid: invoice.amount_paid,
    currency: invoice.currency
  };

  await forwardToZapier(metadata, 'payment_succeeded');
}

async function forwardToZapier(data, eventType) {
  const zapierWebhookUrl = process.env.ZAPIER_WEBHOOK_URL;
  
  if (!zapierWebhookUrl) {
    console.log('No Zapier webhook URL configured');
    return;
  }

  try {
    const payload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...data
    };

    const response = await axios.post(zapierWebhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log('✅ Successfully forwarded to Zapier:', response.status);
  } catch (error) {
    console.error('❌ Failed to forward to Zapier:', error.message);
    throw error; // Re-throw so the main handler can mark as failed
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    processed_events: processedEvents.size,
    logged_events: eventLog.length,
    uptime: process.uptime()
  });
});

// Debug endpoint to view processed events
app.get('/events', (req, res) => {
  res.json({
    processed_count: processedEvents.size,
    recent_events: eventLog.slice(-10) // Last 10 events
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook receiver running on port ${PORT}`);
  console.log(`📝 Event logging enabled`);
  console.log(`🔒 Signature verification enabled`);
  console.log(`🔄 Idempotency protection enabled`);
});
