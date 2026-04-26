// netlify/functions/webhook-mercadopago.js
// POST /api/webhook-mercadopago
// (URL real exposta ao MP: /.netlify/functions/webhook-mercadopago)
//
// Recebe notificações do MP, valida assinatura, garante idempotência
// e atualiza o status de pagamento do usuário.

const {
  supabase, json, corsPreflight,
  isValidWebhookSignature, getMpPayment, config,
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

  // Em produção: assinatura inválida = rejeita
  // Em dev/sandbox: aceita (loga aviso) — útil para testes manuais
  const isProd = process.env.CONTEXT === 'production';
  if (!valid && isProd) {
    console.warn('[webhook] assinatura inválida — rejeitando');
    return json(401, { error: 'invalid_signature' });
  }
  if (!valid) {
    console.warn('[webhook] assinatura inválida (aceito em ambiente não-produção)');
  }

  // ===== 2. EXTRAIR EVENTO =====
  const eventType  = body.type || body.action;
  const resourceId = body.data && body.data.id;

  if (!resourceId) {
    return json(200, { received: true, skipped: 'no_resource_id' });
  }

  const eventKey = `${eventType}_${resourceId}`;
  const sb = supabase();

  // ===== 3. IDEMPOTÊNCIA =====
  // INSERT na webhook_events; se já existir (UNIQUE), pula tudo.
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
    // Código 23505 = unique_violation no Postgres
    if (insertErr.code === '23505') {
      console.log(`[webhook] já processado: ${eventKey}`);
      return json(200, { received: true, skipped: 'already_processed' });
    }
    console.error('[webhook] erro ao registrar evento:', insertErr);
    return json(500, { error: 'storage_error' });
  }

  const eventDbId = insertedEvent.id;

  // ===== 4. PROCESSAR POR TIPO =====
  try {
    if (eventType === 'payment' || eventType === 'payment.created' || eventType === 'payment.updated') {
      await handlePayment(sb, resourceId);
    } else {
      console.log(`[webhook] tipo não tratado: ${eventType}`);
    }

    await sb.from('webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', eventDbId);

    return json(200, { received: true, event_key: eventKey });
  } catch (err) {
    console.error('[webhook] erro ao processar:', err);
    await sb.from('webhook_events')
      .update({ error_message: err.message })
      .eq('id', eventDbId);
    return json(500, { error: 'processing_failed' });
  }
};

// ============== HANDLER: pagamento ==============

async function handlePayment(sb, paymentId) {
  // Busca detalhes do MP usando Access Token (servidor only)
  const payment = await getMpPayment(paymentId);

  const userId   = payment.metadata && payment.metadata.user_id;
  const planType = payment.metadata && payment.metadata.plan_type;

  if (!userId || !planType) {
    console.warn(`[webhook] payment ${paymentId} sem metadata — ignorando`);
    return;
  }

  // Upsert do payment (mp_payment_id é UNIQUE)
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

  // Atualizar usuário
  if (payment.status === 'approved') {
    const plan      = config.plans[planType];
    const expiresAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000).toISOString();

    await sb.from('users').update({
      payment_status:    'approved',
      plan_type:         planType,
      payment_id:        String(payment.id),
      access_expires_at: expiresAt,
    }).eq('id', userId);

    console.log(`[webhook] ✓ user ${userId} aprovado, plano=${planType}, expira=${expiresAt}`);

  } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
    // Não rebaixa um usuário que tem acesso aprovado válido (proteção)
    const { data: u } = await sb.from('users')
      .select('payment_status, access_expires_at').eq('id', userId).maybeSingle();

    const hasActive = u && u.payment_status === 'approved'
      && u.access_expires_at && new Date(u.access_expires_at) > new Date();

    if (!hasActive) {
      await sb.from('users').update({ payment_status: payment.status }).eq('id', userId);
    }
    console.log(`[webhook] user ${userId} status=${payment.status}`);
  } else {
    console.log(`[webhook] payment ${payment.id} em ${payment.status} (intermediário)`);
  }
}
