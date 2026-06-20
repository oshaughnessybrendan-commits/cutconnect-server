const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.DB_URL, process.env.DB_SERVICE_KEY);

// Brendan's user ID — receives manual payout notifications
const ADMIN_USER_ID = '372a2db2-1ad3-40f7-b44c-56def200bf66';

// ── Stripe: create payment intent (immediate charge flow) ──────────────────────
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
    console.error('create-payment-intent error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Stripe: authorize only (capture_method: manual) ───────────────────────────
app.post('/authorize-payment', async (req, res) => {
  try {
    const { amount, currency = 'usd', mowerId } = req.body;
    const amountCents = Math.round(amount * 100);
    const feeCents = Math.round(amountCents * 0.10); // 10% platform fee
    const intentParams = {
      amount: amountCents,
      currency,
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true },
    };
    if (mowerId) {
      const { data: mowerRows } = await supabase.from('profiles').select('stripe_connect_id, payout_method').eq('user_id', mowerId).eq('role', 'mower').limit(1);
      const stripeConnectId = mowerRows?.[0]?.stripe_connect_id;
      const payoutMethod = mowerRows?.[0]?.payout_method;
      if (stripeConnectId && payoutMethod === 'stripe') {
        intentParams.application_fee_amount = feeCents;
        intentParams.transfer_data = { destination: stripeConnectId };
      }
    }
    const paymentIntent = await stripe.paymentIntents.create(intentParams);
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error('authorize-payment error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Stripe: capture + auto payout ────────────────────────────────────────────
app.post('/capture-payment', async (req, res) => {
  try {
    const { paymentIntentId, hireId } = req.body;
    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId);

    if (hireId) {
      const { data: hireRows } = await supabase.from('hires').select('*').eq('id', hireId).limit(1);
      const hire = hireRows?.[0];

      if (hire) {
        const { data: mowerRows } = await supabase
          .from('profiles').select('*').eq('user_id', hire.mower_id).eq('role', 'mower').limit(1);
        const mower = mowerRows?.[0];
        const rawAmt = parseFloat((hire.bid_amount || '0').replace(/[^0-9.]/g, ''));

        if (mower?.payout_method === 'stripe' && mower?.stripe_connect_id) {
          // Stripe automatically splits on capture via application_fee_amount + transfer_data
          // set during authorization — no manual transfer needed
          const payoutAmt = (rawAmt * 0.9).toFixed(2);
          console.log(`[payout] Stripe auto-split on capture — mower gets $${payoutAmt}`);
          const mowerToken = await getPushToken(hire.mower_id);
          await sendPush(mowerToken, '💰 You\'ve been paid!', `$${payoutAmt} has been transferred to your bank account via Stripe.`);
        } else if (mower?.payout_method === 'venmo' || mower?.payout_method === 'zelle') {
          // Notify Brendan to manually pay the mower
          const adminToken = await getPushToken(ADMIN_USER_ID);
          const payoutAmt = (rawAmt * 0.9).toFixed(2);
          const payoutInfo = mower.payout_method === 'venmo'
            ? `Venmo: ${mower.venmo_handle || 'not set'}`
            : `Zelle: ${mower.zelle_info || 'not set'}`;
          await sendPush(
            adminToken,
            '💰 Manual Payout Needed',
            `Pay ${mower.name} $${payoutAmt} via ${payoutInfo}`
          );
          console.log(`[payout] Manual payout alert sent — ${mower.name} $${payoutAmt} via ${mower.payout_method}`);
          // Still notify mower job is paid
          const mowerToken = await getPushToken(hire.mower_id);
          await sendPush(mowerToken, '💰 Payment Received!', `Your payment of $${rawAmt.toFixed(2)} is on its way via ${mower.payout_method}.`);
        }
      }
    }

    res.json({ success: true, status: paymentIntent.status });
  } catch (error) {
    console.error('capture-payment error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Stripe: cancel an authorization ──────────────────────────────────────────
app.post('/cancel-authorization', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);
    res.json({ success: true, status: paymentIntent.status });
  } catch (error) {
    console.error('cancel-authorization error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Stripe Connect: create account + return onboarding URL ───────────────────
app.post('/create-connect-account', async (req, res) => {
  try {
    const { mowerId } = req.body;

    // Check if mower already has a Connect account
    const { data: profileRows } = await supabase
      .from('profiles').select('stripe_connect_id').eq('user_id', mowerId).eq('role', 'mower').limit(1);
    let accountId = profileRows?.[0]?.stripe_connect_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      accountId = account.id;
      await supabase.from('profiles').update({ stripe_connect_id: accountId })
        .eq('user_id', mowerId).eq('role', 'mower');
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://cutconnect-server-production.up.railway.app/stripe-refresh',
      return_url: 'https://cutconnect-server-production.up.railway.app/stripe-return',
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url, accountId });
  } catch (error) {
    console.error('create-connect-account error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Stripe Connect: check account status ─────────────────────────────────────
app.post('/connect-status', async (req, res) => {
  try {
    const { accountId } = req.body;
    const account = await stripe.accounts.retrieve(accountId);
    res.json({
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  } catch (error) {
    console.error('connect-status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Expo push notification helper ─────────────────────────────────────────────
async function sendPush(token, title, body) {
  if (!token) return;
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: token, sound: 'default', title, body }),
    });
    const result = await response.json();
    if (result.data?.status === 'error') {
      console.error('Expo push error:', result.data.message, 'token:', token);
    }
  } catch (err) {
    console.error('sendPush fetch error:', err.message);
  }
}

// Lookup push token for a user (handles users with multiple profile rows)
async function getPushToken(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('user_id', userId)
    .not('push_token', 'is', null)
    .limit(1);
  return data?.[0]?.push_token ?? null;
}

// ── Send notification endpoint ────────────────────────────────────────────────
app.post('/send-notification', async (req, res) => {
  try {
    const { token: rawToken, userId, title, body } = req.body;
    let token = rawToken;
    if (!token && userId) {
      token = await getPushToken(userId);
      console.log(`[notify] userId=${userId} token=${token ?? 'NOT FOUND'}`);
    }
    if (!token) {
      console.warn(`[notify] No push token — title="${title}"`);
      return res.json({ success: false, reason: 'no_token' });
    }
    await sendPush(token, title, body);
    res.json({ success: true });
  } catch (error) {
    console.error('send-notification error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Mark messages as read (bypasses RLS using service key) ───────────────────
app.post('/mark-messages-read', async (req, res) => {
  try {
    const { receiverId, senderId } = req.body;
    if (!receiverId) return res.status(400).json({ error: 'receiverId required' });
    let query = supabase.from('messages').update({ read: true }).eq('receiver_id', receiverId).eq('read', false);
    if (senderId) query = query.eq('sender_id', senderId);
    const { error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    console.error('mark-messages-read error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Delete account ────────────────────────────────────────────────────────────
app.post('/delete-account', async (req, res) => {
  try {
    const { userId } = req.body;
    await supabase.from('blocked_users').delete().eq('blocker_id', userId);
    await supabase.from('blocked_users').delete().eq('blocked_id', userId);
    await supabase.from('bids').delete().eq('user_id', userId);
    await supabase.from('hires').delete().eq('mower_id', userId);
    await supabase.from('hires').delete().eq('homeowner_id', userId);
    await supabase.from('jobs').delete().eq('user_id', userId);
    await supabase.from('messages').delete().eq('sender_id', userId);
    await supabase.from('profiles').delete().eq('user_id', userId);
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    console.error('delete-account error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Stripe Connect redirect pages ─────────────────────────────────────────────
app.get('/stripe-return', (req, res) => res.send('<html><body><h2>Bank account setup complete! Return to the CutConnect app.</h2></body></html>'));
app.get('/stripe-refresh', (req, res) => res.send('<html><body><h2>Session expired. Please return to CutConnect and try again.</h2></body></html>'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Daily reminder cron (runs every day at 10:00 AM UTC) ──────────────────────
async function sendDailyReminders() {
  console.log('Running daily hire reminders...');
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: hires, error } = await supabase
      .from('hires')
      .select('*')
      .in('status', ['requested', 'awaiting_payment', 'complete'])
      .lt('updated_at', cutoff);

    if (error) { console.error('Reminder query error:', error.message); return; }
    if (!hires || hires.length === 0) { console.log('No stale hires found.'); return; }

    for (const hire of hires) {
      if (hire.status === 'requested') {
        const token = await getPushToken(hire.homeowner_id);
        await sendPush(token, '⏳ Still waiting on your mower',
          `${hire.mower_name} hasn't responded to your hire request yet. You can follow up or cancel in the app.`);
      }
      if (hire.status === 'awaiting_payment') {
        const token = await getPushToken(hire.homeowner_id);
        await sendPush(token, '💳 Action needed — authorize payment',
          `${hire.mower_name} accepted your job! Open CutConnect to authorize your card and confirm the booking.`);
      }
      if (hire.status === 'complete') {
        const token = await getPushToken(hire.homeowner_id);
        await sendPush(token, '💰 Please pay your mower',
          `${hire.mower_name} completed your lawn job over 24 hours ago. Open CutConnect to submit payment.`);
      }
    }

    console.log(`Reminder run complete. Processed ${hires.length} stale hire(s).`);
  } catch (err) {
    console.error('sendDailyReminders error:', err.message);
  }
}

cron.schedule('0 10 * * *', sendDailyReminders);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CutConnect server running on port ${PORT}`));
