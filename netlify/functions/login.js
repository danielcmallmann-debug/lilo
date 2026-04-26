// netlify/functions/login.js
// POST /api/login
// Body: { email, password }

const { supabase, json, corsPreflight, signToken, bcrypt } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  try {
    const { email, password } = JSON.parse(event.body || '{}');
    if (!email || !password) return json(400, { error: 'credenciais obrigatórias' });

    const sb = supabase();
    const { data: user, error } = await sb
      .from('users')
      .select('id, name, email, password_hash, payment_status, plan_type, access_expires_at')
      .eq('email', email)
      .maybeSingle();

    if (error || !user) return json(401, { error: 'credenciais inválidas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return json(401, { error: 'credenciais inválidas' });

    return json(200, {
      user: {
        id: user.id, name: user.name, email: user.email,
        payment_status: user.payment_status,
        plan_type: user.plan_type,
        access_expires_at: user.access_expires_at,
      },
      token: signToken(user),
    });
  } catch (err) {
    console.error('[login]', err);
    return json(500, { error: 'server_error' });
  }
};
