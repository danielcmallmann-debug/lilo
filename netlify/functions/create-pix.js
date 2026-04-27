// netlify/functions/create-pix.js
// POST /api/create-pix
// Body: { plan_type, payer: { name, cpf } }

const {
  supabase, json, corsPreflight, verifyToken,
  createPixPayment, config,
} = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  const user = verifyToken(event.headers.authorization || event.headers.Authorization);
  if (!user) return json(401, { error: 'unauthorized' });

  try {
    const { plan_type, payer } = JSON.parse(event.body || '{}');

    if (!['monthly', 'yearly'].includes(plan_type))
      return json(400, { error: 'plan_type inválido' });
    if (!payer || !payer.cpf || !payer.name)
      return json(400, { error: 'payer.name e payer.cpf obrigatórios' });

    const plan = config.plans[plan_type];
    const sb = supabase();

    const { data: dbUser } = await sb
      .from('users').select('id, email').eq('id', user.id).maybeSingle();
    if (!dbUser) return json(404, { error: 'usuário não encontrado' });

    const payment = await createPixPayment({
      userId: dbUser.id,
      planType: plan_type,
      plan,
      payerEmail: dbUser.email,
      payerName: payer.name,
      payerCpf: payer.cpf,
    });

    console.log('[create-pix] criado:', payment.id, 'status:', payment.status);

    await sb.from('payments').insert({
      user_id: dbUser.id,
      mp_payment_id: String(payment.id),
      plan_type,
      amount: plan.price,
      status: payment.status,
      payment_method: 'pix',
      raw_payload: payment,
    });

    const td = payment.point_of_interaction?.transaction_data || {};
    return json(200, {
      payment_id: payment.id,
      status: payment.status,
      qr_code: td.qr_code,
      qr_code_base64: td.qr_code_base64,
      ticket_url: td.ticket_url,
      expires_at: payment.date_of_expiration,
    });
  } catch (err) {
    console.error('[create-pix] erro:', err);
    return json(err.status || 500, {
      error: 'mp_error',
      message: err.message,
      detail: err.body,
    });
  }
};
