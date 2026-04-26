// netlify/functions/subscription-status.js
// GET /api/subscription-status
// Auth: Bearer <jwt>
// Retorna: status atual do pagamento e flag "active"

const { supabase, json, corsPreflight, verifyToken } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'GET')     return json(405, { error: 'method_not_allowed' });

  const user = verifyToken(event.headers.authorization || event.headers.Authorization);
  if (!user) return json(401, { error: 'unauthorized' });

  try {
    const { data, error } = await supabase()
      .from('users')
      .select('payment_status, plan_type, access_expires_at, auto_renew')
      .eq('id', user.id)
      .maybeSingle();

    if (error || !data) return json(404, { error: 'not_found' });

    const now     = new Date();
    const expires = data.access_expires_at ? new Date(data.access_expires_at) : null;
    const active  = data.payment_status === 'approved' && expires && expires > now;

    return json(200, {
      payment_status:    data.payment_status,
      plan_type:         data.plan_type,
      access_expires_at: data.access_expires_at,
      auto_renew:        data.auto_renew,
      active,
    });
  } catch (err) {
    console.error('[subscription-status]', err);
    return json(500, { error: 'server_error' });
  }
};
