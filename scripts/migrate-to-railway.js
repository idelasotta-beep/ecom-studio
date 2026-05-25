/**
 * Sube la DB local (server/ecommagic.json) y las carpetas de media al
 * deployment de Railway via los endpoints /api/restore/*.
 *
 * Uso (PowerShell):
 *   $env:RAILWAY_URL   = "https://ecom-studio-production.up.railway.app"
 *   $env:ADMIN_EMAIL   = "admin@ecommagic.ai"
 *   $env:ADMIN_PASSWORD = "tu-password"
 *   node scripts/migrate-to-railway.js
 *
 * Opcionalmente:
 *   $env:FOLDERS = "ads,landings,mockups,logos"   (default — saltea ad-templates y meta-ads)
 *   $env:SKIP_DB = "1"                            (no resubir la DB, solo media)
 *   $env:SKIP_MEDIA = "1"                         (solo DB)
 *   $env:PATCH_ADMIN = "1"                        (reemplaza el password/email del admin id=1
 *                                                  con ADMIN_EMAIL/ADMIN_PASSWORD antes de subir)
 */
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const BASE     = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const EMAIL    = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const FOLDERS  = (process.env.FOLDERS || 'ads,landings,mockups,logos').split(',').map(s => s.trim()).filter(Boolean);
const SKIP_DB    = process.env.SKIP_DB === '1';
const SKIP_MEDIA = process.env.SKIP_MEDIA === '1';

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('Faltan variables: RAILWAY_URL, ADMIN_EMAIL, ADMIN_PASSWORD');
  process.exit(1);
}

const SERVER_DIR = path.join(__dirname, '..', 'server');
const DB_PATH    = path.join(SERVER_DIR, 'ecommagic.json');

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Login falló (${res.status}): ${txt}`);
  }
  const data = await res.json();
  if (data.user?.role !== 'admin') throw new Error('La cuenta no es admin');
  return data.token;
}

async function status(token) {
  const res = await fetch(`${BASE}/api/restore/status`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Status falló (${res.status}): ${await res.text()}`);
  return res.json();
}

async function uploadDb(token) {
  if (!fs.existsSync(DB_PATH)) { console.log('⚠️  No hay DB local en', DB_PATH); return; }
  let payload = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

  if (process.env.PATCH_ADMIN === '1') {
    const adminIdx = payload.users.findIndex(u => u.role === 'admin');
    if (adminIdx === -1) throw new Error('PATCH_ADMIN=1 pero no hay admin en la DB local');
    const hash = bcrypt.hashSync(PASSWORD, 10);
    const before = { email: payload.users[adminIdx].email };
    payload.users[adminIdx].email    = EMAIL.toLowerCase().trim();
    payload.users[adminIdx].password = hash;
    payload.users[adminIdx].updated_at = new Date().toISOString();
    console.log(`→ Patch admin: ${before.email} → ${EMAIL}`);
  }

  const body = JSON.stringify(payload);
  console.log(`→ Subiendo DB (${(body.length / 1024).toFixed(1)} KB)...`);
  const res = await fetch(`${BASE}/api/restore/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new Error(`DB upload falló (${res.status}): ${await res.text()}`);
  console.log('✅ DB subida:', await res.json());
}

async function uploadMedia(token, folder, existingFiles) {
  const dir = path.join(SERVER_DIR, folder);
  if (!fs.existsSync(dir)) { console.log(`⚠️  ${folder}/ no existe localmente, salteo`); return; }
  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
  if (files.length === 0) { console.log(`(${folder} vacío)`); return; }

  console.log(`\n→ Subiendo ${folder}/ (${files.length} archivos)...`);
  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (existingFiles.has(file)) { skip++; continue; }
    const buf = fs.readFileSync(path.join(dir, file));
    try {
      const res = await fetch(`${BASE}/api/restore/media/${folder}/${encodeURIComponent(file)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Authorization': `Bearer ${token}` },
        body: buf,
      });
      if (!res.ok) { fail++; console.log(`  ✗ ${file} (${res.status}) ${await res.text()}`); }
      else        { ok++; }
    } catch (err) {
      fail++; console.log(`  ✗ ${file} — ${err.message}`);
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`  [${i + 1}/${files.length}] `);
  }
  console.log(`\n  ${folder}: ${ok} subidos, ${skip} ya existían, ${fail} fallidos`);
}

(async () => {
  console.log('🔐 Login...');
  let token = await login();
  console.log('✅ Logueado como admin');

  console.log('\n📊 Estado actual del volumen Railway:');
  const before = await status(token);
  console.log(JSON.stringify(before, null, 2));

  if (!SKIP_DB) {
    await uploadDb(token);
    // Re-login después del DB replace: el admin de la DB recién subida puede
    // tener distinto password/email que el de seedAdmin, y el token anterior
    // se invalida implícitamente.
    console.log('\n🔐 Re-login tras DB upload...');
    token = await login();
  }

  if (!SKIP_MEDIA) {
    // Obtener lista actual del server por carpeta para saltear archivos ya subidos
    const existingByFolder = {};
    for (const folder of FOLDERS) {
      existingByFolder[folder] = new Set();
    }
    // re-fetch del status post-DB upload para reflejar lo último (pero status no lista archivos individuales,
    // así que asumimos que reintentamos todos; el server ya hace overwrite atómico igual)

    for (const folder of FOLDERS) {
      await uploadMedia(token, folder, existingByFolder[folder]);
    }
  }

  console.log('\n📊 Estado final del volumen Railway:');
  const after = await status(token);
  console.log(JSON.stringify(after, null, 2));
})().catch(err => {
  console.error('❌ Migración falló:', err.message);
  process.exit(1);
});
