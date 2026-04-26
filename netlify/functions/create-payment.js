// netlify/functions/create-payment.js
// POST /api/create-payment
// Auth: Bearer <jwt>
// Body: { plan_type: 'monthly' | 'yearly' }

const {
  supabase, json, corsPreflight, verifyToken,
  createMpPreference, config,
} = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  const user = verifyToken(event.headers.authorization || event.headers.Authorization);
  if (!user) return json(401, { error: 'unauthorized' });

  try {
    const { plan_type } = JSON.parse(event.body || '{}');
    if (!['monthly', 'yearly'].includes(plan_type))
      return json(400, { error: 'plan_type inválido' });

    const plan = config.plans[plan_type];
    const sb = supabase();

    // Buscar e-mail
    const { data: dbUser, error: uErr } = await sb
      .from('users').select('id, email').eq('id', user.id).maybeSingle();
    if (uErr || !dbUser) return json(404, { error: 'usuário não encontrado' });

    // Criar preferência no MP
    const preference = await createMpPreference({
      userId: dbUser.id,
      planType: plan_type,
      plan,
      payerEmail: dbUser.email,
    });

    // Auditoria — inserir payment como 'pending'
    await sb.from('payments').insert({
      user_id:           dbUser.id,
      mp_preference_id:  preference.id,
      plan_type,
      amount:            plan.price,
      status:            'pending',
    });

    return json(200, {
      preference_id:        preference.id,
      init_point:           preference.init_point,
      sandbox_init_point:   preference.sandbox_init_point,
    });
  } catch (err) {
    console.error('[create-payment]', err);
    return json(err.status || 500, {
      error: 'server_error',
      message: err.message,
    });
  }
};
