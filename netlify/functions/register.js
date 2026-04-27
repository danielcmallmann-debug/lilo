// netlify/functions/register.js
// POST /api/register
// Body: { name, email, password }

const { supabase, json, corsPreflight, signToken, hashPassword } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'POST')    return json(405, { error: 'method_not_allowed' });

  try {
    const { name, email, password } = JSON.parse(event.body || '{}');

    if (!name || !email || !password) return json(400, { error: 'campos obrigatórios faltando' });
    if (password.length < 6)           return json(400, { error: 'senha muito curta' });

    const sb = supabase();

    const { data: existing, error: chkErr } = await sb
      .from('users').select('id').eq('email', email).maybeSingle();

    if (chkErr) {
      console.error('[register] erro ao checar email:', chkErr);
      return json(500, { error: 'database_error', detail: chkErr.message });
    }
    if (existing) return json(409, { error: 'e-mail já cadastrado' });

    const password_hash = hashPassword(password);

    const { data, error } = await sb
      .from('users')
      .insert({ name, email, password_hash })
      .select('id, name, email, payment_status, plan_type, access_expires_at')
      .single();

    if (error) {
      console.error('[register] erro ao inserir user:', error);
      return json(500, { error: 'database_error', detail: error.message });
    }

    console.log('[register] OK userId:', data.id);
    return json(201, {
      user: data,
      token: signToken(data),
    });
  } catch (err) {
    console.error('[register] exception:', err);
    return json(500, { error: 'server_error', detail: err.message });
  }
};
