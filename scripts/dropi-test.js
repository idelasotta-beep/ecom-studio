#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Dropi integration validator — sin dependencias, Node 18+ (usa fetch nativo).
 *
 * Uso:
 *   set DROPI_TOKEN=tu-token-aqui
 *   set DROPI_COUNTRY=CL    (CO, MX, EC, CL, PE, PA, ES, PY, AR)
 *   node scripts/dropi-test.js                 → solo lecturas (warehouses + lista productos)
 *   node scripts/dropi-test.js --order         → ADEMÁS crea un pedido de prueba (BORRADOR)
 *
 * En PowerShell:
 *   $env:DROPI_TOKEN="tu-token-aqui"
 *   $env:DROPI_COUNTRY="CL"
 *   node scripts/dropi-test.js
 */

const TLD_BY_COUNTRY = {
  CO: 'co', PA: 'pa', MX: 'mx', EC: 'ec', CL: 'cl',
  PE: 'pe', ES: 'com.es', PY: 'com.py', AR: 'ar',
};

const token    = process.env.DROPI_TOKEN;
const country  = (process.env.DROPI_COUNTRY || '').toUpperCase();
const storeUrl = process.env.DROPI_STORE_URL || '';   // p.ej. https://mitiendadropi.lovable.app
const wantsOrder = process.argv.includes('--order');

if (!token)   { console.error('❌  Falta DROPI_TOKEN en el entorno.'); process.exit(1); }
if (!TLD_BY_COUNTRY[country]) {
  console.error(`❌  DROPI_COUNTRY inválido (${country}). Usá uno de: ${Object.keys(TLD_BY_COUNTRY).join(', ')}`);
  process.exit(1);
}

const BASE = `https://api.dropi.${TLD_BY_COUNTRY[country]}/integrations/`;
// Reproducimos el User-Agent que envía wp_remote_post desde WooCommerce.
// Dropi valida la integración usando el URL incluído acá (es lo que el plugin
// auto-rellena con el dominio del sitio WP).
const WP_VERSION = '6.4.2';
const HEADERS = {
  'Content-Type':          'application/json;charset=UTF-8',
  'dropi-integration-key': token,
  'User-Agent':            storeUrl ? `WordPress/${WP_VERSION}; ${storeUrl}` : `WordPress/${WP_VERSION}`,
  ...(storeUrl ? { 'Referer': storeUrl, 'Origin': storeUrl } : {}),
};

function line() { console.log('─'.repeat(70)); }

async function callDropi(method, path, body) {
  const url = BASE + path;
  console.log(`\n→ ${method} ${url}`);
  console.log('  headers:', { ...HEADERS, 'dropi-integration-key': '<token>' });
  if (body) console.log('  body:', JSON.stringify(body).slice(0, 200) + (JSON.stringify(body).length > 200 ? '…' : ''));
  const init = { method, headers: HEADERS };
  if (body) init.body = JSON.stringify(body);
  const t0 = Date.now();
  let res, text, json;
  try {
    res = await fetch(url, init);
    text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (err) {
    console.log(`  ✖ network error: ${err.message}`);
    return null;
  }
  const ms = Date.now() - t0;
  console.log(`  ← HTTP ${res.status} (${ms}ms)`);
  if (json) {
    const preview = JSON.stringify(json, null, 2);
    console.log('  response:', preview.length > 8000 ? preview.slice(0, 8000) + '\n  …(truncado)' : preview);
  } else {
    console.log('  response (raw, no JSON):', text.slice(0, 500));
  }
  return { status: res.status, json, raw: text };
}

(async () => {
  line();
  console.log(`Dropi API base: ${BASE}`);
  console.log(`Token (masked): ${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`);
  console.log(`Modo: ${wantsOrder ? 'lecturas + creación de PEDIDO DE PRUEBA (estado BORRADOR)' : 'solo lecturas'}`);
  line();

  // ── 1) GET /warehouses/ — read-only, sin efectos
  console.log('\n[1] Listando warehouses (validación básica de auth y red)…');
  const wh = await callDropi('GET', 'warehouses/');
  if (!wh) { console.log('\n✖ Falla de red. Revisá conexión o firewall.'); process.exit(2); }
  if (wh.status === 401 || wh.status === 403) {
    console.log('\n✖ Token rechazado por Dropi. Verificá DROPI_TOKEN y DROPI_COUNTRY.');
    process.exit(2);
  }
  if (wh.status >= 500) {
    console.log('\n⚠ Error 5xx del lado de Dropi — reintentá en un rato.');
    process.exit(2);
  }
  if (wh.json && wh.json.isSuccess === false) {
    console.log('\n⚠ Dropi devolvió isSuccess:false. Mensaje:', wh.json.message || wh.json);
  } else {
    console.log('  ✓ OK');
  }

  // ── 2) POST /products/index — listar productos del usuario en Dropi
  console.log('\n[2] Listando tus productos en Dropi (primera página)…');
  // Param correcto = pageSize (NO perPage). Confirmado por el error de la API.
  // Solo pageSize — Dropi pasa cualquier otro parámetro directo al WHERE (incluido `page`) y rompe SQL.
  let listRes = await callDropi('POST', 'products/index', { pageSize: 20 });
  let firstProduct = null;
  let allProducts = [];
  if (listRes && listRes.json && listRes.json.isSuccess !== false) {
    const objs = listRes.json.objects || listRes.json.data || listRes.json;
    allProducts = Array.isArray(objs) ? objs : (objs && objs.data) || (objs && objs.products) || [];
    firstProduct = Array.isArray(allProducts) && allProducts[0] ? allProducts[0] : null;
    if (allProducts.length) {
      console.log(`  ✓ Recibimos ${allProducts.length} productos.`);
      console.log('  Primeros 10 (ID — supplier — shipping_method — nombre):');
      for (const p of allProducts.slice(0, 10)) {
        console.log(`    #${p.id}  sup:${p.user?.id || '?'}  ship:${p.shipping_method || 'null'}  "${(p.name || '').slice(0, 50)}"`);
      }
    } else {
      console.log('  ⚠ No pudimos extraer productos del response.');
    }
  }

  // ── 3) Pedido de prueba (solo si se pidió con --order)
  if (!wantsOrder) {
    line();
    console.log('\n✓ Validación de LECTURAS completada.');
    console.log('  Si quisieras además crear un pedido de prueba (estado "PENDIENTE CONFIRMACION" / borrador,');
    console.log('  Dropi no lo enviará hasta que lo confirmes desde tu panel), corré:');
    console.log('  node scripts/dropi-test.js --order');
    line();
    return;
  }

  console.log('\n[3] Creando pedido de PRUEBA en estado BORRADOR…');
  if (!allProducts.length) {
    console.log('  ✖ No hay productos en el catálogo para probar.');
    return;
  }

  // Probamos secuencialmente con los primeros productos hasta que uno funcione.
  // (Algunos supplier no tienen transportadora asignada para tu ciudad — Dropi crashea en ese caso.)
  const MAX_TRY = Math.min(10, allProducts.length);
  console.log(`  Probaremos con hasta ${MAX_TRY} productos distintos hasta que uno funcione…`);

  let success = null;
  for (let i = 0; i < MAX_TRY; i++) {
    const p = allProducts[i];
    const supplierId = p.user_id || p.supplier_id || (p.user && p.user.id) || (p.supplier && p.supplier.id);
    // Dropi exige que el precio NO sea menor al 80% del suggested_price → usamos suggested_price tal cual.
    const productPrice = Number(p.suggested_price || p.sale_price || p.price || 0);
    const stockSample = Number(p.stock || 1);
    console.log(`\n  ── Intento ${i+1}/${MAX_TRY}: producto ${p.id} (supplier ${supplierId}) "${(p.name || '').slice(0, 40)}"`);

    const TEST_ORDER = {
      total_order: productPrice || 1,
      notes:       'PEDIDO DE PRUEBA — script de validación. Cancelar antes de confirmar.',
      name:        'PRUEBA',
      surname:     'No Enviar',
      dir:         'Calle de Prueba 123',
      country:     country,
      state:       country === 'CL' ? (process.env.DROPI_TEST_STATE || 'ANTOFAGASTA') : '',
      city:        country === 'CL' ? (process.env.DROPI_TEST_CITY  || 'ANTOFAGASTA') : '',
      phone:       '+56 9 0000 0000',
      client_email:'prueba@example.com',
      payment_method_id: 1,
      status:      'PENDIENTE CONFIRMACION',
      type:        'FINAL_ORDER',
      rate_type:   'CON RECAUDO',
      products: [{
        id: p.id,
        name: p.name || 'Producto Prueba',
        quantity: 1,
        stock: stockSample,
        price: productPrice || 1,
        token: token,
        variation_id: null,
        user_id: supplierId,
      }],
      calculate_costs_and_shiping: true,
      supplier_id: supplierId,
      shop_order_id: `test-${Date.now()}-${i}`,
      create_product_if_not_exist: false,
    };
    if (country === 'MX') TEST_ORDER.zip_code = '11001';

    const orderRes = await callDropi('POST', 'orders/myorders', TEST_ORDER);
    if (orderRes && orderRes.json && orderRes.json.isSuccess === true) {
      success = { res: orderRes, product: p };
      break;
    }
    const errMsg = (orderRes?.json?.message || orderRes?.json?.error || '').slice(0, 120);
    console.log(`    ✖ falló: ${errMsg}`);
  }

  line();
  if (success) {
    const newId = success.res.json.objects?.id || success.res.json.objects?.order_id;
    console.log(`\n🎉  ¡FUNCIONA! Pedido creado en Dropi con ID = ${newId}`);
    console.log(`   Producto usado: ${success.product.id} — "${success.product.name}"`);
    console.log(`   Estado: PENDIENTE CONFIRMACION (borrador). Andá a tu panel Dropi y CANCELÁLO para evitar envío.`);
  } else {
    console.log(`\n⚠ Ninguno de los ${MAX_TRY} productos pudo crear orden. Probable causa:`);
    console.log('   ningún supplier tiene transportadora configurada para tu ciudad,');
    console.log('   o falta algún campo del payload. Pegame el último response y ajustamos.');
  }
  line();
})();
