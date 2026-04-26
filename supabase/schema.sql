-- ===============================================
-- SUPABASE SCHEMA - Lilo
-- ===============================================
-- Cole este SQL no SQL Editor do Supabase
-- (Dashboard → SQL Editor → New query → Run)
--
-- Apenas usuários e controle de pagamento ficam no banco.
-- Transações/categorias permanecem no localStorage do frontend.
-- ===============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================
-- USERS
-- =========================================
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(160) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,

  payment_status  VARCHAR(20) NOT NULL DEFAULT 'pending',
  plan_type       VARCHAR(20),
  payment_id      VARCHAR(80),
  access_expires_at TIMESTAMPTZ,

  subscription_id VARCHAR(80),
  auto_renew      BOOLEAN NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =========================================
-- PAYMENTS - histórico
-- =========================================
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mp_payment_id      VARCHAR(80) UNIQUE,
  mp_preference_id   VARCHAR(120),
  plan_type       VARCHAR(20) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  currency        VARCHAR(8) DEFAULT 'BRL',
  status          VARCHAR(30) NOT NULL,
  status_detail   VARCHAR(120),
  payment_method  VARCHAR(40),
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- =========================================
-- WEBHOOK_EVENTS - idempotência
-- =========================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_key       VARCHAR(120) NOT NULL UNIQUE,
  event_type      VARCHAR(40) NOT NULL,
  resource_id     VARCHAR(80) NOT NULL,
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  raw_body        JSONB,
  raw_headers     JSONB,
  error_message   TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

-- =========================================
-- TRIGGER updated_at
-- =========================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================
-- RLS (Row Level Security) - DESLIGADA
-- ===
-- Como o backend usa SERVICE_ROLE_KEY (que bypass RLS),
-- não precisamos configurar policies aqui.
-- O frontend NUNCA acessa o banco diretamente.
-- =========================================
ALTER TABLE users           DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments        DISABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events  DISABLE ROW LEVEL SECURITY;
