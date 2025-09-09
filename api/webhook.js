import express from 'express';
import Stripe from 'stripe';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 🚨 IMPORTANT: raw body ONLY for the webhook route
app.post('/api/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, // this is a Buffer
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Verified event:', event.id);
    } catch (err) {
      console.error('❌ Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    res.json({ received: true });
  }
);

// 👇 All OTHER routes use JSON body parsing
app.use(express.json());
