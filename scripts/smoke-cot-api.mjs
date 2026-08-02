// ==============================================================================
// OBJETIVO: Smoke de integración con la API web (catálogo vivo).
// Verifica auth + GET /api/v1/catalog + mapeo de carrito de ejemplo.
// NO crea cotizaciones reales. Uso: npm run test:cot-api
// ==============================================================================
import 'dotenv/config';
import { isCotApiConfigured, fetchCatalogViaApi } from '../src/logic/cot-api.js';
import {
  ensureCatalogIndex,
  mapEventCartToApiItems,
  mapDisposableCartToApiItems,
  resolveOfficialProductName,
  resolveComunaForApi
} from '../src/logic/cot-catalog.js';

let failed = 0;

/**
 * assert: Marca fallo si la condición es falsa.
 *
 * @param {boolean} cond
 * @param {string} label
 */
function assert(cond, label) {
  if (cond) {
    console.log(`  OK: ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

async function main() {
  console.log('\n=== Smoke COT API (catálogo) ===\n');

  if (!isCotApiConfigured()) {
    console.error('FAIL: faltan COT_API_BASE_URL o COT_API_KEY en .env');
    process.exit(1);
  }

  const cat = await fetchCatalogViaApi();
  assert(cat.success === true, `GET /api/v1/catalog responde OK`);
  if (!cat.success) {
    console.error(`  Error: ${cat.error}`);
    process.exit(1);
  }

  assert(Array.isArray(cat.products) && cat.products.length > 0, `products > 0 (tiene ${cat.products?.length || 0})`);
  assert(Array.isArray(cat.comunas) && cat.comunas.length > 0, `comunas > 0 (tiene ${cat.comunas?.length || 0})`);
  assert(Array.isArray(cat.eventTypes) && cat.eventTypes.length > 0, `eventTypes > 0 (tiene ${cat.eventTypes?.length || 0})`);

  const { productsByName, source } = await ensureCatalogIndex({ force: true });
  assert(source === 'api', `índice cargado desde API (source=${source})`);
  assert(productsByName.size > 0, `índice tiene ${productsByName.size} productos`);

  // Carrito de ejemplo: nombres cortos del bot → IDs/sizes de la web
  const cart = {
    a: { name: 'Mojito', litrage: '10L', quantity: 1 },
    b: { name: 'Aperol Spritz', litrage: '10L', quantity: 1 }
  };
  const mapped = await mapEventCartToApiItems(cart);
  assert(mapped.errors.length === 0, `mapeo sin errores (${mapped.errors.join('; ') || 'ok'})`);
  assert(mapped.items.length === 2, `mapeo devolvió 2 items (tiene ${mapped.items.length})`);
  assert(
    mapped.items.every((i) => i.productId && i.size === '10L' && i.quantity === 1),
    'items tienen productId + size 10L + quantity 1'
  );
  assert(
    resolveOfficialProductName('Mojito') === 'Mojito Tradicional',
    'alias Mojito → Mojito Tradicional'
  );

  const comunaOk = await resolveComunaForApi('Providencia');
  assert(comunaOk.matched === true && comunaOk.comuna === 'Providencia', 'comuna Providencia matchea catálogo');

  const comunaOtra = await resolveComunaForApi('La Serena');
  assert(
    comunaOtra.matched === false && comunaOtra.comuna === 'Otra' && comunaOtra.otherComuna === 'La Serena',
    'comuna desconocida → Otra + otherComuna'
  );

  // Carrito barriles desechables: { "Mojito": 2 } → size desechable del catálogo
  const disposableCart = { Mojito: 2 };
  const mappedDisp = await mapDisposableCartToApiItems(disposableCart);
  assert(mappedDisp.errors.length === 0, `mapeo desechable sin errores (${mappedDisp.errors.join('; ') || 'ok'})`);
  assert(mappedDisp.items.length === 1, `mapeo desechable devolvió 1 item (tiene ${mappedDisp.items.length})`);
  assert(
    mappedDisp.items[0]?.productId
      && mappedDisp.items[0]?.quantity === 2
      && /desechable/i.test(String(mappedDisp.items[0]?.size || '')),
    `item desechable tiene productId + qty 2 + size desechable (size=${mappedDisp.items[0]?.size})`
  );

  console.log('\n=== Resultado ===\n');
  if (failed > 0) {
    console.error(`SMOKE COT API FAILED (${failed} asserts)`);
    process.exit(1);
  }
  console.log('SMOKE COT API PASSED');
  console.log(`  productos=${cat.products.length} comunas=${cat.comunas.length} eventTypes=${cat.eventTypes.length}`);
}

main().catch((err) => {
  console.error('SMOKE COT API ERROR:', err);
  process.exit(1);
});
