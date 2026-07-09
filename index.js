const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.DB_URL, process.env.DB_SERVICE_KEY);

// Brendan's user ID Ã¢â‚¬â€ receives manual payout notifications
const ADMIN_USER_ID = '372a2db2-1ad3-40f7-b44c-56def200bf66';

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe: create payment intent (immediate charge flow) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe: authorize only (capture_method: manual) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe: capture + auto payout Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
          // set during authorization Ã¢â‚¬â€ no manual transfer needed
          const payoutAmt = (rawAmt * 0.9).toFixed(2);
          const feeCents = (rawAmt * 0.10).toFixed(2);
          console.log(`[payout] Stripe auto-split on capture Ã¢â‚¬â€ mower gets $${payoutAmt}`);
          const mowerToken = await getPushToken(hire.mower_id);
          await sendPush(mowerToken, 'Ã°Å¸â€™Â° You\'ve been paid!', `$${payoutAmt} has been transferred to your bank account via Stripe.`);
          const adminToken = await getPushToken(ADMIN_USER_ID);
          await sendPush(adminToken, 'Ã°Å¸â€™Â° Payment Received', `${mower.name} was paid $${payoutAmt} via Stripe. Your fee: $${feeCents}.`);
        } else if (mower?.payout_method === 'venmo' || mower?.payout_method === 'zelle') {
          // Notify Brendan to manually pay the mower
          const adminToken = await getPushToken(ADMIN_USER_ID);
          const payoutAmt = (rawAmt * 0.9).toFixed(2);
          const payoutInfo = mower.payout_method === 'venmo'
            ? `Venmo: ${mower.venmo_handle || 'not set'}`
            : `Zelle: ${mower.zelle_info || 'not set'}`;
          await sendPush(
            adminToken,
            'Ã°Å¸â€™Â° Manual Payout Needed',
            `Pay ${mower.name} $${payoutAmt} via ${payoutInfo}`
          );
          console.log(`[payout] Manual payout alert sent Ã¢â‚¬â€ ${mower.name} $${payoutAmt} via ${mower.payout_method}`);
          // Still notify mower job is paid
          const mowerToken = await getPushToken(hire.mower_id);
          await sendPush(mowerToken, 'Ã°Å¸â€™Â° Payment Received!', `Your payment of $${rawAmt.toFixed(2)} is on its way via ${mower.payout_method}.`);
        }
      }
    }

    res.json({ success: true, status: paymentIntent.status });
  } catch (error) {
    console.error('capture-payment error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe: cancel an authorization Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe Connect: create account + return onboarding URL Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe Connect: check account status Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Expo push notification helper Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Build branded HTML email
function buildEmailHtml(title, body, ctaText = 'Open CutConnect') {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f9f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.07);">
        <tr><td style="background:#2D6A2D;padding:24px 32px;">
          <div style="font-size:22px;font-weight:800;color:#ffffff;">🌿 CutConnect</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <h2 style="margin:0 0 12px;font-size:20px;color:#1b2a1b;">${title}</h2>
          <p style="margin:0 0 24px;font-size:15px;color:#4a5e4a;line-height:1.6;">${body}</p>
          <a href="https://apps.apple.com/th/app/cutconnect-lawn-marketplace/id6764613000"
             style="display:inline-block;background:#2D6A2D;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:24px;">
            ${ctaText} →
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;border-top:1px solid #e8f0e8;">
          <p style="margin:0;font-size:12px;color:#90a4ae;line-height:1.5;">
            You're receiving this because you have an active job posted on CutConnect.<br>
            Questions? Email <a href="mailto:cutconnect.support@gmail.com" style="color:#2D6A2D;">cutconnect.support@gmail.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Send email to a homeowner (best-effort, never throws)
async function sendEmailToUser(userId, subject, bodyText) {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', userId)
      .limit(1)
      .single();
    if (!profile || profile.role !== 'homeowner') return;
    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (!email) return;
    await resend.emails.send({
      from: 'CutConnect <notifications@mycutconnect.com>',
      to: email,
      subject,
      html: buildEmailHtml(subject.replace('CutConnect — ', ''), bodyText),
    });
    console.log(`[email] Sent "${subject}" to ${email}`);
  } catch (err) {
    console.error('[email] Failed to send email:', err.message);
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Send notification endpoint Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.post('/send-notification', async (req, res) => {
  try {
    const { token: rawToken, userId, title, body } = req.body;
    let token = rawToken;
    if (!token && userId) {
      token = await getPushToken(userId);
      console.log(`[notify] userId=${userId} token=${token ?? 'NOT FOUND'}`);
    }
    // Send email to homeowners regardless of push token
    if (userId) {
      await sendEmailToUser(userId, title, `<p>${body}</p><p style=â€margin-top:16px;font-size:13px;color:#666;â€>Open the <a href=â€https://apps.apple.com/th/app/cutconnect-lawn-marketplace/id6764613000â€>CutConnect app</a> to respond.</p>`);
    }
    if (!token) {
      console.warn(`[notify] No push token â€” title=â€${title}â€`);
      return res.json({ success: false, reason: 'no_token' });
    }
    await sendPush(token, title, body);
    res.json({ success: true });
  } catch (error) {
    console.error('send-notification error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Mark messages as read (bypasses RLS using service key) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Delete account Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Account deletion request page Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/delete-account', (req, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Delete Your CutConnect Account</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { color: #2D6A2D; }
    p { line-height: 1.6; color: #444; }
    .card { background: #f6faf6; border: 1px solid #c8e6c9; border-radius: 12px; padding: 24px; margin-top: 24px; }
    a { color: #2D6A2D; font-weight: 600; }
    .note { font-size: 13px; color: #888; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Ã°Å¸Å’Â¿ Delete Your CutConnect Account</h1>
  <p>You can delete your account directly inside the CutConnect app:</p>
  <div class="card">
    <strong>In the app:</strong>
    <ol style="margin-top:8px; padding-left:20px; line-height:2;">
      <li>Open CutConnect</li>
      <li>Tap the <strong>Ã¢Å¡â„¢Ã¯Â¸Â Settings</strong> icon (top right)</li>
      <li>Scroll down and tap <strong>Delete Account</strong></li>
      <li>Confirm Ã¢â‚¬â€ your account and all data will be permanently deleted</li>
    </ol>
  </div>
  <p style="margin-top:24px;">If you no longer have access to the app, email us at <a href="mailto:oshaughnessy.brendan@gmail.com">oshaughnessy.brendan@gmail.com</a> with the subject line <strong>"Account Deletion Request"</strong> and include the email address associated with your account. We will delete it within 7 days.</p>
  <p class="note">Deleting your account removes your profile, posted jobs, bids, messages, and payment history from our systems. This action cannot be undone.</p>
</body>
</html>`));

// Ã¢â€â‚¬Ã¢â€â‚¬ Stripe Connect redirect pages Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/stripe-return', (req, res) => res.send('<html><body><h2>Bank account setup complete! Return to the CutConnect app.</h2></body></html>'));
app.get('/stripe-refresh', (req, res) => res.send('<html><body><h2>Session expired. Please return to CutConnect and try again.</h2></body></html>'));

// Ã¢â€â‚¬Ã¢â€â‚¬ Health check Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Ã¢â€â‚¬Ã¢â€â‚¬ Daily reminder cron (runs every day at 10:00 AM UTC) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function sendDailyReminders() {
  console.log('Running daily hire reminders...');
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: hires, error } = await supabase
      .from('hires')
      .select('*')
      .in('status', ['requested', 'awaiting_payment', 'complete'])
      .lt('created_at', cutoff);

    if (error) { console.error('Reminder query error:', error.message); return; }
    if (!hires || hires.length === 0) { console.log('No stale hires found.'); return; }

    for (const hire of hires) {
      if (hire.status === 'requested') {
        const token = await getPushToken(hire.homeowner_id);
        await sendPush(token, 'Ã¢ÂÂ³ Still waiting on your mower',
          `${hire.mower_name} hasn't responded to your hire request yet. You can follow up or cancel in the app.`);
      }
      if (hire.status === 'awaiting_payment') {
        const token = await getPushToken(hire.homeowner_id);
        await sendPush(token, 'Ã°Å¸â€™Â³ Action needed Ã¢â‚¬â€ authorize payment',
          `${hire.mower_name} accepted your job! Open CutConnect to authorize your card and confirm the booking.`);
      }
      if (hire.status === 'complete') {
        const token = await getPushToken(hire.homeowner_id);
        await sendPush(token, 'Ã°Å¸â€™Â° Please pay your mower',
          `${hire.mower_name} completed your lawn job over 24 hours ago. Open CutConnect to submit payment.`);
      }
    }

    console.log(`Reminder run complete. Processed ${hires.length} stale hire(s).`);
  } catch (err) {
    console.error('sendDailyReminders error:', err.message);
  }
}

cron.schedule('0 10 * * *', sendDailyReminders);

// Ã¢â€â‚¬Ã¢â€â‚¬ Auto-capture payments 48hrs after job marked complete Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function autoCapturePastDue() {
  console.log('Running auto-capture check...');
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  try {
    const { data: hires, error } = await supabase
      .from('hires')
      .select('*')
      .eq('status', 'complete')
      .not('payment_intent_id', 'is', null)
      .not('completed_at', 'is', null)
      .lt('completed_at', cutoff);
    if (error) { console.error('auto-capture query error:', error.message); return; }
    if (!hires || hires.length === 0) { console.log('No past-due payments found.'); return; }
    for (const hire of hires) {
      try {
        console.log(`[auto-capture] Capturing payment for hire ${hire.id} Ã¢â‚¬â€ ${hire.bid_amount}`);
        await stripe.paymentIntents.capture(hire.payment_intent_id);
        await supabase.from('hires').update({ status: 'paid' }).eq('id', hire.id);
        if (hire.job_id) await supabase.from('jobs').update({ status: 'paid' }).eq('id', hire.job_id);
        // Notify both parties
        const mowerToken = await getPushToken(hire.mower_id);
        await sendPush(mowerToken, 'Ã°Å¸â€™Â° Payment Received!', `Your payment of ${hire.bid_amount} has been automatically processed.`);
        const homeownerToken = await getPushToken(hire.homeowner_id);
        await sendPush(homeownerToken, 'Ã°Å¸â€™Â³ Payment Processed', `Your payment of ${hire.bid_amount} to ${hire.mower_name} has been automatically processed.`);
        console.log(`[auto-capture] Success Ã¢â‚¬â€ hire ${hire.id}`);
      } catch (err) {
        console.error(`[auto-capture] Failed for hire ${hire.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('autoCapturePastDue error:', err.message);
  }
}

// Run auto-capture every hour
cron.schedule('0 * * * *', autoCapturePastDue);

// Ã¢â€â‚¬Ã¢â€â‚¬ Signup reminder cron (runs daily at 11:00 AM UTC) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Sends one push to homeowners who signed up ~24hrs ago, haven't posted a job,
// and are not registered as a mower.
async function sendSignupReminders() {
  console.log('Running signup reminders...');
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: usersPage, error: authErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (authErr) { console.error('signup-reminder auth list error:', authErr.message); return; }

    const candidates = (usersPage?.users ?? []).filter(u => u.created_at <= cutoff);
    if (candidates.length === 0) { console.log('No signup-reminder candidates.'); return; }

    let sent = 0;
    for (const user of candidates) {
      const userId = user.id;

      const { data: profile } = await supabase
        .from('profiles').select('signup_reminder_sent, role').eq('user_id', userId).limit(1);
      if (!profile || profile.length === 0) continue;
      if (profile[0].signup_reminder_sent) continue;
      if (profile[0].role === 'mower') continue;

      const { data: jobs } = await supabase
        .from('jobs').select('id').eq('user_id', userId).limit(1);
      if (jobs && jobs.length > 0) continue;

      const token = await getPushToken(userId);
      if (token) {
        await sendPush(token, 'Ã°Å¸Å’Â¿ Ready to get your lawn done?', 'Post a job and get bids from local mowers in minutes.');
        console.log(`[signup-reminder] Sent to userId=${userId}`);
        sent++;
      }

      await supabase.from('profiles').update({ signup_reminder_sent: true }).eq('user_id', userId);
    }

    console.log(`Signup reminder run complete. Sent ${sent} reminder(s).`);
  } catch (err) {
    console.error('sendSignupReminders error:', err.message);
  }
}

cron.schedule('0 11 * * *', sendSignupReminders);

// Ã¢â€â‚¬Ã¢â€â‚¬ Admin dashboard Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cutconnect2024';

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth) {
    const [type, creds] = auth.split(' ');
    if (type === 'Basic') {
      const [, pass] = Buffer.from(creds, 'base64').toString().split(':');
      if (pass === ADMIN_PASSWORD) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="CutConnect Admin"');
  res.status(401).send('Unauthorized');
}

app.get('/admin/data', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [jobsRes, bidsRes, hiresRes, profilesRes, usersRes] = await Promise.all([
      supabase.from('jobs').select('created_at, status').gte('created_at', since).neq('status', 'cancelled'),
      supabase.from('bids').select('created_at').gte('created_at', since),
      supabase.from('hires').select('created_at, status').gte('created_at', since),
      supabase.from('profiles').select('user_id, role, created_at'),
      supabase.auth.admin.listUsers({ perPage: 1000 }),
    ]);

    const users = usersRes.data?.users ?? [];
    const totalUsers = users.length;
    const recentUsers = users.filter(u => u.created_at >= since);

    // Group by day helper
    const byDay = (rows, field = 'created_at') => {
      const map = {};
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        map[d] = 0;
      }
      (rows || []).forEach(r => {
        const d = (r[field] || '').split('T')[0];
        if (map[d] !== undefined) map[d]++;
      });
      return map;
    };

    const signupsByDay = byDay(recentUsers);
    const jobsByDay = byDay(jobsRes.data);
    const bidsByDay = byDay(bidsRes.data);
    const hiresByDay = byDay(hiresRes.data);

    const profiles = profilesRes.data || [];
    const totalMowers = new Set(profiles.filter(p => p.role === 'mower').map(p => p.user_id)).size;
    const totalHomeowners = new Set(profiles.filter(p => p.role === 'homeowner').map(p => p.user_id)).size;
    const totalJobs = (await supabase.from('jobs').select('id', { count: 'exact', head: true }).neq('status', 'cancelled')).count ?? 0;
    const totalBids = (await supabase.from('bids').select('id', { count: 'exact', head: true })).count ?? 0;
    const totalHires = (await supabase.from('hires').select('id', { count: 'exact', head: true }).eq('status', 'paid')).count ?? 0;
    const { data: paidHireAmounts } = await supabase.from('hires').select('bid_amount').eq('status', 'paid');
    const totalPayout = (paidHireAmounts || []).reduce((sum, h) => {
      const amt = parseFloat((h.bid_amount || '0').replace(/[^0-9.]/g, ''));
      return sum + (isNaN(amt) ? 0 : amt);
    }, 0);

    // Scheduled payouts: active hires not yet paid, accounting for remaining recurring visits
    const { data: activeHires } = await supabase
      .from('hires')
      .select('bid_amount, total_visits, visit_number, status')
      .in('status', ['requested', 'awaiting_payment', 'scheduled', 'complete']);
    const scheduledPayout = (activeHires || []).reduce((sum, h) => {
      const amt = parseFloat((h.bid_amount || '0').replace(/[^0-9.]/g, ''));
      if (isNaN(amt)) return sum;
      const totalVisits = h.total_visits || 1;
      const visitNumber = h.visit_number || 1;
      // complete = current visit earned but unpaid (1 visit); scheduled = remaining visits including current
      const remainingVisits = h.status === 'complete' ? 1 : Math.max(1, totalVisits - visitNumber + 1);
      return sum + (amt * remainingVisits);
    }, 0);

    // Recent signups
    const recentSignups = users
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20)
      .map(u => ({ email: u.email, created_at: u.created_at }));

    res.json({
      totals: { totalUsers, totalMowers, totalHomeowners, totalJobs, totalBids, totalHires, totalPayout, scheduledPayout },
      charts: { signupsByDay, jobsByDay, bidsByDay, hiresByDay },
      recentSignups,
    });
  } catch (err) {
    console.error('admin/data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin', requireAdmin, (req, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CutConnect Admin</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f7f4; color: #1a1a1a; padding: 24px; }
    h1 { color: #2D6A2D; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    .range-btns { display: flex; gap: 8px; margin-bottom: 24px; }
    .range-btn { padding: 6px 16px; border-radius: 20px; border: 1px solid #2D6A2D; background: #fff; color: #2D6A2D; cursor: pointer; font-size: 13px; font-weight: 600; }
    .range-btn.active { background: #2D6A2D; color: #fff; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
    .card-val { font-size: 32px; font-weight: 700; color: #2D6A2D; }
    .card-label { font-size: 12px; color: #888; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
    .chart-box { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
    .chart-box h3 { font-size: 14px; color: #555; margin-bottom: 16px; }
    .table-box { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
    .table-box h3 { font-size: 14px; color: #555; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #888; font-weight: 600; padding: 6px 0; border-bottom: 1px solid #eee; }
    td { padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
    .loading { text-align: center; padding: 60px; color: #888; }
  </style>
</head>
<body>
  <h1>ðŸŒ¿ CutConnect Admin</h1>
  <p class="subtitle">Last updated: <span id="updated">loading...</span></p>

  <div class="range-btns">
    <button class="range-btn active" onclick="load(7, this)">7 days</button>
    <button class="range-btn" onclick="load(30, this)">30 days</button>
    <button class="range-btn" onclick="load(90, this)">90 days</button>
  </div>

  <div class="cards" id="cards"><div class="loading">Loading...</div></div>
  <div class="charts">
    <div class="chart-box"><h3>New Signups</h3><canvas id="signupsChart"></canvas></div>
    <div class="chart-box"><h3>Jobs Posted</h3><canvas id="jobsChart"></canvas></div>
    <div class="chart-box"><h3>Bids Placed</h3><canvas id="bidsChart"></canvas></div>
    <div class="chart-box"><h3>New Hire Requests</h3><canvas id="hiresChart"></canvas></div>
  </div>
  <div class="table-box">
    <h3>Recent Signups</h3>
    <table><thead><tr><th>Email</th><th>Signed Up</th></tr></thead><tbody id="signupTable"></tbody></table>
  </div>

  <script>
    const charts = {};
    function makeChart(id, labels, data, color) {
      if (charts[id]) charts[id].destroy();
      charts[id] = new Chart(document.getElementById(id), {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 4, borderSkipped: false }] },
        options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 7, font: { size: 10 } } }, y: { beginAtZero: true, min: 0, max: Math.max(5, Math.max(...data)), ticks: { stepSize: 1, precision: 0 } } } }
      });
    }
    async function load(days, btn) {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const res = await fetch('/admin/data?days=' + days);
      const d = await res.json();
      const { totals, charts: c, recentSignups } = d;

      document.getElementById('cards').innerHTML = [
        ['Total Users', totals.totalUsers],
        ['Mowers', totals.totalMowers],
        ['Homeowners', totals.totalHomeowners],
        ['Jobs Posted', totals.totalJobs],
        ['Bids Placed', totals.totalBids],
        ['Paid Hires', totals.totalHires],
        ['Total Paid Out', \`$\${totals.totalPayout.toFixed(2)}\`],
        ['Projected Payouts', \`$\${totals.scheduledPayout.toFixed(2)}\`],
      ].map(([label, val]) => \`<div class="card"><div class="card-val">\${val}</div><div class="card-label">\${label}</div></div>\`).join('');

      const labels = obj => Object.keys(obj).map(d => d.slice(5));
      const vals = obj => Object.values(obj);
      makeChart('signupsChart', labels(c.signupsByDay), vals(c.signupsByDay), '#2D6A2D');
      makeChart('jobsChart', labels(c.jobsByDay), vals(c.jobsByDay), '#4CAF50');
      makeChart('bidsChart', labels(c.bidsByDay), vals(c.bidsByDay), '#F59E0B');
      makeChart('hiresChart', labels(c.hiresByDay), vals(c.hiresByDay), '#3B82F6');

      document.getElementById('signupTable').innerHTML = recentSignups.map(u =>
        \`<tr><td>\${u.email}</td><td>\${new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td></tr>\`
      ).join('');

      document.getElementById('updated').textContent = new Date().toLocaleTimeString();
    }
    load(7);
  </script>
</body>
</html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CutConnect server running on port ${PORT}`));

