// --- Stripe Webhook Route ---
// IMPORTANT: This MUST come before `express.json()`
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  console.log('🔍 Webhook received:');
  console.log('- Body is Buffer:', Buffer.isBuffer(req.body));
  console.log('- Body length:', req.body?.length);
  console.log('- Signature present:', !!sig);
  console.log('- Webhook secret set:', !!process.env.STRIPE_WEBHOOK_SECRET);

  if (!sig) {
    console.error('❌ No Stripe signature header found');
    return res.status(400).send('No Stripe signature header found');
  }

  try {
    // ✅ Use the raw Buffer directly
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('✅ Webhook signature verified for event:', event.id);
  } catch (err) {
    console.error('❌ Signature verification failed:', err.message);
    console.error('❌ Body preview (first 100 chars):', req.body.toString().substring(0, 100));
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
});
