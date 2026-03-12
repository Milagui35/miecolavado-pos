require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);
const READER_ID = process.env.STRIPE_READER_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'miecolavado-pos-session';

const CONFIG_FILE = path.join(__dirname, 'config.json');
const SALES_FILE = path.join(__dirname, 'sales_history.json');
const USERS_FILE = path.join(__dirname, 'users.json');

function roundToCents(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

function toMinorUnits(amountDecimal, currency) {
  if (!['usd', 'hnl'].includes(currency)) {
    throw new Error(`Unsupported currency for this POS: ${currency}`);
  }
  return Math.round(Number(amountDecimal || 0) * 100);
}

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(
        {
          usd_per_hnl: Number(process.env.USD_PER_HNL || 0.04065),
          tax_rate: 0.15,
          receipt_counter: 1,
          current_shift_start: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }
}

function ensureSalesFile() {
  if (!fs.existsSync(SALES_FILE)) {
    fs.writeFileSync(
      SALES_FILE,
      JSON.stringify({ sales: [] }, null, 2)
    );
  }
}

function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
      USERS_FILE,
      JSON.stringify(
        {
          users: [
            {
              username: 'admin',
              password: '5858',
              role: 'admin',
            },
          ],
        },
        null,
        2
      )
    );
  }
}

function ensureDataFiles() {
  ensureConfigFile();
  ensureSalesFile();
  ensureUsersFile();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getConfig() {
  ensureConfigFile();
  return readJson(CONFIG_FILE);
}

function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
}

function getSalesData() {
  ensureSalesFile();
  return readJson(SALES_FILE);
}

function saveSalesData(data) {
  writeJson(SALES_FILE, data);
}

function getUsersData() {
  ensureUsersFile();
  return readJson(USERS_FILE);
}

function saveSaleRecord(record) {
  const salesData = getSalesData();
  salesData.sales.unshift(record);
  saveSalesData(salesData);
}

function getNextReceiptNumber() {
  const config = getConfig();
  const current = Number(config.receipt_counter || 1);
  config.receipt_counter = current + 1;
  saveConfig(config);
  return String(current).padStart(6, '0');
}

function calculateTotals(hnlAmount, taxRate) {
  const subtotalHnl = roundToCents(hnlAmount);
  const taxAmountHnl = roundToCents(subtotalHnl * Number(taxRate || 0));
  const totalHnl = roundToCents(subtotalHnl + taxAmountHnl);
  return {
    subtotalHnl,
    taxAmountHnl,
    totalHnl,
  };
}

function convertHnlToUsd(hnlAmount, usdPerHnl) {
  return roundToCents(Number(hnlAmount || 0) * Number(usdPerHnl || 0));
}

function buildCart({ description, hnlAmount, taxRate }) {
  const totals = calculateTotals(hnlAmount, taxRate);
  return {
    currency: 'hnl',
    tax: toMinorUnits(totals.taxAmountHnl, 'hnl'),
    total: toMinorUnits(totals.totalHnl, 'hnl'),
    line_items: [
      {
        description,
        amount: toMinorUnits(totals.subtotalHnl, 'hnl'),
        quantity: 1,
      },
    ],
  };
}

function assertEnv() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY in .env');
  }
  if (!READER_ID) {
    throw new Error('Missing STRIPE_READER_ID in .env');
  }
}

async function setReaderDisplay({ description, hnlAmount, taxRate }) {
  const cart = buildCart({ description, hnlAmount, taxRate });
  return stripe.terminal.readers.setReaderDisplay(READER_ID, {
    type: 'cart',
    cart,
  });
}

async function clearReaderDisplay() {
  return stripe.terminal.readers.cancelAction(READER_ID);
}

async function createPaymentIntent({
  description,
  hnlAmount,
  receiptNumber,
  usdPerHnl,
  taxRate,
}) {
  const totals = calculateTotals(hnlAmount, taxRate);
  const usdAmount = convertHnlToUsd(totals.totalHnl, usdPerHnl);
  const usdMinor = toMinorUnits(usdAmount, 'usd');

  const paymentIntent = await stripe.paymentIntents.create({
    amount: usdMinor,
    currency: 'usd',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    description:
      description +
      ' | Receipt #' + receiptNumber +
      ' | Subtotal HNL: L ' + totals.subtotalHnl.toFixed(2) +
      ' | ISV: L ' + totals.taxAmountHnl.toFixed(2) +
      ' | Total HNL: L ' + totals.totalHnl.toFixed(2),
    metadata: {
      receipt_number: receiptNumber,
      source_currency: 'hnl',
      source_subtotal_hnl: totals.subtotalHnl.toFixed(2),
      source_tax_hnl: totals.taxAmountHnl.toFixed(2),
      source_total_hnl: totals.totalHnl.toFixed(2),
      conversion_rate_usd_per_hnl: String(usdPerHnl),
      converted_amount_usd: usdAmount.toFixed(2),
      tax_rate: String(taxRate),
    },
  });

  return {
    paymentIntent,
    usdAmount,
    subtotalHnl: totals.subtotalHnl,
    taxAmountHnl: totals.taxAmountHnl,
    totalHnl: totals.totalHnl,
  };
}

async function collectPaymentMethodOnReader(paymentIntentId) {
  return stripe.terminal.readers.collectPaymentMethod(READER_ID, {
    payment_intent: paymentIntentId,
  });
}

async function processPaymentIntentOnReader(paymentIntentId) {
  return stripe.terminal.readers.processPaymentIntent(READER_ID, {
    payment_intent: paymentIntentId,
  });
}

async function retrievePaymentIntent(paymentIntentId) {
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFinalPaymentIntentWithRetry(paymentIntentId) {
  let latest = null;

  for (let i = 0; i < 8; i++) {
    latest = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (
      latest &&
      latest.status &&
      ![
        'requires_payment_method',
        'requires_confirmation',
        'processing',
      ].includes(latest.status)
    ) {
      return latest;
    }

    if (
      latest &&
      typeof latest.amount_received === 'number' &&
      latest.amount_received > 0 &&
      latest.status !== 'canceled'
    ) {
      return latest;
    }

    await waitMs(1200);
  }

  return latest;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((item) => {
    const parts = item.split('=');
    const key = (parts.shift() || '').trim();
    const value = (parts.join('=') || '').trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  });
  return cookies;
}

function buildSessionToken(username, password) {
  return crypto
    .createHash('sha256')
    .update(`${username}:${password}:${SESSION_SECRET}`)
    .digest('hex');
}

function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const username = cookies.pos_user || '';
  const token = cookies.pos_token || '';
  if (!username || !token) return null;

  const users = getUsersData().users || [];
  const user = users.find((entry) => entry.username === username);
  if (!user) return null;

  const expectedToken = buildSessionToken(user.username, user.password);
  if (expectedToken !== token) return null;

  return {
    username: user.username,
    role: user.role || 'cashier',
  };
}

function requireAuth(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) {
    if ((req.path || '').startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }
  req.currentUser = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = req.currentUser || getCurrentUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function setSessionCookies(res, username, password) {
  const token = buildSessionToken(username, password);
  res.setHeader('Set-Cookie', [
    `pos_user=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
    `pos_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
  ]);
}

function clearSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    'pos_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'pos_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
  ]);
}

function normalizeAttemptStatus(paymentIntent, fallbackError) {
  if (paymentIntent) {
    if (paymentIntent.status === 'succeeded') {
      return 'succeeded';
    }

    if (
      typeof paymentIntent.amount_received === 'number' &&
      paymentIntent.amount_received > 0 &&
      paymentIntent.status !== 'canceled'
    ) {
      return 'succeeded';
    }

    if (paymentIntent.status) {
      return paymentIntent.status;
    }
  }

  if (fallbackError && fallbackError.code) {
    return fallbackError.code;
  }

  return 'failed';
}

function calculateShiftSummary() {
  const config = getConfig();
  const sales = (getSalesData().sales || []).filter((sale) => {
    return new Date(sale.createdAtISO).getTime() >= new Date(config.current_shift_start).getTime();
  });

  let totalSoldHnl = 0;
  let totalFailedHnl = 0;
  let totalUsd = 0;
  let totalTaxHnl = 0;
  let successCount = 0;
  let failedCount = 0;

  sales.forEach((sale) => {
    if (sale.paymentIntentStatus === 'succeeded') {
      successCount += 1;
      totalSoldHnl += Number(sale.totalHnl || 0);
      totalUsd += Number(sale.chargedUsd || 0);
      totalTaxHnl += Number(sale.taxHnl || 0);
    } else {
      failedCount += 1;
      totalFailedHnl += Number(sale.totalHnl || 0);
    }
  });

  return {
    shiftStartISO: config.current_shift_start,
    shiftStartLocal: new Date(config.current_shift_start).toLocaleString('es-HN'),
    attempts: sales.length,
    successCount,
    failedCount,
    totalSoldHnl: roundToCents(totalSoldHnl),
    totalFailedHnl: roundToCents(totalFailedHnl),
    totalUsd: roundToCents(totalUsd),
    totalTaxHnl: roundToCents(totalTaxHnl),
  };
}

ensureDataFiles();

app.get('/login', (req, res) => {
  if (getCurrentUser(req)) {
    return res.redirect('/');
  }

  const hasError = req.query && req.query.error === '1';

  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Login POS Mi Eco Lavado</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #f3f6fb, #e8eef9);
      color: #111;
    }
    .card {
      width: min(420px, calc(100vw - 32px));
      background: #fff;
      border-radius: 20px;
      padding: 26px;
      box-shadow: 0 14px 35px rgba(0,0,0,0.08);
    }
    .badge {
      display: inline-block;
      padding: 6px 10px;
      background: #eef3ff;
      border-radius: 999px;
      font-size: 13px;
      margin-bottom: 10px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 30px;
    }
    p {
      color: #5a6275;
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-weight: 700;
      margin: 10px 0 6px;
      font-size: 14px;
    }
    input, button {
      width: 100%;
      box-sizing: border-box;
      padding: 13px 14px;
      border-radius: 12px;
      border: 1px solid #d7dbea;
      font-size: 16px;
    }
    button {
      margin-top: 14px;
      font-weight: 700;
      cursor: pointer;
      background: #111827;
      color: #fff;
      border: none;
    }
    .error {
      margin-top: 12px;
      color: #b42318;
      font-size: 14px;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="badge">Mi Eco Lavado / Acceso POS</div>
    <h1>Iniciar sesión</h1>
    <p>Entrá con tu usuario y clave para usar el POS.</p>
    <label for="username">Usuario</label>
    <input id="username" name="username" autocomplete="username" required />
    <label for="password">Clave</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Entrar</button>
    <div class="error">${hasError ? 'Usuario o clave incorrectos.' : ''}</div>
  </form>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();
  const users = getUsersData().users || [];
  const user = users.find((entry) => entry.username === username && entry.password === password);

  if (!user) {
    return res.redirect('/login?error=1');
  }

  setSessionCookies(res, user.username, user.password);
  return res.redirect('/');
});

app.post('/logout', requireAuth, (_req, res) => {
  clearSessionCookies(res);
  return res.json({ ok: true });
});

app.get('/', requireAuth, (req, res) => {
  const config = getConfig();
  const currentUser = req.currentUser;

  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>POS Mi Eco Lavado</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      background: #f6f7fb;
      color: #111;
    }
    .wrap {
      max-width: 1380px;
      margin: 24px auto;
      padding: 24px;
    }
    .layout {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 20px;
      align-items: start;
    }
    .left-col, .right-col {
      display: grid;
      gap: 20px;
    }
    .card {
      background: #fff;
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.08);
    }
    h1, h2, h3 {
      margin-top: 0;
    }
    h1 {
      font-size: 30px;
      margin-bottom: 10px;
    }
    h2 {
      font-size: 22px;
      margin-bottom: 14px;
    }
    h3 {
      font-size: 18px;
      margin-bottom: 10px;
    }
    .grid {
      display: grid;
      gap: 14px;
    }
    label {
      font-weight: 700;
      font-size: 14px;
    }
    input, button {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid #d7dbea;
      font-size: 16px;
    }
    button {
      cursor: pointer;
      font-weight: 700;
      background: white;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 12px;
      margin-top: 10px;
    }
    .summary {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px;
      margin-top: 8px;
    }
    .summary div {
      margin: 7px 0;
      font-size: 16px;
    }
    .status {
      margin-top: 18px;
      white-space: pre-wrap;
      background: #0f172a;
      color: #e2e8f0;
      padding: 16px;
      border-radius: 12px;
      min-height: 140px;
    }
    .badge {
      display: inline-block;
      padding: 6px 10px;
      background: #eef3ff;
      border-radius: 999px;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .small {
      color: #5a6275;
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .toolbar button {
      width: auto;
      padding: 10px 14px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      padding: 12px 10px;
      border-bottom: 1px solid #edf2f7;
      text-align: left;
      font-size: 14px;
    }
    th {
      background: #f8fafc;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tr:hover td {
      background: #fafcff;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .right {
      text-align: right;
    }
    .pill {
      display: inline-block;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: #e5e7eb;
      color: #374151;
      text-transform: uppercase;
    }
    .pill-success {
      background: #dcfce7;
      color: #166534;
    }
    .pill-failed {
      background: #fee2e2;
      color: #991b1b;
    }
    .pill-pending {
      background: #ffedd5;
      color: #9a3412;
    }
    .empty {
      padding: 18px;
      color: #64748b;
    }
    .config-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .config-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px;
    }
    .config-box .value {
      font-size: 24px;
      font-weight: 700;
      margin: 6px 0 10px;
    }
    .config-box button {
      margin-top: 6px;
    }
    .close-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .metric {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px;
    }
    .metric .label {
      color: #64748b;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .metric .value {
      font-size: 22px;
      font-weight: 700;
    }
    @media (max-width: 1180px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 700px) {
      .actions, .config-grid, .close-grid, .row {
        grid-template-columns: 1fr;
      }
      table {
        min-width: 860px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="layout">
      <div class="left-col">
        <div class="card">
          <div class="toolbar">
            <div>
              <div class="badge">Mi Eco Lavado / Stripe Terminal POS</div>
              <h1>POS HNL en pantalla, cobro real en USD</h1>
              <div class="small">Usuario actual: <strong>${currentUser.username}</strong> (${currentUser.role})</div>
            </div>
            <button id="logoutBtn">Salir</button>
          </div>
          <p class="small">Calcula subtotal, ISV, total, muestra HNL en el reader y guarda todos los intentos de cobro.</p>

          <div class="grid">
            <div>
              <label for="description">Descripción</label>
              <input id="description" value="Lavado industrial" />
            </div>

            <div class="row">
              <div>
                <label for="hnlAmount">Subtotal en HNL</label>
                <input id="hnlAmount" type="number" min="0" step="0.01" value="2500" />
              </div>
              <div>
                <label for="rateDisplay">Tasa usada</label>
                <input id="rateDisplay" value="${Number(config.usd_per_hnl || 0.04065)}" disabled />
              </div>
            </div>

            <div class="summary">
              <div><strong>Subtotal:</strong> <span id="subtotalPreview">L 2500.00</span></div>
              <div><strong>ISV:</strong> <span id="taxPreview">L 375.00</span></div>
              <div><strong>Total:</strong> <span id="totalPreview">L 2875.00</span></div>
            </div>

            <div class="actions">
              <button id="previewBtn">1. Mostrar HNL en reader</button>
              <button id="chargeBtn">2. Cobrar</button>
              <button id="clearBtn">3. Limpiar pantalla reader</button>
              <button id="printBtn">4. Imprimir recibo</button>
            </div>
          </div>

          <div id="status" class="status">Listo.</div>
        </div>

        <div class="card">
          <div class="toolbar">
            <div>
              <h2 style="margin-bottom:4px;">Configuración</h2>
              <div class="small">Cambios protegidos con PIN 5858.</div>
            </div>
          </div>
          <div class="config-grid">
            <div class="config-box">
              <div class="small">Tasa USD/HNL</div>
              <div class="value" id="configRateValue">${Number(config.usd_per_hnl || 0.04065).toFixed(4)}</div>
              <button id="changeRateBtn">Cambiar tasa</button>
            </div>
            <div class="config-box">
              <div class="small">ISV actual</div>
              <div class="value" id="configTaxValue">${(Number(config.tax_rate || 0.15) * 100).toFixed(2)}%</div>
              <button id="changeTaxBtn">Cambiar impuesto</button>
            </div>
          </div>
        </div>
      </div>

      <div class="right-col">
        <div class="card">
          <div class="toolbar">
            <div>
              <h2 style="margin-bottom:4px;">Cierre de caja actual</h2>
              <div class="small">Turno desde que se abrió la caja hasta que presiones “Cerrar caja”.</div>
              <div class="small">Inicio de caja: <span id="shiftStartLabel"></span></div>
            </div>
            <button id="closeShiftBtn">Cerrar caja</button>
          </div>
          <div class="close-grid">
            <div class="metric"><div class="label">Intentos</div><div class="value" id="shiftAttempts">0</div></div>
            <div class="metric"><div class="label">Exitosas</div><div class="value" id="shiftSuccessCount">0</div></div>
            <div class="metric"><div class="label">Fallidas</div><div class="value" id="shiftFailedCount">0</div></div>
            <div class="metric"><div class="label">Total vendido HNL</div><div class="value" id="shiftTotalSoldHnl">L 0.00</div></div>
            <div class="metric"><div class="label">Total fallido HNL</div><div class="value" id="shiftTotalFailedHnl">L 0.00</div></div>
            <div class="metric"><div class="label">Total USD</div><div class="value" id="shiftTotalUsd">$ 0.00</div></div>
            <div class="metric"><div class="label">Total ISV</div><div class="value" id="shiftTotalTaxHnl">L 0.00</div></div>
          </div>
        </div>

        <div class="card">
          <div class="toolbar">
            <div>
              <h2 style="margin-bottom:4px;">Historial de ventas</h2>
              <div class="small">Se guardan todos los intentos en sales_history.json y también se ven aquí.</div>
            </div>
            <button id="refreshSalesBtn">Actualizar tabla</button>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Fecha / hora</th>
                  <th>Descripción</th>
                  <th class="right">Subtotal</th>
                  <th class="right">ISV</th>
                  <th class="right">Total HNL</th>
                  <th class="right">USD</th>
                  <th>Estado</th>
                  <th>Error</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody id="salesTableBody">
                <tr><td colspan="10" class="empty">No hay ventas todavía.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const currentUser = ${JSON.stringify(currentUser)};
    const initialConfig = ${JSON.stringify(config)};
    let currentConfig = {
      usd_per_hnl: Number(initialConfig.usd_per_hnl || 0.04065),
      tax_rate: Number(initialConfig.tax_rate || 0.15),
    };
    const statusEl = document.getElementById('status');
    const descriptionEl = document.getElementById('description');
    const hnlAmountEl = document.getElementById('hnlAmount');
    const subtotalPreviewEl = document.getElementById('subtotalPreview');
    const taxPreviewEl = document.getElementById('taxPreview');
    const totalPreviewEl = document.getElementById('totalPreview');
    const salesTableBodyEl = document.getElementById('salesTableBody');
    const rateDisplayEl = document.getElementById('rateDisplay');
    const configRateValueEl = document.getElementById('configRateValue');
    const configTaxValueEl = document.getElementById('configTaxValue');
    let lastSale = null;

    function roundToCents(amount) {
      return Math.round(Number(amount || 0) * 100) / 100;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function updateSummary() {
      const subtotal = Number(hnlAmountEl.value) || 0;
      const tax = roundToCents(subtotal * currentConfig.tax_rate);
      const total = roundToCents(subtotal + tax);
      subtotalPreviewEl.textContent = 'L ' + subtotal.toFixed(2);
      taxPreviewEl.textContent = 'L ' + tax.toFixed(2);
      totalPreviewEl.textContent = 'L ' + total.toFixed(2);
      rateDisplayEl.value = currentConfig.usd_per_hnl.toFixed(4);
      configRateValueEl.textContent = currentConfig.usd_per_hnl.toFixed(4);
      configTaxValueEl.textContent = (currentConfig.tax_rate * 100).toFixed(2) + '%';
    }

    function setStatus(message) {
      if (typeof message === 'string') {
        statusEl.textContent = message;
      } else {
        statusEl.textContent = JSON.stringify(message, null, 2);
      }
    }

    function payload() {
      return {
        description: descriptionEl.value.trim(),
        hnlAmount: Number(hnlAmountEl.value),
      };
    }

    async function post(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }

    async function getJson(url) {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }

    function getStatusClass(status) {
      const value = String(status || '').toLowerCase();
      if (value === 'succeeded') return 'pill pill-success';
      if (value.includes('requires_') || value === 'processing' || value === 'incomplete') {
        return 'pill pill-pending';
      }
      return 'pill pill-failed';
    }

    function printReceipt(sale) {
      if (!sale) {
        alert('Todavía no hay ninguna transacción para imprimir.');
        return;
      }

      const printWindow = window.open('', '_blank', 'width=420,height=700');
      const html =
        '<!doctype html>' +
        '<html>' +
        '<head>' +
          '<meta charset="utf-8" />' +
          '<title>Recibo ' + escapeHtml(sale.receiptNumber || '') + '</title>' +
          '<style>' +
            '@page { size: 80mm auto; margin: 4mm; }' +
            'body {' +
              'font-family: monospace;' +
              'width: 72mm;' +
              'margin: 0 auto;' +
              'color: #000;' +
              'font-size: 12px;' +
              'line-height: 1.35;' +
            '}' +
            '.center { text-align: center; }' +
            '.bold { font-weight: bold; }' +
            '.sep { border-top: 1px dashed #000; margin: 8px 0; }' +
            '.row { display: flex; justify-content: space-between; gap: 8px; }' +
            '.mt { margin-top: 6px; }' +
            '.lg { font-size: 16px; }' +
          '</style>' +
        '</head>' +
        '<body>' +
          '<div class="center bold lg">Mi Eco Lavado</div>' +
          '<div class="center">Tegucigalpa, Honduras</div>' +
          '<div class="center">Tel: +504 3227-5543</div>' +
          '<div class="center">Recibo de pago</div>' +
          '<div class="sep"></div>' +
          '<div class="row"><span>No.:</span><span>' + escapeHtml(sale.receiptNumber || '') + '</span></div>' +
          '<div class="row"><span>Fecha:</span><span>' + escapeHtml(sale.localDateTime || '') + '</span></div>' +
          '<div class="row"><span>Estado:</span><span>' + escapeHtml(sale.paymentIntentStatus || '') + '</span></div>' +
          '<div class="sep"></div>' +
          '<div class="bold">Detalle</div>' +
          '<div class="mt">' + escapeHtml(sale.description || '') + '</div>' +
          '<div class="sep"></div>' +
          '<div class="row"><span>Subtotal</span><span>L ' + escapeHtml(sale.subtotalHnl || '0.00') + '</span></div>' +
          '<div class="row"><span>ISV (' + escapeHtml(sale.taxRatePct || '0.00') + '%)</span><span>L ' + escapeHtml(sale.taxHnl || '0.00') + '</span></div>' +
          '<div class="row bold"><span>TOTAL</span><span>L ' + escapeHtml(sale.totalHnl || '0.00') + '</span></div>' +
          '<div class="sep"></div>' +
          '<div class="row"><span>Cobrado en USD</span><span>$ ' + escapeHtml(sale.chargedUsd || '0.00') + '</span></div>' +
          (sale.errorMessage ? '<div class="mt">Error: ' + escapeHtml(sale.errorMessage) + '</div>' : '') +
          '<div class="sep"></div>' +
          '<div class="center">¡Gracias por su preferencia!</div>' +
          '<div class="center">Copia cliente</div>' +
          '<script>window.onload = function () { window.print(); };<\\/script>' +
        '</body>' +
        '</html>';
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
    }

    function renderSalesTable(sales) {
      if (!sales.length) {
        salesTableBodyEl.innerHTML = '<tr><td colspan="10" class="empty">No hay ventas todavía.</td></tr>';
        return;
      }

      salesTableBodyEl.innerHTML = sales.map(function (sale) {
        const saleJson = encodeURIComponent(JSON.stringify(sale));
        return (
          '<tr>' +
            '<td class="mono">' + escapeHtml(sale.receiptNumber || '') + '</td>' +
            '<td>' + escapeHtml(sale.localDateTime || '') + '</td>' +
            '<td>' + escapeHtml(sale.description || '') + '</td>' +
            '<td class="right">L ' + escapeHtml(sale.subtotalHnl || '0.00') + '</td>' +
            '<td class="right">L ' + escapeHtml(sale.taxHnl || '0.00') + '</td>' +
            '<td class="right"><strong>L ' + escapeHtml(sale.totalHnl || '0.00') + '</strong></td>' +
            '<td class="right">$ ' + escapeHtml(sale.chargedUsd || '0.00') + '</td>' +
            '<td><span class="' + getStatusClass(sale.paymentIntentStatus) + '">' + escapeHtml(sale.paymentIntentStatus || 'failed') + '</span></td>' +
            '<td>' + escapeHtml(sale.errorMessage || '') + '</td>' +
            '<td><button type="button" data-sale="' + saleJson + '" class="print-sale-btn">Imprimir</button></td>' +
          '</tr>'
        );
      }).join('');

      document.querySelectorAll('.print-sale-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const sale = JSON.parse(decodeURIComponent(btn.getAttribute('data-sale')));
          printReceipt(sale);
        });
      });
    }

    async function loadSalesTable() {
      try {
        const data = await getJson('/api/sales');
        const sales = data.sales || [];
        renderSalesTable(sales);
        if (sales.length) {
          lastSale = sales[0];
        }
      } catch (err) {
        salesTableBodyEl.innerHTML =
          '<tr><td colspan="10" class="empty">Error cargando ventas: ' +
          escapeHtml(err.message) +
          '</td></tr>';
      }
    }

    async function loadConfig() {
      try {
        const data = await getJson('/api/config');
        currentConfig = {
          usd_per_hnl: Number(data.config.usd_per_hnl || 0.04065),
          tax_rate: Number(data.config.tax_rate || 0.15),
        };
        updateSummary();
      } catch (err) {
        setStatus('Error cargando configuración: ' + err.message);
      }
    }

    async function loadShiftSummary() {
      try {
        const data = await getJson('/api/shift-summary');
        document.getElementById('shiftStartLabel').textContent = data.summary.shiftStartLocal;
        document.getElementById('shiftAttempts').textContent = String(data.summary.attempts || 0);
        document.getElementById('shiftSuccessCount').textContent = String(data.summary.successCount || 0);
        document.getElementById('shiftFailedCount').textContent = String(data.summary.failedCount || 0);
        document.getElementById('shiftTotalSoldHnl').textContent = 'L ' + Number(data.summary.totalSoldHnl || 0).toFixed(2);
        document.getElementById('shiftTotalFailedHnl').textContent = 'L ' + Number(data.summary.totalFailedHnl || 0).toFixed(2);
        document.getElementById('shiftTotalUsd').textContent = '$ ' + Number(data.summary.totalUsd || 0).toFixed(2);
        document.getElementById('shiftTotalTaxHnl').textContent = 'L ' + Number(data.summary.totalTaxHnl || 0).toFixed(2);
      } catch (err) {
        setStatus('Error cargando cierre de caja: ' + err.message);
      }
    }

    async function changeConfigValue(type) {
      if (currentUser.role !== 'admin') {
        alert('Solo admin puede cambiar esta configuración.');
        return;
      }

      const pin = window.prompt('Ingrese PIN para continuar');
      if (pin === null) return;
      if (pin !== '5858') {
        alert('PIN incorrecto.');
        return;
      }

      if (type === 'rate') {
        const newValue = window.prompt('Nueva tasa USD por HNL', String(currentConfig.usd_per_hnl.toFixed(4)));
        if (newValue === null) return;
        const rate = Number(newValue);
        if (!Number.isFinite(rate) || rate <= 0) {
          alert('Tasa inválida.');
          return;
        }
        await post('/api/change-rate', { rate: rate });
      }

      if (type === 'tax') {
        const newValue = window.prompt('Nuevo impuesto (%)', String((currentConfig.tax_rate * 100).toFixed(2)));
        if (newValue === null) return;
        const taxPct = Number(newValue);
        if (!Number.isFinite(taxPct) || taxPct < 0) {
          alert('Impuesto inválido.');
          return;
        }
        await post('/api/change-tax', { taxRatePct: taxPct });
      }

      await loadConfig();
      await loadShiftSummary();
      setStatus('Configuración actualizada correctamente.');
    }

    hnlAmountEl.addEventListener('input', updateSummary);
    document.getElementById('refreshSalesBtn').addEventListener('click', async function () {
      await loadSalesTable();
      await loadShiftSummary();
    });
    document.getElementById('printBtn').addEventListener('click', function () {
      printReceipt(lastSale);
    });
    document.getElementById('logoutBtn').addEventListener('click', async function () {
      await post('/logout');
      window.location.href = '/login';
    });
    document.getElementById('changeRateBtn').addEventListener('click', async function () {
      try {
        await changeConfigValue('rate');
      } catch (err) {
        setStatus('Error cambiando tasa: ' + err.message);
      }
    });
    document.getElementById('changeTaxBtn').addEventListener('click', async function () {
      try {
        await changeConfigValue('tax');
      } catch (err) {
        setStatus('Error cambiando impuesto: ' + err.message);
      }
    });
    document.getElementById('closeShiftBtn').addEventListener('click', async function () {
      try {
        const summary = await post('/api/close-shift', {});
        alert(
          'CIERRE DE CAJA\\n\\n' +
          'Intentos: ' + summary.summary.attempts + '\\n' +
          'Exitosas: ' + summary.summary.successCount + '\\n' +
          'Fallidas: ' + summary.summary.failedCount + '\\n\\n' +
          'Total vendido HNL: L ' + Number(summary.summary.totalSoldHnl).toFixed(2) + '\\n' +
          'Total fallido HNL: L ' + Number(summary.summary.totalFailedHnl).toFixed(2) + '\\n' +
          'Total USD: $ ' + Number(summary.summary.totalUsd).toFixed(2) + '\\n' +
          'Total ISV: L ' + Number(summary.summary.totalTaxHnl).toFixed(2)
        );
        await loadShiftSummary();
      } catch (err) {
        setStatus('Error cerrando caja: ' + err.message);
      }
    });

    updateSummary();
    loadConfig();
    loadSalesTable();
    loadShiftSummary();

    document.getElementById('previewBtn').addEventListener('click', async function () {
      try {
        setStatus('Mostrando subtotal + ISV en el reader...');
        const data = await post('/api/preview', payload());
        setStatus(data);
      } catch (err) {
        setStatus('Error: ' + err.message);
      }
    });

    document.getElementById('chargeBtn').addEventListener('click', async function () {
      try {
        setStatus('Iniciando cobro...');
        const data = await post('/api/charge', payload());
        setStatus(data);
        if (data && data.sale_record) {
          lastSale = data.sale_record;
        }
        await loadSalesTable();
        await loadShiftSummary();
      } catch (err) {
        setStatus('Error: ' + err.message);
        await loadSalesTable();
        await loadShiftSummary();
      }
    });

    document.getElementById('clearBtn').addEventListener('click', async function () {
      try {
        setStatus('Limpiando pantalla del reader...');
        const data = await post('/api/clear');
        setStatus(data);
      } catch (err) {
        setStatus('Error: ' + err.message);
      }
    });
  </script>
</body>
</html>`);
});

app.get('/api/config', requireAuth, (_req, res) => {
  return res.json({ config: getConfig() });
});

app.get('/api/sales', requireAuth, (_req, res) => {
  try {
    return res.json(getSalesData());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/shift-summary', requireAuth, (_req, res) => {
  try {
    return res.json({ summary: calculateShiftSummary() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/change-rate', requireAuth, requireAdmin, (req, res) => {
  try {
    const rate = Number(req.body.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: 'Invalid rate' });
    }
    const config = getConfig();
    config.usd_per_hnl = rate;
    saveConfig(config);
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/change-tax', requireAuth, requireAdmin, (req, res) => {
  try {
    const taxRatePct = Number(req.body.taxRatePct);
    if (!Number.isFinite(taxRatePct) || taxRatePct < 0) {
      return res.status(400).json({ error: 'Invalid tax' });
    }
    const config = getConfig();
    config.tax_rate = taxRatePct / 100;
    saveConfig(config);
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/close-shift', requireAuth, requireAdmin, (_req, res) => {
  try {
    const summary = calculateShiftSummary();
    const config = getConfig();
    config.current_shift_start = new Date().toISOString();
    saveConfig(config);
    return res.json({ ok: true, summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/preview', requireAuth, async (req, res) => {
  try {
    assertEnv();
    const config = getConfig();
    const description = String(req.body.description || '').trim();
    const hnlAmount = Number(req.body.hnlAmount);

    if (!description) {
      return res.status(400).json({ error: 'Description is required.' });
    }
    if (!Number.isFinite(hnlAmount) || hnlAmount <= 0) {
      return res.status(400).json({ error: 'HNL amount must be greater than 0.' });
    }

    try {
      await clearReaderDisplay();
    } catch (_) {
    }

    const totals = calculateTotals(hnlAmount, config.tax_rate);
    const reader = await setReaderDisplay({
      description,
      hnlAmount,
      taxRate: config.tax_rate,
    });

    return res.json({
      ok: true,
      message: 'Reader display updated.',
      reader_id: reader.id,
      action: reader.action,
      displayed_currency: 'hnl',
      subtotal_hnl: totals.subtotalHnl.toFixed(2),
      tax_hnl: totals.taxAmountHnl.toFixed(2),
      total_hnl: totals.totalHnl.toFixed(2),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/charge', requireAuth, async (req, res) => {
  assertEnv();

  const config = getConfig();
  const description = String(req.body.description || '').trim();
  const hnlAmount = Number(req.body.hnlAmount);

  if (!description) {
    return res.status(400).json({ error: 'Description is required.' });
  }
  if (!Number.isFinite(hnlAmount) || hnlAmount <= 0) {
    return res.status(400).json({ error: 'HNL amount must be greater than 0.' });
  }

  const receiptNumber = getNextReceiptNumber();
  let paymentIntent = null;
  let collectResult = null;
  let processResult = null;
  let finalPaymentIntent = null;
  let errorMessage = '';
  let flowError = null;

  const totals = calculateTotals(hnlAmount, config.tax_rate);
  const usdAmount = convertHnlToUsd(totals.totalHnl, config.usd_per_hnl);

  try {
    try {
      await clearReaderDisplay();
    } catch (_) {
    }

    const created = await createPaymentIntent({
      description,
      hnlAmount,
      receiptNumber,
      usdPerHnl: config.usd_per_hnl,
      taxRate: config.tax_rate,
    });

    paymentIntent = created.paymentIntent;

    collectResult = await collectPaymentMethodOnReader(paymentIntent.id);
    processResult = await processPaymentIntentOnReader(paymentIntent.id);
    finalPaymentIntent = await getFinalPaymentIntentWithRetry(paymentIntent.id);
  } catch (err) {
    flowError = err;
    errorMessage = err.message || 'Payment flow error';
    if (paymentIntent && paymentIntent.id) {
      try {
        finalPaymentIntent = await getFinalPaymentIntentWithRetry(paymentIntent.id);
      } catch (retrieveErr) {
        if (!errorMessage) {
          errorMessage = retrieveErr.message || 'Could not retrieve payment intent';
        }
      }
    }
  }

  const finalStatus = normalizeAttemptStatus(finalPaymentIntent, flowError);

  const saleRecord = {
    receiptNumber,
    createdAtISO: new Date().toISOString(),
    localDateTime: new Date().toLocaleString('es-HN'),
    description,
    currencyDisplayed: 'hnl',
    subtotalHnl: totals.subtotalHnl.toFixed(2),
    taxHnl: totals.taxAmountHnl.toFixed(2),
    totalHnl: totals.totalHnl.toFixed(2),
    taxRatePct: (config.tax_rate * 100).toFixed(2),
    chargedCurrency: 'usd',
    chargedUsd: usdAmount.toFixed(2),
    conversionRateUsdPerHnl: Number(config.usd_per_hnl).toFixed(4),
    paymentIntentId: paymentIntent ? paymentIntent.id : '',
    paymentIntentStatus: finalStatus,
    rawStripeStatus: finalPaymentIntent && finalPaymentIntent.status ? finalPaymentIntent.status : '',
    amountReceivedUsd:
      finalPaymentIntent && typeof finalPaymentIntent.amount_received === 'number'
        ? (finalPaymentIntent.amount_received / 100).toFixed(2)
        : '0.00',
    errorMessage,
  };

  saveSaleRecord(saleRecord);

  return res.json({
    ok: finalStatus === 'succeeded',
    message: finalStatus === 'succeeded' ? 'Payment flow completed on WisePOS E.' : 'Payment attempt saved.',
    receipt_number: receiptNumber,
    created_at: saleRecord.localDateTime,
    displayed_to_customer: {
      currency: 'hnl',
      subtotal: totals.subtotalHnl.toFixed(2),
      tax: totals.taxAmountHnl.toFixed(2),
      total: totals.totalHnl.toFixed(2),
    },
    actually_charged: {
      currency: 'usd',
      amount: usdAmount.toFixed(2),
    },
    payment_intent_id: paymentIntent ? paymentIntent.id : '',
    payment_intent_status: finalStatus,
    raw_stripe_status: saleRecord.rawStripeStatus,
    amount_received_usd: saleRecord.amountReceivedUsd,
    collect_action: collectResult ? collectResult.action : null,
    process_action: processResult ? processResult.action : null,
    error_message: errorMessage,
    sale_record: saleRecord,
  });
});

app.post('/api/clear', requireAuth, async (_req, res) => {
  try {
    assertEnv();
    const reader = await clearReaderDisplay();
    return res.json({
      ok: true,
      message: 'Reader action canceled / display cleared.',
      reader_id: reader.id,
      action: reader.action,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe HNL WisePOS E MVP running on http://localhost:${PORT}`);
});