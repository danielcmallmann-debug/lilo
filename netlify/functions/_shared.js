// netlify/functions/_shared.js
// ===================================================
// Helpers compartilhados entre todas as Functions.
// Importado via: const shared = require('./_shared');
// ===================================================

const { createClient } = require('@supabase/supabase-js');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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

// ============== SUPABASE CLIENT ==============

let _supabase = null;
function supabase() {
  if (!_supabase) {
    _supabase = createClient(config.supabaseUrl(), config.supabaseServiceKey(), {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

// ============== HTTP HELPERS ==============

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

// ============== MERCADO PAGO CLIENT ==============
// Único lugar com acesso ao MP_ACCESS_TOKEN.

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
    method,
    headers,
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

async function createMpPreference({ userId, planType, plan, payerEmail }) {
  const externalRef = `lilo_${userId}_${planType}_${Date.now()}`;

  return mpRequest('POST', '/checkout/preferences', {
    items: [{
      id: `plan_${planType}`,
      title: plan.title,
      description: `Assinatura Lilo ${planType === 'yearly' ? 'anual' : 'mensal'}`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: plan.price,
    }],
    payer: payerEmail ? { email: payerEmail } : undefined,
    metadata: { user_id: userId, plan_type: planType },
    external_reference: externalRef,
    back_urls: {
      success: `${config.frontendUrl()}/?payment=success`,
      failure: `${config.frontendUrl()}/?payment=failure`,
      pending: `${config.frontendUrl()}/?payment=pending`,
    },
    auto_return: 'approved',
    notification_url: `${config.appUrl()}/.netlify/functions/webhook-mercadopago`,
    statement_descriptor: 'LILO',
  });
}

async function getMpPayment(paymentId) {
  return mpRequest('GET', `/v1/payments/${paymentId}`);
}

// ============== WEBHOOK SIGNATURE VALIDATION ==============

function isValidWebhookSignature({ headers, query, body }) {
  const signatureHeader = headers['x-signature'];
  const requestId = headers['x-request-id'];
  const dataId = (query && query['data.id']) || (body && body.data && body.data.id);

  if (!signatureHeader || !requestId || !dataId) return false;

  // Parse "ts=...,v1=..."
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

// ============== EXPORTS ==============

module.exports = {
  config,
  supabase,
  json,
  corsPreflight,
  signToken,
  verifyToken,
  bcrypt,
  createMpPreference,
  getMpPayment,
  isValidWebhookSignature,
};
