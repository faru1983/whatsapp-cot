// ==============================================================================
// OBJETIVO: Verificación automática de flows (integridad + smoke de conversación).
// Uso: npm run test:flows   |   npm run verify
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { statesMap } from '../src/flows/index.js';
import { processMessage } from '../src/core/engine.js';
import { getSession, resetSession } from '../src/core/db.js';
import { ASSETS_DIR } from '../src/core/paths.js';
import { isImagePart } from '../src/logic/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ID = 'verify-flows@test.local';

const EXPECTED_STATES = [
  'ESPERANDO_INTENCION',
  'BARRILES_FILTRO_CANAL',
  'BARRILES_RECOGIDA_PRODUCTOS',
  'BARRILES_RECOGIDA_DATOS',
  'BARRILES_REVISION_COTIZACION',
  'BARRILES_ROUTER_MODIFICACION',
  'EVENTOS_RECOGIDA_DATOS',
  'EVENTOS_CONFIRMAR_DATOS',
  'EVENTOS_ELECCION_FORMATO',
  'EVENTOS_ELECCION_MENU',
  'EVENTOS_COTIZACION',
  'CERRADO'
];

const KNOWN_NEXT_STATES = new Set([
  ...EXPECTED_STATES,
  // aliases no usados pero por si acaso
]);

let failed = 0;

/**
 * assert: Falla el test si condition es falsa.
 * @param {boolean} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  } else {
    console.log(`  OK: ${message}`);
  }
}

/**
 * replyToText: Normaliza reply (string | array | img) a texto buscable.
 * @param {unknown} reply
 * @returns {string}
 */
function replyToText(reply) {
  if (reply == null) return '';
  if (typeof reply === 'string') return reply;
  if (Array.isArray(reply)) {
    return reply.map((p) => (isImagePart(p) ? `[IMG:${p.file}] ${p.caption || ''}` : String(p))).join('\n');
  }
  if (isImagePart(reply)) return `[IMG:${reply.file}] ${reply.caption || ''}`;
  return String(reply);
}

console.log('\n=== A. Integridad estática ===\n');

const keys = Object.keys(statesMap);
assert(keys.length === EXPECTED_STATES.length, `statesMap tiene ${EXPECTED_STATES.length} claves (tiene ${keys.length})`);
for (const id of EXPECTED_STATES) {
  assert(Boolean(statesMap[id]), `existe estado ${id}`);
  const st = statesMap[id];
  if (!st) continue;
  assert(typeof st.validateAndProcess === 'function', `${id}.validateAndProcess es función`);
  if (id !== 'CERRADO') {
    assert(st.shortQuestion != null && st.shortQuestion !== '', `${id} tiene shortQuestion`);
    assert(st.promptQuestion != null, `${id} tiene promptQuestion`);
  }
}

const assetPath = path.join(ASSETS_DIR, 'barril_desechable_precios.webp');
assert(fs.existsSync(assetPath), `existe asset barril_desechable_precios.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'dispensador_portatil_precios.webp')), `existe asset dispensador_portatil_precios.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'muro_de_cocteleria_precios.webp')), `existe asset muro_de_cocteleria_precios.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'dispensador_portatil.webp')), `existe asset dispensador_portatil.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'muro_de_cocteleria.webp')), `existe asset muro_de_cocteleria.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'eventos_formatos1.webp')), `existe asset eventos_formatos1.webp`);

// Helpers de *seguimos*: puro vs mezclado con pedido
const { isOnlyAdvanceProductsOrder, wantsAdvanceProductsOrder } = await import('../src/logic/interruptions.js');
assert(isOnlyAdvanceProductsOrder('seguimos'), `"seguimos" puro → isOnlyAdvance`);
assert(isOnlyAdvanceProductsOrder('listo'), `"listo" puro → isOnlyAdvance`);
assert(isOnlyAdvanceProductsOrder('ok'), `"ok" puro → isOnlyAdvance`);
assert(!isOnlyAdvanceProductsOrder('2 mojitos y 1 aperol seguimos'), `pedido+seguimos NO es only-advance`);
assert(wantsAdvanceProductsOrder('2 mojitos y 1 aperol seguimos'), `pedido+seguimos sí quiere avanzar`);
assert(wantsAdvanceProductsOrder('ok'), `"ok" sí quiere avanzar`);
assert(!isOnlyAdvanceProductsOrder('aka'), `"aka" no es advance`);

// Comunas: "no" NUNCA debe matchear Ñuñoa (substring "no" ⊂ "nunoa")
const { findLocationByFuzzyMatch, parseDate } = await import('../src/logic/utils.js');
assert(findLocationByFuzzyMatch('no') == null, `"no" no es comuna`);
assert(findLocationByFuzzyMatch('sos') == null, `"sos" no es comuna`);
assert(findLocationByFuzzyMatch('ñuñoa')?.name === 'Ñuñoa', `"ñuñoa" → Ñuñoa`);
assert(findLocationByFuzzyMatch('para el viernes en nunoa')?.name === 'Ñuñoa', `frase con ñuñoa`);
assert(findLocationByFuzzyMatch('Las Condes')?.name === 'Las Condes', `Las Condes exacto`);
assert(findLocationByFuzzyMatch('cumpleaños, proxima semana en la condes')?.name === 'Las Condes', `typo la condes en frase`);
assert(findLocationByFuzzyMatch('en la condes')?.name === 'Las Condes', `en la condes`);
assert(findLocationByFuzzyMatch('en las condes')?.name === 'Las Condes', `en las condes`);
assert(findLocationByFuzzyMatch('lascondes')?.name === 'Las Condes', `sin espacios`);
assert(findLocationByFuzzyMatch('en el bosque')?.name === 'El Bosque', `en el bosque`);
assert(findLocationByFuzzyMatch('stgo')?.name === 'Santiago', `alias stgo`);
assert(findLocationByFuzzyMatch('en provid')?.name === 'Providencia', `hint parcial provid`);
assert(findLocationByFuzzyMatch('boda de maria en providencia')?.name === 'Providencia', `no confundir de maria`);
assert(findLocationByFuzzyMatch('no') == null, `"no" sigue sin ser comuna`);

// Fechas: día+mes y solo mes (ej. "para diciembre" en cotización de evento)
assert(parseDate('15 de mayo') === '15 de mayo', `día+mes → 15 de mayo`);
assert(parseDate('quiero cotizar un matrimonio para diciembre') === 'para diciembre', `mes solo con para`);
assert(parseDate('en marzo 2027') === 'en marzo 2027', `mes + año`);
assert(parseDate('sin fecha acá') == null, `sin fecha → null`);

// Grep nextState en flows
const flowsRoot = path.join(__dirname, '../src/flows');
function walkJs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkJs(full, acc);
    else if (name.endsWith('.js')) acc.push(full);
  }
  return acc;
}
const nextStateRe = /nextState:\s*['"]([A-Z0-9_]+)['"]/g;
const foundNext = new Set();
for (const file of walkJs(flowsRoot)) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = nextStateRe.exec(src))) foundNext.add(m[1]);
}
for (const ns of foundNext) {
  assert(KNOWN_NEXT_STATES.has(ns), `nextState "${ns}" existe en statesMap`);
}

console.log('\n=== B. Simulación programática ===\n');

/**
 * runCase: Resetea sesión, envía mensajes, valida estado/mute/texto.
 */
async function runCase(name, steps) {
  console.log(`\n-- ${name} --`);
  resetSession(SESSION_ID);
  let lastReply = '';
  for (const step of steps) {
    lastReply = await processMessage(SESSION_ID, step.input);
    const session = getSession(SESSION_ID);
    const text = replyToText(lastReply);
    if (step.expectState) {
      assert(session.currentState === step.expectState, `estado=${step.expectState} (es ${session.currentState})`);
    }
    if (step.expectMuted === true) {
      assert(session.isMuted === true, 'sesión en mute');
    }
    if (step.expectMuted === false) {
      assert(!session.isMuted, 'sesión NO en mute');
    }
    if (step.expectIncludes) {
      const ok = step.expectIncludes.every((s) => text.toLowerCase().includes(String(s).toLowerCase()));
      assert(ok, `reply incluye ${JSON.stringify(step.expectIncludes)}`);
    }
    if (step.expectNotIncludes) {
      const bad = step.expectNotIncludes.some((s) => text.toLowerCase().includes(String(s).toLowerCase()));
      assert(!bad, `reply NO incluye ${JSON.stringify(step.expectNotIncludes)}`);
    }
  }
}

try {
  await runCase('Ruido router', [
    {
      input: 'holi',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['Barriles', 'Eventos']
    }
  ]);

  await runCase('CTA Instagram más información', [
    {
      input: '¡Hola! Quiero más información',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'Barriles Desechables', 'Servicio para Eventos']
    }
  ]);

  await runCase('CTA keyword más info', [
    {
      input: 'mas info',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['Barriles Desechables']
    }
  ]);

  await runCase('Precios sin producto', [
    {
      input: 'hola, me interesan los precios',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['Barriles Desechables']
    }
  ]);

  await runCase('Barriles + datos entrega', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'Providencia, para este sábado',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['sabor']
    }
  ]);

  await runCase('Seguimos con carrito vacío', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: 'Providencia, para el viernes', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'seguimos',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['aún no']
    }
  ]);

  await runCase('Mirón en filtro', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'lo tendré presente para agosto',
      expectState: 'CERRADO',
      expectMuted: true
    }
  ]);

  await runCase('Barriles parcial pide fecha', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'Las Condes',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['fecha']
    }
  ]);

  await runCase('Eventos keyword', [
    {
      input: 'evento',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Eventos']
    }
  ]);

  await runCase('Mirón en eventos (datos)', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'después',
      expectState: 'CERRADO',
      expectMuted: true
    }
  ]);
} catch (err) {
  failed += 1;
  console.error('  FAIL: excepción en simulación:', err);
}

console.log('\n=== Resultado ===\n');
if (failed > 0) {
  console.error(`VERIFY FAILED (${failed} assertion(s))`);
  process.exit(1);
}
console.log('VERIFY PASSED');
process.exit(0);
