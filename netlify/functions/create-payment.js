// netlify/functions/create-payment.js
// ===================================================
// POST /api/create-payment
// Body: { plan_type: 'monthly'|'yearly', card_token_id: '...', installments?: number }
//
// Cobra o cartão UMA VEZ via /v1/payments.
// Se aprovado → libera N dias de acesso.
// Quando expirar, usuário paga novamente (renovação manual).
// ===================================================

const {
  supabase, json, corsPreflight, verifyToken,
  createCardPayment, config,
} = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  const user = verifyToken(event.headers.authorization || event.headers.Authorization);
  if (!user) return json(401, { error: 'unauthorized' });

  try {
    const { plan_type, card_token_id, installments } = JSON.parse(event.body || '{}');

    if (!['monthly', 'yearly'].includes(plan_type))
      return json(400, { error: 'plan_type inválido' });
    if (!card_token_id)
      return json(400, { error: 'card_token_id obrigatório' });

    const plan = config.plans[plan_type];
    const sb = supabase();

    const { data: dbUser, error: uErr } = await sb
      .from('users').select('id, email').eq('id', user.id).maybeSingle();
    if (uErr || !dbUser) return json(404, { error: 'usuário não encontrado' });

    // Cobra agora via /v1/payments
    const payment = await createCardPayment({
      userId: dbUser.id,
      planType: plan_type,
      plan,
      payerEmail: dbUser.email,
      cardTokenId: card_token_id,
      installments: installments || 1,
    });

    console.log('[create-payment] criado:', payment.id, 'status:', payment.status, 'detail:', payment.status_detail);

    // Registra payment
    await sb.from('payments').insert({
      user_id: dbUser.id,
      mp_payment_id: String(payment.id),
      plan_type,
      amount: plan.price,
      status: payment.status,
      status_detail: payment.status_detail,
      payment_method: payment.payment_method_id,
      raw_payload: payment,
      approved_at: payment.status === 'approved' ? new Date().toISOString() : null,
    });

    // Se aprovado AGORA (caminho feliz), libera acesso direto
    // (o webhook também faria isso, mas aqui é mais rápido)
    if (payment.status === 'approved') {
      const expiresAt = new Date(Date.now() + plan.durationDays * 24*60*60*1000).toISOString();
      await sb.from('users').update({
        payment_status:    'approved',
        plan_type,
        payment_id:        String(payment.id),
        access_expires_at: expiresAt,
      }).eq('id', dbUser.id);
    }

    return json(200, {
      payment_id:    payment.id,
      status:        payment.status,
      status_detail: payment.status_detail,
      approved:      payment.status === 'approved',
    });
  } catch (err) {
    console.error('[create-payment] erro:', err);
    return json(err.status || 500, {
      error: 'mp_error',
      message: err.message,
      detail: err.body,
    });
  }
};
