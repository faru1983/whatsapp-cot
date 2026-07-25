// ==============================================================================
// OBJETIVO: Verificación automática de flows (integridad + smoke de conversación).
// Uso: npm run test:flows   |   npm run verify
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { statesMap } from '../src/flows/index.js';
import { processMessage } from '../src/core/engine.js';
import { getSession, resetSession, closeDb } from '../src/core/db.js';
import { ASSETS_DIR } from '../src/core/paths.js';
import { isImagePart, isVideoPart } from '../src/logic/media.js';

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
  'EVENTOS_INTRO_MENU',
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
 * replyToText: Normaliza reply (string | array | img | vid) a texto buscable.
 * @param {unknown} reply
 * @returns {string}
 */
function replyToText(reply) {
  if (reply == null) return '';
  if (typeof reply === 'string') return reply;
  if (Array.isArray(reply)) {
    return reply.map((p) => {
      if (isImagePart(p)) return `[IMG:${p.file}] ${p.caption || ''}`;
      if (isVideoPart(p)) return `[VID:${p.file}] ${p.caption || ''}`;
      return String(p);
    }).join('\n');
  }
  if (isImagePart(reply)) return `[IMG:${reply.file}] ${reply.caption || ''}`;
  if (isVideoPart(reply)) return `[VID:${reply.file}] ${reply.caption || ''}`;
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
assert(fs.existsSync(path.join(ASSETS_DIR, 'eventos_ambas.webp')), `existe asset eventos_ambas.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'eventos_dispensador1.webp')), `existe asset eventos_dispensador1.webp`);
assert(fs.existsSync(path.join(ASSETS_DIR, 'eventos_muro.mp4')), `existe asset eventos_muro.mp4`);

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
const { findLocationByFuzzyMatch, parseDate, isValidFreeformLocationCapture } = await import('../src/logic/utils.js');
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

assert(!isValidFreeformLocationCapture('lo que pueda ayudarte'), `"en lo que pueda ayudarte" no es comuna`);
assert(isValidFreeformLocationCapture('Talca'), `Talca libre sigue siendo válida`);
const { isLikelyThirdPartyBotReply } = await import('../src/logic/interruptions.js');
assert(isLikelyThirdPartyBotReply('No puedo ayudarte con eso. ¿Hay algo más en lo que pueda ayudarte?'), `detecta deflexión de otro bot`);
assert(isLikelyThirdPartyBotReply('Te atiende IA de Alonzo desde Viña del Mar'), `detecta bienvenida ajena`);

const {
  parseLitrageOnlyMessage,
  parseCocktailNamesWithoutLitrage,
  asksEventCartPriceQuestion,
  validateEventProductLines,
  getAllowedLitrages
} = await import('../src/logic/eventos-helpers.js');
const { preciosData: datosPrecios } = await import('../src/logic/utils.js');
const catalogNames = Object.keys(datosPrecios.cocteles || {});

assert(parseLitrageOnlyMessage('10L') === '10L', `10L solo → litraje`);
assert(parseLitrageOnlyMessage('30 litros') === '30L', `30 litros solo → litraje`);
assert(asksEventCartPriceQuestion('Y porque sale otro valor'), `pregunta discrepancia de precio`);
const monitoAperol = parseCocktailNamesWithoutLitrage('Monito aperol', catalogNames);
assert(monitoAperol.includes('Mojito') && monitoAperol.some((n) => /Aperol/i.test(n)), `Monito aperol → sabores del catálogo`);
const muroLitrages = getAllowedLitrages('muro');
const validated = validateEventProductLines(
  'Monito aperol',
  [{ name: 'Mojito', quantity: 1, litrage: '10L' }, { name: 'Aperol Spritz', quantity: 1, litrage: '10L' }],
  'muro',
  muroLitrages,
  '10L',
  catalogNames
);
assert(validated.parsedProducts.length === 2, `Mojito+Aperol 10L válidos en muro`);

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
      assert(ok, `reply incluye ${JSON.stringify(step.expectIncludes)}${!ok ? ` | Actual: ${JSON.stringify(text)}` : ''}`);
    }
    if (step.expectNotIncludes) {
      const bad = step.expectNotIncludes.some((s) => text.toLowerCase().includes(String(s).toLowerCase()));
      assert(!bad, `reply NO incluye ${JSON.stringify(step.expectNotIncludes)}`);
    }
  }
}

try {
  await runCase('Ruido router sin repetir menú', [
    {
      input: 'hola',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'Barriles Desechables']
    }
  ]);

  // Cuenta cuántas veces aparece la pregunta del menú (debe ser 1, no 2+)
  resetSession(SESSION_ID);
  const holaReply = await processMessage(SESSION_ID, 'hola');
  const holaText = replyToText(holaReply);
  const menuMatches = (holaText.match(/barriles desechables/gi) || []).length;
  assert(menuMatches <= 2, `saludo "hola" no repite menú (${menuMatches} menciones de Barriles Desechables)`);
  const assistantMentions = (holaText.match(/asistente virtual/gi) || []).length;
  assert(assistantMentions === 1, `saludo "hola" menciona asistente virtual una sola vez (tiene ${assistantMentions})`);

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

  await runCase('CTA Meta con producto eventos en la frase', [
    {
      input: '¡Hola! Quiero más información sobre el Servicio para Eventos',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Eventos', 'invitados']
    }
  ]);

  await runCase('CTA Meta con barriles desechables en la frase', [
    {
      input: 'Hola, quiero más info sobre los barriles desechables',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false
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

  await runCase('Barriles keyword barriles solo', [
    {
      input: 'barriles',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false
    }
  ]);

  await runCase('Mirón en router', [
    {
      input: 'solo estoy mirando',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['Cuando quieras cotizar']
    }
  ]);

  await runCase('Después te confirmo no es mirón en filtro', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'después te confirmo la comuna',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['comuna', 'cuándo']
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

  await runCase('Eventos cumpleaños con invitados sin confundir edad', [
    { input: 'Servicio para Eventos', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'Cumpleaños 25 invitados Peñalolen',
      expectState: 'EVENTOS_CONFIRMAR_DATOS',
      expectMuted: false,
      expectIncludes: ['25', 'Peñalolén', 'Cumpleaños'],
      expectNotIncludes: ['25 años', 'cuántos invitados']
    }
  ]);

  // Confirmación de datos → foto única con caption de recomendación + pregunta de formato
  await runCase('Eventos confirmación → formato (img+caption)', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'cumpleaños para 50 invitados en Providencia el 15 de mayo',
      expectState: 'EVENTOS_CONFIRMAR_DATOS',
      expectMuted: false,
      expectIncludes: ['50', 'Providencia']
    },
    {
      input: 'ok',
      expectState: 'EVENTOS_ELECCION_FORMATO',
      expectMuted: false,
      expectIncludes: [
        '[IMG:eventos_ambas.webp]',
        'Dispensador Portátil',
        'Muro de Coctelería',
        'Dispensador',
        'Muro'
      ]
    }
  ]);

  // "ambos" / "las 2" en elección de formato → respuesta fija, sin forzar opción ni fallback genérico
  await runCase('Eventos formato ambos → explicación', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'cumpleaños para 50 invitados en Providencia el 15 de mayo',
      expectState: 'EVENTOS_CONFIRMAR_DATOS'
    },
    { input: 'ok', expectState: 'EVENTOS_ELECCION_FORMATO' },
    {
      input: 'ambos',
      expectState: 'EVENTOS_ELECCION_FORMATO',
      expectMuted: false,
      expectIncludes: ['uno', 'HUMANO', 'Dispensador', 'Muro'],
      expectNotIncludes: ['no estoy seguro', 'Quieres seguir con']
    }
  ]);

  await runCase('Eventos formato las 2 → explicación', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'cumpleaños para 80 invitados en Las Condes el 20 de junio',
      expectState: 'EVENTOS_CONFIRMAR_DATOS'
    },
    { input: 'ok', expectState: 'EVENTOS_ELECCION_FORMATO' },
    {
      input: 'las 2',
      expectState: 'EVENTOS_ELECCION_FORMATO',
      expectMuted: false,
      expectIncludes: ['uno', 'HUMANO', 'Dispensador', 'Muro'],
      expectNotIncludes: ['no estoy seguro']
    }
  ]);

  // Pitch → intro → carta + litros≈cócteles → menú
  await runCase('Eventos formato → intro → menú (carta+rendimiento)', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'cumpleaños para 50 invitados en Providencia el 15 de mayo',
      expectState: 'EVENTOS_CONFIRMAR_DATOS'
    },
    { input: 'ok', expectState: 'EVENTOS_ELECCION_FORMATO' },
    {
      input: '1',
      expectState: 'EVENTOS_INTRO_MENU',
      expectMuted: false,
      expectIncludes: ['Excelente elección', 'cócteles', 'precios', '[IMG:eventos_dispensador1.webp]'],
      expectNotIncludes: ['[IMG:dispensador_portatil_precios.webp]']
    },
    {
      input: 'ok',
      expectState: 'EVENTOS_ELECCION_MENU',
      expectMuted: false,
      expectIncludes: [
        '[IMG:dispensador_portatil_precios.webp]',
        '30L',
        '~150',
        'Rendimiento',
        '5L ≈ 25',
        'Mojito'
      ]
    }
  ]);

  // Muro: pitch como caption del video
  await runCase('Eventos formato muro → video pitch', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'matrimonio para 120 invitados en Providencia el 10 de agosto',
      expectState: 'EVENTOS_CONFIRMAR_DATOS'
    },
    { input: 'ok', expectState: 'EVENTOS_ELECCION_FORMATO' },
    {
      input: '2',
      expectState: 'EVENTOS_INTRO_MENU',
      expectMuted: false,
      expectIncludes: ['[VID:eventos_muro.mp4]', 'Muro de Coctelería', 'cócteles', 'precios']
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

  await runCase('Handoff global por frase', [
    {
      input: 'quiero hablar con un humano',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['comunico con alguien del equipo']
    }
  ]);

  await runCase('Handoff global por rol suelto - humano', [
    {
      input: 'humano',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['comunico con alguien del equipo']
    }
  ]);

  await runCase('Handoff global por rol suelto', [
    {
      input: 'asesor',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['comunico con alguien del equipo']
    }
  ]);

  await runCase('Evitar falso positivo "personas" o "contacto"', [
    {
      input: 'Hola, cotizar evento para 50 personas, mi contacto es de las condes',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false
    }
  ]);

  await runCase('Pregunta de cobertura con comuna externa sin extraccion', [
    {
      input: 'evento',
      expectState: 'EVENTOS_RECOGIDA_DATOS'
    },
    {
      input: 'van a la serena?',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Metropolitana', 'Serena']
    }
  ]);

  await runCase('Duda dispensador vs solo barriles en eventos (sin leak IA)', [
    {
      input: 'Servicio para Eventos',
      expectState: 'EVENTOS_RECOGIDA_DATOS'
    },
    {
      input: 'solo o dispensador',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Dispensador Portátil', 'Barriles Desechables', 'invitados'],
      expectNotIncludes: ['No puedo determinar', 'el cliente está preguntando', 'proporcionar más contexto']
    }
  ]);

  await runCase('Anti-loop conversacional con 2 strikes', [
    {
      input: 'calentamiento global',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'no estoy seguro']
    },
    {
      input: 'segunda pregunta off topic',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['paso con alguien del equipo']
    }
  ]);

  console.log('\n-- Eventos menú muro monito aperol y duda de precio --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Muro de Coctelería';
    session.guests = 100;
    session.orderBuilder = { type: 'muro', products: {}, extras: {} };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('Monito aperol', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(t1.includes('Mojito') && /Aperol/i.test(t1), `Monito aperol agrega ambos cócteles`);
    assert(!t1.includes('no está disponible'), `Monito aperol no error de litraje`);

    const r2 = await st.validateAndProcess('Y porque sale otro valor', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(t2.includes('Tu pedido actual'), `duda de precio explica carrito`);
    assert(!t2.includes('litraje no está disponible'), `duda de precio no error de litraje`);
  }

  console.log('\n-- Eventos bot ajeno no extrae comuna falsa --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_RECOGIDA_DATOS';
    session.userIntent = 'EVENTOS';
    const st = statesMap.EVENTOS_RECOGIDA_DATOS;
    await st.validateAndProcess('Servicio para Eventos', session);
    const r = await st.validateAndProcess(
      'No puedo ayudarte con eso. ¿Hay algo más en lo que pueda ayudarte?',
      session
    );
    const t = typeof r.customReply === 'string' ? r.customReply : '';
    assert(!session.location, `no guarda comuna falsa`);
    assert(t.includes('no trae datos'), `re-pregunta datos del evento`);
    assert(!t.includes('lo que pueda'), `no menciona comuna inventada`);
  }

  await runCase('Anti-loop eventos handoff hablado', [
    {
      input: 'eventos',
      expectState: 'EVENTOS_RECOGIDA_DATOS'
    },
    {
      input: 'Mi gustar',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['no estoy seguro', 'invitados']
    },
    {
      input: 'se pueden comprar?',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['paso con alguien del equipo'],
      expectNotIncludes: ['cotizar y comprar', 'vendemos los dispensadores']
    }
  ]);
} catch (err) {
  failed += 1;
  console.error('  FAIL: excepción en simulación:', err);
}

console.log('\n=== Resultado ===\n');
if (failed > 0) {
  console.error(`VERIFY FAILED (${failed} assertion(s))`);
  try { closeDb(); } catch (_) {}
  process.exit(1);
}
console.log('VERIFY PASSED');
try { closeDb(); } catch (_) {}
process.exit(0);

