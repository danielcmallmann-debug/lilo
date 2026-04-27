// netlify/functions/login.js
// POST /api/login
// Body: { email, password }

const { supabase, json, corsPreflight, signToken, verifyPassword } = require('./_shared');

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

    if (error) {
      console.error('[login] erro Supabase:', error);
      return json(500, { error: 'database_error', detail: error.message });
    }
    if (!user) {
      console.log('[login] email não cadastrado:', email);
      return json(401, { error: 'credenciais inválidas' });
    }

    const ok = verifyPassword(password, user.password_hash);
    if (!ok) {
      console.log('[login] senha incorreta para:', email);
      return json(401, { error: 'credenciais inválidas' });
    }

    console.log('[login] OK userId:', user.id);
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
    console.error('[login] exception:', err);
    return json(500, { error: 'server_error', detail: err.message });
  }
};
