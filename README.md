# Lilo — Deploy Netlify + Supabase + Mercado Pago

Frontend estático + 6 Netlify Functions + Supabase (Postgres). O `lilo.html` continua usando localStorage para todos os dados financeiros — o backend cuida apenas de autenticação e controle de assinatura paga.

## 📦 Estrutura

```
lilo-netlify/
├── netlify.toml                 ← config build + redirects
├── package.json                 ← deps das functions
├── .env.example                 ← documentação das ENVs
├── public/
│   └── index.html               ← frontend (lilo.html + paywall)
├── netlify/functions/
│   ├── _shared.js               ← helpers (Supabase, JWT, MP)
│   ├── register.js
│   ├── login.js
│   ├── subscription-status.js
│   ├── create-payment.js
│   ├── webhook-mercadopago.js
│   └── public-config.js
└── supabase/
    └── schema.sql               ← rodar no SQL Editor do Supabase
```

---

## 🚀 Deploy passo a passo

### 1. Supabase — criar banco

1. Acesse https://supabase.com → crie um projeto
2. Aguarde o projeto provisionar
3. Vá em **SQL Editor → New query**
4. Cole o conteúdo de `supabase/schema.sql` e clique **Run**
5. Em **Settings → API**, anote:
   - **Project URL** → vai para `SUPABASE_URL`
   - **service_role key** (não a anon!) → vai para `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ Use a **service_role key**, não a `anon`. O backend bypassa RLS, e `anon` não tem permissão para inserir/atualizar usuários.

### 2. Mercado Pago — credenciais

1. Acesse https://www.mercadopago.com.br/developers/
2. **Suas integrações → Criar aplicação** (escolha "Pagamentos online")
3. Em **Credenciais de produção** (ou teste, se for sandbox):
   - **Public Key** → `MP_PUBLIC_KEY`
   - **Access Token** → `MP_ACCESS_TOKEN`

### 3. Netlify — deploy

#### Opção A — via Git (recomendado)

```bash
git init
git add .
git commit -m "Initial Lilo deploy"
git remote add origin <seu-repo-github>
git push -u origin main
```

No Netlify: **Add new site → Import an existing project → GitHub → seu repo**.

#### Opção B — via CLI (sem Git)

```bash
npm install -g netlify-cli
netlify login
netlify init       # cria o site
netlify deploy --prod
```

### 4. Configurar ENVs no Netlify

**Site Settings → Environment Variables** → Adicionar uma a uma:

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `JWT_SECRET` | Gere: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `MP_PUBLIC_KEY` | Public key do MP |
| `MP_ACCESS_TOKEN` | Access token do MP |
| `MP_WEBHOOK_SECRET` | (preencheremos no próximo passo) |

**Trigger redeploy** depois de salvar as ENVs.

### 5. Configurar Webhook do MP

1. No painel MP → **Suas integrações → seu app → Webhooks → Configurar notificações**
2. **URL de produção**:
   ```
   https://SEU-SITE.netlify.app/.netlify/functions/webhook-mercadopago
   ```
3. **Eventos**: marque apenas **"Pagamentos"**
4. **Salvar** → o MP gera um **segredo** (clique em "Copiar")
5. Cole esse segredo na ENV `MP_WEBHOOK_SECRET` do Netlify
6. **Trigger redeploy** novamente

### 6. Testar

1. Acesse `https://SEU-SITE.netlify.app`
2. **Criar conta** (não use `demo@lilo.app` — esse só funciona no modo offline)
3. Aparece o **paywall** → escolha plano e clique **Pagar**
4. Você é redirecionado para o Checkout do MP
5. Pague (com cartão de teste em sandbox: `5031 7557 3453 0604` / CVV qualquer / data futura)
6. Após pagamento, MP redireciona para `?payment=success`
7. O webhook é processado em segundos → o app libera

---

## 🧪 Cartões de teste do Mercado Pago

| Cenário | Número |
|---|---|
| Aprovado | 5031 7557 3453 0604 |
| Recusado | 4013 5406 8274 6260 |
| Pendente | 5031 4332 1540 6351 |

CVV: qualquer 3 dígitos | Validade: qualquer data futura | Nome: APRO (aprovado) ou OTHE (recusado)

---

## 🔐 Segurança garantida

- **Access Token** só existe no `_shared.js` (server-side). Nunca aparece em respostas HTTP nem no bundle do frontend.
- **Webhook validado** via HMAC-SHA256. Em produção, assinatura inválida retorna 401.
- **Idempotência** garantida pela tabela `webhook_events.event_key UNIQUE`. O mesmo evento nunca é processado 2x.
- **JWT com 7 dias** de validade armazenado no localStorage do browser (chave `lilo_jwt`).
- **RLS desligada** no Supabase porque o backend usa `service_role` e o frontend NUNCA acessa o banco direto.

---

## 🛠️ Desenvolvimento local

```bash
npm install
netlify dev    # roda em http://localhost:8888
```

O `netlify dev` lê as ENVs do `.env` (copie de `.env.example`).

Para testar o webhook localmente, exponha via **ngrok**:
```bash
ngrok http 8888
# usa https://xxxxx.ngrok.app/.netlify/functions/webhook-mercadopago
# no painel do MP
```

---

## 🔁 Renovação de plano

Quando o `access_expires_at` se aproxima do vencimento, o frontend pode chamar `/api/create-payment` novamente — o webhook estende a data automaticamente. A função `subscription-status` já retorna a flag `active` calculada com base na expiração.

Para assinatura recorrente automática, a estrutura está pronta: `users.subscription_id` e `users.auto_renew` existem no schema. Bastaria adicionar uma function `create-subscription.js` similar a `create-payment.js` chamando `/preapproval` do MP.
