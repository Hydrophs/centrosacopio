require('dotenv').config();
const express = require('express');
const { Pool }  = require('pg');
const crypto    = require('crypto');
const https     = require('https');
const path      = require('path');

const app = express();
const fs  = require('fs');
const DATA = path.join(__dirname, 'data');

// ── Storage: Postgres en prod, JSON local en dev ─────────────────
const USE_DB = process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes('user:password@host');

let db;
if (USE_DB) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  db = (sql, p) => pool.query(sql, p);
  pool.query(`
    CREATE TABLE IF NOT EXISTS centers (
      id SERIAL PRIMARY KEY, pais TEXT NOT NULL, nombre TEXT NOT NULL,
      ciudad TEXT DEFAULT '', direccion TEXT DEFAULT '', acepta TEXT DEFAULT '',
      contacto TEXT DEFAULT '', web TEXT, horario TEXT, maps_link TEXT,
      lat DOUBLE PRECISION, lng DOUBLE PRECISION
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id BIGINT PRIMARY KEY, pais TEXT, nombre TEXT, ciudad TEXT DEFAULT '',
      direccion TEXT DEFAULT '', acepta TEXT DEFAULT '', contacto TEXT DEFAULT '',
      fecha TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('DB init:', e.message));
  console.log('🗄  Modo: Postgres');
} else {
  // Fallback JSON para desarrollo local
  const readJ  = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const writeJ = (f, d) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(d, null, 2));
  db = async (sql, p) => {
    // Mini-ORM que mapea las queries usadas a operaciones JSON
    if (/SELECT \* FROM centers/.test(sql))     return { rows: readJ('centers.json') };
    if (/SELECT \* FROM submissions/.test(sql)) return { rows: readJ('submissions.json') };
    if (/SELECT MAX\(id\).*centers/.test(sql)) {
      const r = readJ('centers.json'); return { rows: [{ m: r.reduce((a,c)=>Math.max(a,c.id||0),0) }] };
    }
    if (/SELECT MAX\(id\).*submissions/.test(sql)) {
      const r = readJ('submissions.json'); return { rows: [{ m: r.reduce((a,c)=>Math.max(a,c.id||0),0) }] };
    }
    if (/SELECT \* FROM submissions WHERE id/.test(sql)) {
      return { rows: readJ('submissions.json').filter(s => s.id === p[0]) };
    }
    if (/INSERT INTO centers/.test(sql)) {
      const c = readJ('centers.json');
      const [id,pais,nombre,ciudad,direccion,acepta,contacto,web,horario,maps_link,lat,lng] = p;
      c.push({id,pais,nombre,ciudad,direccion,acepta,contacto,web,horario,maps_link,lat,lng});
      writeJ('centers.json', c); return { rows: [] };
    }
    if (/INSERT INTO submissions/.test(sql)) {
      const s = readJ('submissions.json');
      const [id,pais,nombre,ciudad,direccion,acepta,contacto] = p;
      s.push({id,pais,nombre,ciudad,direccion,acepta,contacto,fecha:new Date().toISOString()});
      writeJ('submissions.json', s); return { rows: [] };
    }
    if (/DELETE FROM centers/.test(sql)) {
      writeJ('centers.json', readJ('centers.json').filter(c => c.id !== p[0])); return { rows: [] };
    }
    if (/DELETE FROM submissions/.test(sql)) {
      writeJ('submissions.json', readJ('submissions.json').filter(s => s.id !== p[0])); return { rows: [] };
    }
    return { rows: [] };
  };
  console.log('📁 Modo: JSON local (configura DATABASE_URL para usar Postgres)');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Cookie auth (stateless — funciona en serverless) ─────────────
const COOKIE = '__auth';

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return out;
}

function makeToken() {
  const ts  = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(ts).digest('base64url');
  return `${ts}.${sig}`;
}

function validToken(req) {
  const val = parseCookies(req)[COOKIE];
  if (!val) return false;
  const [ts, sig] = val.split('.');
  if (!ts || !sig) return false;
  const exp = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(ts).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url'), b = Buffer.from(exp, 'base64url');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  } catch { return false; }
  return Date.now() - parseInt(ts, 36) < 8 * 3600 * 1000;
}

function checkPassword(input) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!input || !expected || input.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(input), Buffer.from(expected));
}

const auth = (req, res, next) => validToken(req) ? next() : res.redirect('/admin/login');
const COOKIE_OPTS = `; HttpOnly; SameSite=Strict; Max-Age=${8 * 3600}; Path=/`;

// ── Coord extraction ─────────────────────────────────────────────
function extractCoords(url) {
  if (!url) return { lat: null, lng: null };
  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
  const q  = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (q)  return { lat: parseFloat(q[1]),  lng: parseFloat(q[2]) };
  return { lat: null, lng: null };
}

async function coordsFromLink(url) {
  if (!url) return { lat: null, lng: null };
  if (/goo\.gl/.test(url)) {
    url = await new Promise(resolve => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r =>
        resolve(r.headers.location || url));
      req.on('error', () => resolve(url));
      req.setTimeout(4000, () => { req.destroy(); resolve(url); });
    });
  }
  return extractCoords(url);
}

// ── Public API ───────────────────────────────────────────────────

app.get('/api/centers', async (req, res) => {
  const { rows } = await db('SELECT * FROM centers ORDER BY id');
  res.json(rows);
});

app.post('/api/submit', async (req, res) => {
  const { pais, nombre, ciudad, direccion, acepta, contacto } = req.body;
  if (!pais || !nombre || !ciudad)
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  await db(
    'INSERT INTO submissions(id,pais,nombre,ciudad,direccion,acepta,contacto) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [Date.now(), pais.trim(), nombre.trim(), ciudad.trim(),
     (direccion||'').trim(), (acepta||'').trim(), (contacto||'').trim()]
  );
  res.json({ ok: true });
});

// ── Admin auth ───────────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  if (validToken(req)) return res.redirect('/admin');
  res.send(loginPage());
});

app.post('/admin/login', (req, res) => {
  if (checkPassword(req.body.password)) {
    res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}${COOKIE_OPTS}`);
    return res.redirect('/admin');
  }
  res.send(loginPage('Contraseña incorrecta'));
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/`);
  res.redirect('/admin/login');
});

// ── Admin panel ──────────────────────────────────────────────────

app.get('/admin', auth, (req, res) =>
  res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/admin/api/data', auth, async (req, res) => {
  const [s, c] = await Promise.all([
    db('SELECT * FROM submissions ORDER BY fecha DESC'),
    db('SELECT * FROM centers ORDER BY id')
  ]);
  res.json({ submissions: s.rows, centers: c.rows });
});

app.post('/admin/api/approve/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db('SELECT * FROM submissions WHERE id=$1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
  const s = rows[0];
  const { lat, lng } = await coordsFromLink(s.maps_link);
  const { rows: cs } = await db('SELECT MAX(id) as m FROM centers');
  const newId = (cs[0].m || 0) + 1;
  await db(
    'INSERT INTO centers(id,pais,nombre,ciudad,direccion,acepta,contacto,lat,lng) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [newId, s.pais, s.nombre, s.ciudad, s.direccion, s.acepta, s.contacto, lat, lng]
  );
  await db('DELETE FROM submissions WHERE id=$1', [id]);
  res.json({ ok: true });
});

app.post('/admin/api/reject/:id', auth, async (req, res) => {
  await db('DELETE FROM submissions WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/admin/api/center', auth, async (req, res) => {
  const { pais, nombre, ciudad, direccion, acepta, contacto, web, horario, maps_link } = req.body;
  if (!pais || !nombre || !ciudad)
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  const { lat, lng } = await coordsFromLink(maps_link);
  const { rows } = await db('SELECT MAX(id) as m FROM centers');
  const newId = (rows[0].m || 0) + 1;
  await db(
    `INSERT INTO centers(id,pais,nombre,ciudad,direccion,acepta,contacto,web,horario,maps_link,lat,lng)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [newId, pais.trim(), nombre.trim(), ciudad.trim(),
     (direccion||'').trim(), (acepta||'').trim(), (contacto||'').trim(),
     (web||'').trim()||null, (horario||'').trim()||null,
     (maps_link||'').trim()||null, lat, lng]
  );
  res.json({ ok: true });
});

app.delete('/admin/api/center/:id', auth, async (req, res) => {
  await db('DELETE FROM centers WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ Servidor en http://localhost:${PORT}`);
    console.log(`🔐 Admin en http://localhost:${PORT}/admin\n`);
  });
}

module.exports = app;

// ── Login page ───────────────────────────────────────────────────
function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Centros de Acopio</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f0f4f8;min-height:100vh;display:flex;align-items:center;justify-content:center}.box{background:#fff;border-radius:12px;padding:2.5rem 2rem;width:100%;max-width:380px;box-shadow:0 4px 20px rgba(0,0,0,.1)}.logo{text-align:center;margin-bottom:1.5rem}.logo h1{font-size:1.3rem;color:#002D6E;font-weight:800}.logo p{font-size:.82rem;color:#888;margin-top:.3rem}label{display:block;font-size:.82rem;font-weight:600;color:#444;margin-bottom:.4rem}input{width:100%;padding:.7rem .9rem;border:1.5px solid #ddd;border-radius:7px;font-size:.95rem;outline:none;transition:border .15s}input:focus{border-color:#002D6E}button{width:100%;margin-top:1.2rem;padding:.75rem;background:#002D6E;color:#fff;border:none;border-radius:7px;font-size:.95rem;font-weight:700;cursor:pointer}button:hover{background:#001f4d}.error{background:#fff0f0;color:#c00;border:1px solid #fcc;border-radius:6px;padding:.6rem .9rem;font-size:.83rem;margin-bottom:1rem}.back{text-align:center;margin-top:1rem;font-size:.8rem}.back a{color:#002D6E;text-decoration:none}</style>
</head><body><div class="box">
<div class="logo"><h1>Panel de Administración</h1><p>Centros de Acopio Venezuela</p></div>
${error ? `<div class="error">${error}</div>` : ''}
<form method="POST" action="/admin/login">
<label for="pw">Contraseña</label>
<input type="password" id="pw" name="password" autofocus placeholder="••••••••••••">
<button type="submit">Entrar</button>
</form>
<div class="back"><a href="/">← Volver al sitio</a></div>
</div></body></html>`;
}
