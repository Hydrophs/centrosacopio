// Ejecutar UNA sola vez para migrar los centros existentes a Neon
// Uso: node seed.js
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function seed() {
  const centers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'centers.json'), 'utf8'));
  console.log(`Migrando ${centers.length} centros...`);

  // Crear tablas si no existen
  await pool.query(`
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
  `);

  // Limpiar e insertar
  await pool.query('TRUNCATE centers RESTART IDENTITY');
  for (const c of centers) {
    await pool.query(
      `INSERT INTO centers(id,pais,nombre,ciudad,direccion,acepta,contacto,web,horario,maps_link,lat,lng)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO NOTHING`,
      [c.id, c.pais, c.nombre, c.ciudad||'', c.direccion||'', c.acepta||'',
       c.contacto||'', c.web||null, c.horario||null, c.maps_link||null, c.lat||null, c.lng||null]
    );
  }

  console.log(`✅ ${centers.length} centros migrados correctamente.`);
  await pool.end();
}

seed().catch(e => { console.error('Error:', e.message); process.exit(1); });
