const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd' } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-notification', async (req, res) => {
  try {
    const { token, title, body } = req.body;
    const message = { to: token, sound: 'default', title, body };
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/delete-account', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.DB_URL,
      process.env.DB_SERVICE_KEY
    );
    const { userId } = req.body;
    // Delete all user data first
    await supabase.from('blocked_users').delete().eq('blocker_id', userId);
    await supabase.from('blocked_users').delete().eq('blocked_id', userId);
    await supabase.from('bids').delete().eq('user_id', userId);
    await supabase.from('hires').delete().eq('mower_id', userId);
    await supabase.from('hires').delete().eq('homeowner_id', userId);
    await supabase.from('jobs').delete().eq('user_id', userId);
    await supabase.from('messages').delete().eq('sender_id', userId);
    await supabase.from('profiles').delete().eq('user_id', userId);
    // Finally delete the auth user
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
