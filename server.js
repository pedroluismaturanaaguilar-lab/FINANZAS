'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { load, save } = require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_COOKIE = 'cos_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 días

function requireAuth(req, res, next) {
  const data = load();
  const token = req.cookies[SESSION_COOKIE];
  const session = token && data.sessions[token];
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}

// Limpia sesiones vencidas de vez en cuando
function cleanupSessions(data) {
  const now = Date.now();
  let changed = false;
  for (const token of Object.keys(data.sessions)) {
    if (data.sessions[token].expires < now) {
      delete data.sessions[token];
      changed = true;
    }
  }
  return changed;
}

// ============================ AUTENTICACIÓN ============================
app.post('/api/login', (req, res) => {
  const data = load();
  if (cleanupSessions(data)) save();
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  }
  const okUser = username.trim().toUpperCase() === data.auth.username.toUpperCase();
  const okPass = okUser && bcrypt.compareSync(password, data.auth.passwordHash);
  if (!okUser || !okPass) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  data.sessions[token] = { user: data.auth.username, expires: Date.now() + SESSION_TTL_MS };
  save();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true, user: data.auth.username });
});

app.post('/api/logout', (req, res) => {
  const data = load();
  const token = req.cookies[SESSION_COOKIE];
  if (token && data.sessions[token]) {
    delete data.sessions[token];
    save();
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const data = load();
  const token = req.cookies[SESSION_COOKIE];
  const session = token && data.sessions[token];
  if (!session || session.expires < Date.now()) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: session.user });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const data = load();
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Complete la contraseña actual y la nueva' });
  }
  if (!bcrypt.compareSync(oldPassword, data.auth.passwordHash)) {
    return res.status(401).json({ error: 'La contraseña actual no es correcta' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  }
  data.auth.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  save();
  res.json({ ok: true });
});

// ============================ DATOS DE LA APP ============================
// Colecciones que el cliente sincroniza completas (reemplazo total al guardar)
const COLLECTIONS = [
  'workers', 'attendance', 'payrolls', 'settlements',
  'holidays', 'config', 'wageHistory', 'pendingOvertime',
];

app.get('/api/state', requireAuth, (req, res) => {
  const data = load();
  const out = {};
  COLLECTIONS.forEach((k) => { out[k] = data[k]; });
  res.json(out);
});

app.put('/api/collection/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!COLLECTIONS.includes(name)) {
    return res.status(404).json({ error: 'Colección no encontrada' });
  }
  if (req.body === undefined) {
    return res.status(400).json({ error: 'Cuerpo de la petición vacío' });
  }
  const data = load();
  data[name] = req.body;
  save();
  res.json({ ok: true });
});

// Healthcheck simple para Render
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Cualquier otra ruta no encontrada -> login (evita pantallas en blanco)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
load(); // inicializa la base de datos (crea admin y datos por defecto la primera vez)
app.listen(PORT, () => {
  console.log('🛡️  GUARDIAN FAMILIAR COS escuchando en el puerto ' + PORT);
});
