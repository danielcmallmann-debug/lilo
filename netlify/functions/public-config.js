// netlify/functions/public-config.js
// GET /api/public-config
// Endpoint PÚBLICO — entrega apenas a Public Key e preços.
// O Access Token JAMAIS sai daqui.

const { json, corsPreflight, config } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();
  if (event.httpMethod !== 'GET')     return json(405, { error: 'method_not_allowed' });

  return json(200, {
    mp_public_key: config.mpPublicKey(),
    plans: {
      monthly: { price: config.plans.monthly.price, title: config.plans.monthly.title },
      yearly:  { price: config.plans.yearly.price,  title: config.plans.yearly.title  },
    },
  });
};
