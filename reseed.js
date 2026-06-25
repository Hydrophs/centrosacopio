// Reemplaza TODOS los centros en Neon con el CSV nuevo.
// Uso: node reseed.js
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Fix mojibake: el CSV fue escrito como UTF-8 representando bytes Latin-1
// Cada char code ≤ 0xFF se trata como un byte del stream UTF-8 original
function fixEncoding(str) {
  const bytes = [];
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code <= 0xFF) bytes.push(code);
    // chars > 0xFF (ej. € de cp1252) se descartan — no aparecen en datos de dirección
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseCSV(str) {
  const rows = [];
  const lines = str.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let field = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { field += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { row.push(field); field = ''; }
      else field += ch;
    }
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function reseed() {
  const raw = fs.readFileSync('data/new_centers.csv', 'utf8');
  const fixed = fixEncoding(raw);
  const rows = parseCSV(fixed);
  const header = rows[0]; // id,Quién,Dirección,Coordenadas,Ciudad,País,Qué reciben,Contacto
  const data = rows.slice(1).filter(r => {
    const id = parseInt(r[0]);
    return !isNaN(id) && id > 0; // skip empty row and #REF!
  });

  console.log(`Procesando ${data.length} centros...`);

  await pool.query('TRUNCATE centers RESTART IDENTITY');

  for (const r of data) {
    const [id, quien, direccion, coords, ciudad, pais, acepta, contacto] = r.map(f => f.trim());
    let lat = null, lng = null;
    if (coords) {
      const parts = coords.split(',');
      lat = parseFloat(parts[0]) || null;
      lng = parseFloat(parts[1]) || null;
    }
    await pool.query(
      `INSERT INTO centers(id,pais,nombre,ciudad,direccion,acepta,contacto,lat,lng)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
      [parseInt(id), (pais||'Venezuela').trim(), quien.trim(),
       ciudad.trim(), direccion.trim(), (acepta||'').trim(),
       (contacto||'').trim(), lat, lng]
    );
  }

  console.log(`✅ ${data.length} centros insertados correctamente.`);
  await pool.end();
}

reseed().catch(e => { console.error('Error:', e.message); process.exit(1); });
