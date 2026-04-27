// netlify/functions/_shared.js
// ===================================================
// v3 — Pagamento avulso de cartão (sem /preapproval)
// /preapproval foi removido porque exige habilitação
// de produto "Assinaturas" na conta MP. Avulso funciona
// em test e produção sem qualquer config adicional.
// ===================================================

const { createClient } = require('@supabase/supabase-js');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

// ============== CONFIG ==============

function env(name, required = true) {
  const v = process.env[name];
  if (required && !v) throw new Error(`ENV ausente: ${name}`);
  return v;
}

const config = {
  supabaseUrl:        () => env('SUPABASE_URL'),
  supabaseServiceKey: () => env('SUPABASE_SERVICE_ROLE_KEY'),

  jwtSecret:          () => env('JWT_SECRET'),

  mpAccessToken:      () => env('MP_ACCESS_TOKEN'),
  mpPublicKey:        () => env('MP_PUBLIC_KEY'),
  mpWebhookSecret:    () => env('MP_WEBHOOK_SECRET'),

  appUrl:             () => env('URL', false) || env('DEPLOY_URL', false) || 'http://localhost:8888',
  frontendUrl:        () => env('URL', false) || 'http://localhost:8888',

  plans: {
    monthly: {
      price: parseFloat(env('PLAN_MONTHLY_PRICE', false) || '29.90'),
      title: 'Lilo Premium - Mensal',
      durationDays: 30,
    },
    yearly: {
      price: parseFloat(env('PLAN_YEARLY_PRICE', false) || '299.00'),
      title: 'Lilo Premium - Anual',
      durationDays: 365,
    },
  },
};

// ============== SUPABASE ==============

let _supabase = null;
function supabase() {
  if (!_supabase) {
    _supabase = createClient(config.supabaseUrl(), config.supabaseServiceKey(), {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

// ============== HTTP ==============

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function corsPreflight() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

// ============== SENHA (PBKDF2) ==============

const PBKDF2_ITER   = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(plain, salt, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `pbkdf2$${PBKDF2_ITER}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const actual = crypto.pbkdf2Sync(plain, salt, iter, expected.length, PBKDF2_DIGEST);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// ============== JWT ==============

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    config.jwtSecret(),
    { expiresIn: '7d' }
  );
}

function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret());
    return { id: payload.sub, email: payload.email };
  } catch { return null; }
}

// ============== MERCADO PAGO ==============

async function mpRequest(method, endpoint, body) {
  const url = `https://api.mercadopago.com${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${config.mpAccessToken()}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') {
    headers['X-Idempotency-Key'] = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  const res = await fetch(url, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(`MP API ${method} ${endpoint} → ${res.status}: ${data.message || text}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ===== PIX avulso =====
async function createPixPayment({ userId, planType, plan, payerEmail, payerName, payerCpf }) {
  return mpRequest('POST', '/v1/payments', {
    transaction_amount: plan.price,
    description: plan.title,
    payment_method_id: 'pix',
    payer: {
      email: payerEmail,
      first_name: payerName ? payerName.split(' ')[0] : undefined,
      last_name:  payerName ? payerName.split(' ').slice(1).join(' ') : undefined,
      identification: payerCpf ? { type: 'CPF', number: payerCpf.replace(/\D/g, '') } : undefined,
    },
    metadata: { user_id: userId, plan_type: planType, payment_kind: 'pix' },
    notification_url: `${config.appUrl()}/.netlify/functions/webhook-mercadopago`,
    external_reference: `lilo_pix_${userId}_${planType}_${Date.now()}`,
  });
}

// ===== CARTÃO avulso (substitui /preapproval) =====
async function createCardPayment({ userId, planType, plan, payerEmail, cardTokenId, installments }) {
  return mpRequest('POST', '/v1/payments', {
    transaction_amount: plan.price,
    description: plan.title,
    token: cardTokenId,
    installments: installments || 1,
    payer: { email: payerEmail },
    metadata: { user_id: userId, plan_type: planType, payment_kind: 'card' },
    notification_url: `${config.appUrl()}/.netlify/functions/webhook-mercadopago`,
    external_reference: `lilo_card_${userId}_${planType}_${Date.now()}`,
    statement_descriptor: 'LILO',
  });
}

async function getMpPayment(paymentId) {
  return mpRequest('GET', `/v1/payments/${paymentId}`);
}

// ============== WEBHOOK SIGNATURE ==============

function isValidWebhookSignature({ headers, query, body }) {
  const signatureHeader = headers['x-signature'] || headers['X-Signature'];
  const requestId = headers['x-request-id'] || headers['X-Request-Id'];
  const dataId = (query && query['data.id']) || (body && body.data && body.data.id);

  if (!signatureHeader || !requestId || !dataId) return false;

  const parts = signatureHeader.split(',').map(s => s.trim());
  const map = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k && v) map[k.trim()] = v.trim();
  }
  if (!map.ts || !map.v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${map.ts};`;
  const expected = crypto
    .createHmac('sha256', config.mpWebhookSecret())
    .update(manifest)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(map.v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  config,
  supabase,
  json,
  corsPreflight,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  createPixPayment,
  createCardPayment,
  getMpPayment,
  isValidWebhookSignature,
};
