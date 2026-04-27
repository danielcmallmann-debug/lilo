// netlify/functions/webhook-mercadopago.js
// ===================================================
// Recebe webhooks do MP. Trata 3 tipos:
//   - payment           → pagamentos avulsos (Pix)
//   - subscription_*    → assinaturas recorrentes (cartão)
//   - subscription_authorized_payment → cobrança recorrente bem-sucedida
// ===================================================

const {
  supabase, json, corsPreflight,
  isValidWebhookSignature, getMpPayment, getMpSubscription, config,
} = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid_json' }); }

  // ===== 1. VALIDAR ASSINATURA =====
  const valid = isValidWebhookSignature({
    headers: event.headers,
    query: event.queryStringParameters,
    body,
  });
  const isProd = process.env.CONTEXT === 'production';
  if (!valid && isProd) {
    console.warn('[webhook] assinatura inválida — rejeitando');
    return json(401, { error: 'invalid_signature' });
  }
  if (!valid) console.warn('[webhook] assinatura inválida (aceito em não-prod)');

  // ===== 2. EXTRAIR EVENTO =====
  const eventType  = body.type || body.action;
  const resourceId = body.data && body.data.id;

  if (!resourceId) return json(200, { received: true, skipped: 'no_resource_id' });

  const eventKey = `${eventType}_${resourceId}`;
  const sb = supabase();

  // ===== 3. IDEMPOTÊNCIA =====
  const { data: insertedEvent, error: insertErr } = await sb
    .from('webhook_events')
    .insert({
      event_key:   eventKey,
      event_type:  eventType,
      resource_id: String(resourceId),
      raw_body:    body,
      raw_headers: event.headers,
    })
    .select('id')
    .maybeSingle();

  if (insertErr) {
    if (insertErr.code === '23505') {
      console.log(`[webhook] já processado: ${eventKey}`);
      return json(200, { received: true, skipped: 'already_processed' });
    }
    console.error('[webhook] storage:', insertErr);
    return json(500, { error: 'storage_error' });
  }

  const eventDbId = insertedEvent.id;

  // ===== 4. ROTEAMENTO =====
  try {
    if (eventType === 'payment' || eventType?.startsWith('payment.')) {
      await handlePayment(sb, resourceId);
    } else if (eventType?.startsWith('subscription_') || eventType === 'preapproval') {
      await handleSubscription(sb, resourceId);
    } else {
      console.log(`[webhook] tipo não tratado: ${eventType}`);
    }

    await sb.from('webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', eventDbId);

    return json(200, { received: true, event_key: eventKey });
  } catch (err) {
    console.error('[webhook] erro:', err);
    await sb.from('webhook_events')
      .update({ error_message: err.message })
      .eq('id', eventDbId);
    return json(500, { error: 'processing_failed' });
  }
};

// ============== HANDLER: pagamento avulso (Pix) ==============

async function handlePayment(sb, paymentId) {
  const payment = await getMpPayment(paymentId);

  const userId   = payment.metadata?.user_id;
  const planType = payment.metadata?.plan_type;

  if (!userId || !planType) {
    console.warn(`[webhook] payment ${paymentId} sem metadata`);
    return;
  }

  await sb.from('payments').upsert({
    user_id:        userId,
    mp_payment_id:  String(payment.id),
    plan_type:      planType,
    amount:         payment.transaction_amount,
    status:         payment.status,
    status_detail:  payment.status_detail,
    payment_method: payment.payment_method_id,
    raw_payload:    payment,
    approved_at:    payment.status === 'approved' ? new Date().toISOString() : null,
  }, { onConflict: 'mp_payment_id' });

  if (payment.status === 'approved') {
    const plan = config.plans[planType];
    // Se já tinha acesso ativo, ESTENDE ao invés de sobrescrever
    const { data: u } = await sb.from('users')
      .select('access_expires_at').eq('id', userId).maybeSingle();
    const baseDate = (u?.access_expires_at && new Date(u.access_expires_at) > new Date())
      ? new Date(u.access_expires_at)
      : new Date();
    const expiresAt = new Date(baseDate.getTime() + plan.durationDays * 24*60*60*1000).toISOString();

    await sb.from('users').update({
      payment_status:    'approved',
      plan_type:         planType,
      payment_id:        String(payment.id),
      access_expires_at: expiresAt,
    }).eq('id', userId);

    console.log(`[webhook] PIX aprovado user=${userId}, expira=${expiresAt}`);
  } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
    console.log(`[webhook] PIX ${payment.status} user=${userId}`);
  }
}

// ============== HANDLER: assinatura recorrente ==============

async function handleSubscription(sb, subscriptionId) {
  const sub = await getMpSubscription(subscriptionId);
  console.log('[webhook] subscription status:', sub.status, 'id:', sub.id);

  // external_reference: lilo_sub_<userId>_<planType>
  const ref = sub.external_reference || '';
  const parts = ref.split('_');
  const userId   = parts[2];
  const planType = parts[3];

  if (!userId || !planType) {
    console.warn(`[webhook] subscription ${subscriptionId} sem reference válida: ${ref}`);
    return;
  }

  if (sub.status === 'authorized') {
    const plan = config.plans[planType];
    const expiresAt = new Date(Date.now() + plan.durationDays * 24*60*60*1000).toISOString();

    await sb.from('users').update({
      payment_status:    'approved',
      plan_type:         planType,
      subscription_id:   subscriptionId,
      auto_renew:        true,
      access_expires_at: expiresAt,
    }).eq('id', userId);

    console.log(`[webhook] subscription autorizada user=${userId}`);
  } else if (sub.status === 'paused' || sub.status === 'cancelled') {
    await sb.from('users').update({
      auto_renew: false,
    }).eq('id', userId);
    console.log(`[webhook] subscription ${sub.status} user=${userId}`);
  }
}
