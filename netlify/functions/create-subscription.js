// netlify/functions/create-subscription.js
// ===================================================
// POST /api/create-subscription
// Body: { plan_type: 'monthly'|'yearly', card_token_id: '...' }
//
// Recebe o card_token gerado pelo Card Payment Brick no frontend,
// cria assinatura recorrente no MP via /preapproval.
// ===================================================

const {
  supabase, json, corsPreflight, verifyToken,
  createCardSubscription, config,
} = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  const user = verifyToken(event.headers.authorization || event.headers.Authorization);
  if (!user) return json(401, { error: 'unauthorized' });

  try {
    const { plan_type, card_token_id } = JSON.parse(event.body || '{}');

    if (!['monthly', 'yearly'].includes(plan_type))
      return json(400, { error: 'plan_type inválido' });
    if (!card_token_id)
      return json(400, { error: 'card_token_id obrigatório' });

    const plan = config.plans[plan_type];
    const sb = supabase();

    const { data: dbUser, error: uErr } = await sb
      .from('users').select('id, email').eq('id', user.id).maybeSingle();
    if (uErr || !dbUser) return json(404, { error: 'usuário não encontrado' });

    // Cria assinatura no MP
    const subscription = await createCardSubscription({
      userId: dbUser.id,
      planType: plan_type,
      plan,
      payerEmail: dbUser.email,
      cardTokenId: card_token_id,
    });

    console.log('[create-subscription] criada:', subscription.id, 'status:', subscription.status);

    // Registra payment como pending (será atualizado pelo webhook)
    await sb.from('payments').insert({
      user_id:  dbUser.id,
      plan_type,
      amount:   plan.price,
      status:   subscription.status === 'authorized' ? 'approved' : 'pending',
      raw_payload: subscription,
    });

    // Salva subscription_id no usuário
    await sb.from('users').update({
      subscription_id: subscription.id,
      auto_renew: true,
    }).eq('id', dbUser.id);

    // Se MP já autorizou na hora (caminho feliz), libera acesso imediatamente
    if (subscription.status === 'authorized') {
      const expiresAt = new Date(Date.now() + plan.durationDays * 24*60*60*1000).toISOString();
      await sb.from('users').update({
        payment_status: 'approved',
        plan_type,
        access_expires_at: expiresAt,
      }).eq('id', dbUser.id);
    }

    return json(200, {
      subscription_id: subscription.id,
      status: subscription.status,
      // Frontend pode ler isso para decidir se libera na hora ou aguarda webhook
      authorized: subscription.status === 'authorized',
    });
  } catch (err) {
    console.error('[create-subscription] erro:', err);
    return json(err.status || 500, {
      error: 'mp_error',
      message: err.message,
      detail: err.body,
    });
  }
};
