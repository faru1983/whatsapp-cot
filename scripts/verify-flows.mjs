// ==============================================================================
// OBJETIVO: Verificación automática de flows (integridad + smoke de conversación).
// Uso: npm run test:flows   |   npm run verify
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { statesMap } from '../src/flows/index.js';
import { processMessage } from '../src/core/engine.js';
import { getSession, resetSession, closeDb, saveSession } from '../src/core/db.js';
import { ASSETS_DIR } from '../src/core/paths.js';
import { isImagePart, isVideoPart } from '../src/logic/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ID = 'verify-flows@test.local';

// Evita que el smoke de flows cree cotizaciones reales en la API de producción.
// La integración HTTP se prueba aparte con: npm run test:cot-api
const _savedCotApiKey = process.env.COT_API_KEY;
const _savedCotApiBase = process.env.COT_API_BASE_URL;
delete process.env.COT_API_KEY;
delete process.env.COT_API_BASE_URL;

const EXPECTED_STATES = [
  'ESPERANDO_INTENCION',
  'BARRILES_FILTRO_CANAL',
  'BARRILES_RECOGIDA_PRODUCTOS',
  'BARRILES_RECOGIDA_DATOS',
  'BARRILES_REVISION_COTIZACION',
  'BARRILES_ROUTER_MODIFICACION',
  'BARRILES_DATOS_CONTACTO',
  'BARRILES_CONFIRMAR_COMPRA',
  'EVENTOS_RECOGIDA_DATOS',
  'EVENTOS_CONFIRMAR_DATOS',
  'EVENTOS_ELECCION_FORMATO',
  'EVENTOS_INTRO_MENU',
  'EVENTOS_ELECCION_MENU',
  'EVENTOS_COTIZACION',
  'EVENTOS_DATOS_CONTACTO',
  'EVENTOS_CONFIRMAR_ENVIO',
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

// hasDrinkSelection: fechas con día NO deben parecer pedido de cócteles
{
  const { hasDrinkSelection } = await import('../src/logic/utils.js');
  assert(!hasDrinkSelection('Providencia, 5 de agosto'), `"Providencia, 5 de agosto" no es pedido de cócteles`);
  assert(!hasDrinkSelection('Las Condes, 15 de mayo'), `fecha+comuna no es pedido de cócteles`);
  assert(hasDrinkSelection('2 mojitos y 1 sangría'), `sí detecta pedido de cócteles`);
  assert(hasDrinkSelection('1 aperol'), `sí detecta aperol`);
}

// Fechas: día+mes (con/sin "de"), solo mes, y conversión ISO para la API
const { toIsoDateFromBotText } = await import('../src/logic/cot-event-quote.js');
assert(parseDate('15 de mayo') === '15 de mayo', `día+mes → 15 de mayo`);
assert(parseDate('15 diciembre') === '15 diciembre', `día+mes sin "de" → 15 diciembre`);
assert(parseDate('el 3 diciembre 2027') === 'el 3 diciembre 2027', `día+mes+año sin "de"`);
assert(parseDate('quiero cotizar un matrimonio para diciembre') === 'para diciembre', `mes solo con para`);
assert(parseDate('en marzo 2027') === 'en marzo 2027', `mes + año`);
assert(parseDate('sin fecha acá') == null, `sin fecha → null`);
assert(toIsoDateFromBotText('15 de mayo') != null, `ISO: 15 de mayo`);
assert(toIsoDateFromBotText('15 diciembre') != null, `ISO: 15 diciembre (sin "de")`);
assert(toIsoDateFromBotText('15/12') != null, `ISO: 15/12`);
assert(toIsoDateFromBotText('diciembre') == null, `ISO: solo mes → null`);
assert(toIsoDateFromBotText('15 diciembre 2027') === '2027-12-15', `ISO: año explícito`);
assert(toIsoDateFromBotText('mañana') != null, `ISO: mañana relativa`);
assert(toIsoDateFromBotText('este sábado') != null, `ISO: este sábado relativa`);
{
  const { normalizeBotDateText, exampleConcreteDateHint } = await import('../src/logic/cot-event-quote.js');
  const norm = normalizeBotDateText('este sábado');
  assert(/\d{1,2}\s+de\s+\w+/i.test(String(norm)), `normaliza este sábado → día de mes (es ${norm})`);
  assert(/\d{1,2}\s+de\s+\w+/i.test(exampleConcreteDateHint()), `ejemplo concreto de entrega`);
}
// Sin año: usa año Chile actual; si ya pasó → próximo. Diciembre desde agosto → mismo año.
{
  const iso = toIsoDateFromBotText('15 diciembre');
  assert(/^\d{4}-12-15$/.test(String(iso)), `ISO: 15 diciembre → día 15 mes 12 (es ${iso})`);
  const year = Number(String(iso).slice(0, 4));
  const now = new Date();
  const chileYear = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric' }).format(now)
  );
  // Agosto–nov: diciembre aún no pasó → año actual. Enero–julio (después del 15): año siguiente.
  // Aquí solo verificamos que el año sea actual o próximo (no inventa años lejanos).
  assert(year === chileYear || year === chileYear + 1, `ISO sin año: año Chile actual o próximo (es ${year})`);
}

assert(!isValidFreeformLocationCapture('lo que pueda ayudarte'), `"en lo que pueda ayudarte" no es comuna`);
assert(!isValidFreeformLocationCapture('diciembre'), `"en diciembre" no es comuna`);
assert(!isValidFreeformLocationCapture('marzo 2027'), `"en marzo 2027" no es comuna`);
assert(!isValidFreeformLocationCapture('lunes'), `"en lunes" no es comuna`);
assert(!isValidFreeformLocationCapture('la tarde'), `"en la tarde" no es comuna`);
assert(isValidFreeformLocationCapture('Talca'), `Talca libre sigue siendo válida`);

// Familia fecha≠comuna: meses, días y orden mes+comuna
{
  const { applyEventDataFromMessage, extractGuestsFromMessage } = await import('../src/logic/eventos-helpers.js');
  const { applyContactFromMessage, splitStreetAndComuna } = await import('../src/logic/cot-contact.js');
  assert(extractGuestsFromMessage('15 diciembre') == null, `fecha "15 diciembre" ≠ invitados`);
  assert(extractGuestsFromMessage('15 de diciembre') == null, `fecha "15 de diciembre" ≠ invitados`);
  assert(extractGuestsFromMessage('50 invitados') === 50, `explícito 50 invitados`);

  // Dirección con comuna pegada (patrón cliente)
  const splitProv = splitStreetAndComuna('Los Alerces 123, Depto 456, Providencia');
  assert(/Los Alerces 123/i.test(splitProv.street), `split: conserva calle`);
  assert(!/Providencia/i.test(splitProv.street), `split: saca Providencia de la calle`);
  assert(splitProv.comuna?.name === 'Providencia', `split: detecta comuna Providencia`);
  const splitKnown = splitStreetAndComuna('Los Alerces 123 Providencia', 'Providencia');
  assert(!/Providencia/i.test(splitKnown.street), `split: comuna conocida sin coma`);
  const splitChange = splitStreetAndComuna('Los Alerces 123, Las Condes', 'Providencia');
  assert(splitChange.comuna?.name === 'Las Condes', `split: comuna distinta corrige a Las Condes`);
  assert(!/Las Condes/i.test(splitChange.street), `split: no deja Las Condes en la calle`);
  const splitPlain = splitStreetAndComuna('Los Alerces 123, Depto 456');
  assert(/Depto 456/i.test(splitPlain.street) && !splitPlain.comuna, `split: sin comuna deja dirección intacta`);

  // Fecha no pisa invitados ya guardados
  {
    const sess = { guests: 50 };
    applyEventDataFromMessage('15 de diciembre', sess);
    assert(sess.guests === 50, `applyEvent: fecha no pisa guests 50`);
    assert(/diciembre/i.test(String(sess.date || '')), `applyEvent: sí guarda fecha`);
  }
  // Fecha no pisa nombre ya guardado
  {
    const sess = {
      contact: { firstName: 'Felipe', lastName: 'Ramirez', email: 'f@test.cl' }
    };
    applyContactFromMessage('15 de diciembre', sess);
    assert(sess.contact.firstName === 'Felipe', `contacto: fecha no pisa nombre`);
    assert(sess.contact.lastName === 'Ramirez', `contacto: fecha no pisa apellido`);
  }

  const cases = [
    { msg: '50 invitados en diciembre', guests: 50, dateRe: /diciembre/i, loc: null },
    { msg: '50 invitados en lunes', guests: 50, dateRe: /lunes/i, loc: null },
    { msg: 'en diciembre en Providencia', guests: null, dateRe: /diciembre/i, loc: 'Providencia' },
    { msg: 'cumpleaños en septiembre en Las Condes', guests: null, dateRe: /septiembre/i, loc: 'Las Condes' }
  ];
  for (const c of cases) {
    const sess = {};
    applyEventDataFromMessage(c.msg, sess);
    if (c.guests != null) assert(sess.guests === c.guests, `${c.msg} → guests`);
    assert(c.dateRe.test(String(sess.date || '')), `${c.msg} → fecha`);
    assert(
      c.loc ? sess.location === c.loc : !sess.location,
      `${c.msg} → comuna=${c.loc || 'ninguna'} (es ${sess.location || 'null'})`
    );
  }
}

const { isLikelyThirdPartyBotReply } = await import('../src/logic/interruptions.js');
assert(isLikelyThirdPartyBotReply('No puedo ayudarte con eso. ¿Hay algo más en lo que pueda ayudarte?'), `detecta deflexión de otro bot`);
assert(isLikelyThirdPartyBotReply('Te atiende IA de Alonzo desde Viña del Mar'), `detecta bienvenida ajena`);

const {
  parseLitrageOnlyMessage,
  parseCocktailNamesWithoutLitrage,
  parseEventProductsProgrammatic,
  asksEventCartPriceQuestion,
  validateEventProductLines,
  getAllowedLitrages,
  ASK_EVENT_COCKTAILS,
  EVENT_COCKTAIL_ORDER_EXAMPLE
} = await import('../src/logic/eventos-helpers.js');
const {
  preciosData: datosPrecios,
  interceptBotOptionsAnswer,
  partitionLitersIntoBarrels,
  fixEventLitrageShorthand
} = await import('../src/logic/utils.js');
const catalogNames = Object.keys(datosPrecios.cocteles || {});

// El resumen del carrito no es un menú: si lo fuera, cualquier respuesta sumaría ese mismo cóctel
const cartBubble = '🍹 Te confirmo los cócteles seleccionados:\n\n- 1x Mojito (5L): $69.990\n';
assert(interceptBotOptionsAnswer('5 sangria', cartBubble) === null, `líneas de carrito no se interceptan como opciones`);
const dudaBubble = '¿Cuál de estas opciones prefieres?\n- Piscola Alto\n- Piscola Mitad\n';
assert(
  interceptBotOptionsAnswer('mitad', dudaBubble)?.name === 'Piscola Mitad',
  `sigue interceptando la elección entre opciones reales`
);

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

// Parser eventos: litros por cóctel (no reutilizar el primer litraje en todos)
assert(
  ASK_EVENT_COCKTAILS.includes(EVENT_COCKTAIL_ORDER_EXAMPLE)
    && /^5L\s/i.test(EVENT_COCKTAIL_ORDER_EXAMPLE),
  `pregunta de cócteles orienta litros primero`
);
const dispLitrages = getAllowedLitrages('dispensador');
const multiLitros = parseEventProductsProgrammatic(
  '5L Mojito y 15L Sangria',
  catalogNames,
  dispLitrages,
  '5L'
);
assert(multiLitros.length === 2, `5L Mojito y 15L Sangria → 2 líneas programáticas`);
assert(
  multiLitros.some((p) => p.name === 'Mojito' && p.litrage === '5L'),
  `Mojito conserva 5L propio`
);
assert(
  multiLitros.some((p) => /Sangr/i.test(p.name) && p.litrage === '15L'),
  `Sangría conserva 15L propio (no hereda el 5L)`
);
const multiValidated = validateEventProductLines(
  '5L Mojito y 15L Sangria',
  multiLitros,
  'dispensador',
  dispLitrages,
  '5L',
  catalogNames
);
assert(multiValidated.invalidLitrages.length === 0, `15L se parte en barriles válidos`);
assert(
  multiValidated.parsedProducts.some((p) => p.name === 'Mojito' && p.litrage === '5L' && p.quantity === 1),
  `Mojito 5L en carrito final`
);
assert(
  multiValidated.parsedProducts.some((p) => /Sangr/i.test(p.name) && p.litrage === '10L'),
  `15L Sangría → incluye barril 10L`
);
assert(
  multiValidated.parsedProducts.some((p) => /Sangr/i.test(p.name) && p.litrage === '5L'),
  `15L Sangría → incluye barril 5L`
);
assert(
  partitionLitersIntoBarrels(15, ['5L', '10L'])?.length === 2,
  `partición genérica 15L → 10+5`
);
assert(
  fixEventLitrageShorthand('15L Sangria', { name: 'Sangría', quantity: 1, litrage: '15L' }, dispLitrages, '5L')
    .some((p) => p.litrage === '10L'),
  `fix 15L → al menos un 10L`
);
const sinLitros = parseEventProductsProgrammatic('un mojito', catalogNames, dispLitrages, '5L');
assert(
  sinLitros.length === 1 && sinLitros[0].name === 'Mojito' && sinLitros[0].litrage === '5L',
  `sin litros → default 5L`
);
const ordenInvertido = parseEventProductsProgrammatic(
  'Mojito 5L y Sangria 10L',
  catalogNames,
  dispLitrages,
  '5L'
);
assert(
  ordenInvertido.some((p) => p.name === 'Mojito' && p.litrage === '5L')
    && ordenInvertido.some((p) => /Sangr/i.test(p.name) && p.litrage === '10L'),
  `también acepta cóctel+litraje (orden libre)`
);

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
  const adminAlerts = [];
  for (const step of steps) {
    const alertsBefore = adminAlerts.length;
    lastReply = await processMessage(SESSION_ID, step.input, {
      sendAdminAlert: (alert) => adminAlerts.push(alert)
    });
    const session = getSession(SESSION_ID);
    const text = replyToText(lastReply);
    const newAlerts = adminAlerts.slice(alertsBefore);
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
    if (step.expectAdminAlert === true || step.expectSosTitle || step.expectSosReason) {
      assert(newAlerts.length > 0, 'envía alerta SOS al administrador');
      const alert = newAlerts[newAlerts.length - 1];
      assert(String(alert.type || '').toUpperCase() === 'SOS', `alerta tipo SOS (es ${alert.type})`);
      console.log(`  OK: SOS → admin | título="${alert.title || ''}"`);
      if (alert.body) {
        console.log(`  OK: SOS detalle → ${String(alert.body).replace(/\n/g, ' | ')}`);
      }
      if (step.expectSosTitle) {
        assert(
          String(alert.title || '').includes(step.expectSosTitle),
          `SOS título incluye "${step.expectSosTitle}" (es "${alert.title}")`
        );
      }
      if (step.expectSosReason) {
        assert(
          String(alert.body || '').includes(step.expectSosReason),
          `SOS motivo incluye "${step.expectSosReason}"`
        );
      }
    }
    if (step.expectSilent === true) {
      assert(text === '', 'no envía mensaje al cliente (mute silencioso)');
      console.log('  OK: mute silencioso (sin respuesta al cliente)');
    }
  }
}

try {
  await runCase('Ruido router sin repetir menú', [
    {
      input: 'hola',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'Barriles Desechables', '1️⃣', '2️⃣', '3️⃣'],
      expectNotIncludes: ['no estoy seguro']
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

  await runCase('Saludo Hola buen dia (no “no estoy seguro”)', [
    {
      input: 'Hola buen dia',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', '1️⃣', 'Servicio para Eventos', 'Barriles Desechables'],
      expectNotIncludes: ['no estoy seguro']
    }
  ]);

  await runCase('Saludo ¡Hola!', [
    {
      input: '¡Hola!',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', '1️⃣'],
      expectNotIncludes: ['no estoy seguro']
    }
  ]);

  await runCase('Router menú dígito 1 → Eventos', [
    {
      input: '1',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'te guiaré', 'Servicio para Eventos', 'invitados'],
      expectNotIncludes: ['¡Hola!']
    }
  ]);

  await runCase('Tras menú, opción 1 Eventos sin re-presentar asistente', [
    {
      input: 'hola',
      expectState: 'ESPERANDO_INTENCION',
      expectIncludes: ['asistente virtual', '1️⃣']
    },
    {
      input: '1',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Servicio para Eventos', 'invitados'],
      expectNotIncludes: ['te guiaré', 'Soy el']
    }
  ]);

  await runCase('Router menú emoji 2️⃣ → Barriles', [
    {
      input: '2️⃣',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'te guiaré', 'Barriles Desechables'],
      expectNotIncludes: ['¡Hola!']
    }
  ]);

  await runCase('Tras menú, opción 2 Barriles sin re-presentar asistente', [
    {
      input: 'hola',
      expectState: 'ESPERANDO_INTENCION',
      expectIncludes: ['asistente virtual', '2️⃣']
    },
    {
      input: '2',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['Barriles Desechables', 'comuna'],
      expectNotIncludes: ['te guiaré', 'Soy el']
    }
  ]);

  await runCase('Router menú 3 → Humano', [
    {
      input: '3',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['equipo'],
      expectAdminAlert: true,
      expectSosTitle: 'PIDIÓ HUMANO',
      expectSosReason: 'opción 3'
    }
  ]);

  await runCase('Ruido router', [
    {
      input: 'holi',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['Barriles', 'Eventos', '1️⃣']
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
      expectIncludes: ['asistente virtual', 'te guiaré', 'Eventos', 'invitados'],
      expectNotIncludes: ['¡Hola!']
    }
  ]);

  await runCase('CTA Meta con barriles desechables en la frase', [
    {
      input: 'Hola, quiero más info sobre los barriles desechables',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'te guiaré', 'Barriles Desechables'],
      expectNotIncludes: ['¡Hola!']
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
      expectIncludes: ['Barriles Desechables', '1️⃣', '2️⃣', '3️⃣']
    }
  ]);

  await runCase('Pregunta inicial no activa FAQ ni IA', [
    {
      input: '¿Hacen despachos y cuánto cuesta?',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'Servicio para Eventos', 'Barriles Desechables', '3️⃣'],
      expectNotIncludes: ['no estoy seguro', 'despacho tiene']
    }
  ]);

  await runCase('Barriles keyword barriles solo', [
    {
      input: 'barriles',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'te guiaré', 'Barriles Desechables']
    }
  ]);

  await runCase('Segundo texto ajeno hace SOS silencioso', [
    {
      input: 'solo estoy mirando',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', '1️⃣', '2️⃣', '3️⃣'],
      expectNotIncludes: ['no estoy seguro']
    },
    {
      input: 'quiero comprar zapatos',
      expectState: 'CERRADO',
      expectMuted: true,
      expectSilent: true,
      expectAdminAlert: true,
      expectSosTitle: 'SIN OPCIÓN VÁLIDA',
      expectSosReason: 'No eligió Eventos, Barriles ni Humano'
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
      input: 'Providencia, 5 de agosto',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['sabor'],
      expectNotIncludes: ['no estoy seguro', 'número de la opción']
    }
  ]);

  await runCase('Barriles + datos entrega relativo (legacy)', [
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

  console.log('\n-- Barriles: generar compra → contacto → cierre legacy --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_REVISION_COTIZACION';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: {
        name: null,
        date: '15 de mayo',
        location: 'Providencia',
        locationData: { name: 'Providencia', isRM: true, deliveryCost: { desechable: 5000 } }
      },
      quote: { total: 45000, subtotal: 40000, details: [] }
    };

    const stRev = statesMap.BARRILES_REVISION_COTIZACION;
    const prompt = typeof stRev.promptQuestion === 'function'
      ? stRev.promptQuestion(session)
      : stRev.promptQuestion;
    const promptText = Array.isArray(prompt) ? prompt.join('\n') : String(prompt || '');
    assert(/Generar compra/i.test(promptText), 'cotización barriles ofrece Generar compra');

    const rOk = await stRev.validateAndProcess('1', session);
    assert(rOk.nextState === 'BARRILES_DATOS_CONTACTO', '1 → DATOS_CONTACTO barriles');
    assert(
      /email|correo/i.test(String(rOk.customReply || '')),
      'pide email al generar compra'
    );
    assert(
      /compra online|generar tu compra/i.test(String(rOk.customReply || '')),
      'explica compra online'
    );
    assert(/direcci[oó]n/i.test(String(rOk.customReply || '')), 'menciona dirección de despacho');

    session.currentState = 'BARRILES_DATOS_CONTACTO';
    const stContact = statesMap.BARRILES_DATOS_CONTACTO;
    const rContact = await stContact.validateAndProcess('Ana Pérez, ana@test.cl', session);
    assert(rContact.nextState === 'BARRILES_DATOS_CONTACTO', 'tras nombre/email pide dirección');
    assert(/direcci[oó]n/i.test(String(rContact.customReply || '')), 'pide dirección de despacho');
    assert(/Providencia/i.test(String(rContact.customReply || '')), 'recuerda la comuna ya ingresada al pedir dirección');
    assert(session.contact?.email === 'ana@test.cl', 'guarda email barriles');
    assert(session.contact?.firstName === 'Ana', 'guarda nombre barriles');
    assert(session.contact?.lastName === 'Pérez', 'guarda apellido barriles');

    // Cliente pega la comuna en la dirección: se acepta y se limpia
    const rAddr = await stContact.validateAndProcess(
      'Los Alerces 123, Depto 456, Providencia',
      session
    );
    assert(rAddr.nextState === 'BARRILES_CONFIRMAR_COMPRA', 'con dirección (+comuna) → CONFIRMAR_COMPRA');
    assert(
      /Resumen para crear tu compra/i.test(String(rAddr.customReplies?.[0] || rAddr.customReply || '')),
      'muestra resumen de compra'
    );
    assert(/Los Alerces 123/i.test(String(session.contact?.address || '')), 'guarda dirección barriles');
    assert(
      !/Providencia/i.test(String(session.contact?.address || '')),
      'no duplica la comuna dentro de la dirección'
    );
    assert(
      /Providencia/i.test(String(session.orderBuilder?.clientData?.location || '')),
      'mantiene comuna Providencia'
    );
    assert(/Confirmar/i.test(replyToText(rAddr.customReplies || rAddr.customReply)), 'menú Confirmar/Corregir');

    session.currentState = 'BARRILES_CONFIRMAR_COMPRA';
    const stConfirm = statesMap.BARRILES_CONFIRMAR_COMPRA;
    const rConfirm = await stConfirm.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', 'confirmar cierra barriles (legacy sin API)');
    assert(rConfirm.mute === true, 'mute al cerrar compra barriles');
    assert(/Los Alerces 123/i.test(String(session.contact?.address || '')), 'guarda dirección barriles');
  }

  console.log('\n-- Barriles contacto: fecha solo mes pide día sin pie de asistente --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_DATOS_CONTACTO';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: {
        name: null,
        date: 'septiembre',
        location: 'Providencia',
        locationData: { name: 'Providencia', isRM: true }
      },
      quote: { total: 45000 }
    };

    const stContact = statesMap.BARRILES_DATOS_CONTACTO;
    const rContact = await stContact.validateAndProcess('Felipe Ramirez, felipe@test.cl', session);
    const t = String(rContact.customReply || '');
    assert(rContact.nextState === 'BARRILES_DATOS_CONTACTO', 'sigue en DATOS_CONTACTO hasta tener día');
    assert(/septiembre/i.test(t) && /d[ií]a tentativo/i.test(t), 'recuerda el mes y pide día tentativo');
    assert(/necesario para generar la compra/i.test(t), 'explica por qué necesita la fecha');
    assert(!/soy asistente virtual/i.test(t), 'no repite el pie de asistente virtual');

    const rDay = await stContact.validateAndProcess('20 de septiembre', session);
    assert(rDay.nextState === 'BARRILES_DATOS_CONTACTO', 'tras fecha pide dirección');
    assert(/direcci[oó]n/i.test(String(rDay.customReply || '')), 'pide dirección tras completar fecha');

    const rAddr = await stContact.validateAndProcess('Los Alerces 123, Depto 4', session);
    assert(rAddr.nextState === 'BARRILES_CONFIRMAR_COMPRA', 'con dirección → CONFIRMAR_COMPRA');

    session.currentState = 'BARRILES_CONFIRMAR_COMPRA';
    const stConfirm = statesMap.BARRILES_CONFIRMAR_COMPRA;
    const rConfirm = await stConfirm.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', 'confirmar cierra barriles (legacy sin API)');
    assert(rConfirm.mute === true, 'mute al cerrar tras completar fecha barriles');
  }

  await runCase('Eventos keyword', [
    {
      input: 'evento',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['asistente virtual', 'te guiaré', 'Eventos']
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

  // Confirmación → una sola burbuja (foto + caption con menú); sin “¿Cuál prefieres?” aparte
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
        'Escribe la opción que prefieres'
      ],
      expectNotIncludes: ['Cuál prefieres']
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
        '*5L* → ≈ *25*',
        '*10L* → ≈ *50*',
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
      // FAQ puede variar el copy; basta con cubrir Serena (y no inventar comuna)
      expectIncludes: ['Serena']
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

  await runCase('Router: miss inicial muestra menú; segundo miss silencia', [
    {
      input: 'calentamiento global',
      expectState: 'ESPERANDO_INTENCION',
      expectMuted: false,
      expectIncludes: ['asistente virtual', '1️⃣', 'Barriles Desechables'],
      expectNotIncludes: ['no estoy seguro']
    },
    {
      input: 'segunda pregunta off topic',
      expectState: 'CERRADO',
      expectMuted: true,
      expectSilent: true,
      expectAdminAlert: true,
      expectSosTitle: 'SIN OPCIÓN VÁLIDA',
      expectSosReason: 'después de recibir el menú'
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

  console.log('\n-- Eventos: litros por cóctel (5L Mojito y 15L Sangria) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 50;
    session.orderBuilder = { type: 'dispensador', products: {}, extras: {} };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('5L Mojito y 15L Sangria', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(t1.includes('1x Mojito (5L)'), `Mojito queda en 5L`);
    assert(t1.includes('Sangría') || t1.includes('Sangria'), `incluye Sangría`);
    assert(t1.includes('(10L)') && t1.includes('(5L)'), `15L Sangría se parte en 10L+5L`);
    assert(!/2x Mojito \(5L\)/.test(t1), `no duplica Mojito al 5L de Sangría`);
    const totalMatch = t1.match(/\*Litros:\*\s*(\d+)L/i);
    assert(totalMatch && Number(totalMatch[1]) === 20, `total 5+15 = 20L`);
    assert(/≈\s*\*100\*\s*cócteles/i.test(t1), `20L muestra ≈ 100 cócteles`);
  }

  console.log('\n-- Eventos: número suelto tras el carrito no repite el cóctel anterior --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 40;
    session.orderBuilder = { type: 'dispensador', products: {}, extras: {} };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('mojito 5L', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(t1.includes('1x Mojito (5L)'), `mojito 5L entra como un barril de 5L`);

    // El último mensaje del bot lista el carrito; eso no debe leerse como menú de opciones
    session.history = { turns: [{ role: 'model', text: t1 }] };
    const r2 = await st.validateAndProcess('5 sangria', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(t2.includes('1x Sangría (5L)'), `5 sangria agrega Sangría como 5 litros`);
    assert(!t2.includes('2x Mojito'), `5 sangria no vuelve a sumar el Mojito del carrito`);
  }

  console.log('\n-- Eventos: "2 mojito" pregunta si son barriles --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 40;
    session.orderBuilder = { type: 'dispensador', products: {}, extras: {} };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('2 mojito', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(t1.includes('1️⃣') && t1.includes('2 barriles de 5L'), `2 mojito ofrece menú barriles vs otro tamaño`);

    // 1️⃣ = sí, son barriles del tamaño por defecto
    const r2 = await st.validateAndProcess('1', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(t2.includes('2x Mojito (5L)'), `opción 1 anota 2 barriles de 5L`);

    // 2️⃣ = prefiere indicar el tamaño, y luego lo responde
    await st.validateAndProcess('3 sangria', session);
    const r3 = await st.validateAndProcess('2', session);
    const t3 = typeof r3.customReply === 'string' ? r3.customReply : '';
    assert(/tama[nñ]o de barril/i.test(t3), `opción 2 pide el tamaño`);
    const r4 = await st.validateAndProcess('10L', session);
    const t4 = typeof r4.customReply === 'string' ? r4.customReply : '';
    assert(t4.includes('1x Sangría (10L)'), `tras elegir tamaño, agrega Sangría 10L`);
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
      expectIncludes: ['no te entendí', 'invitados']
    },
    {
      input: 'se pueden comprar?',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['paso con alguien del equipo'],
      expectNotIncludes: ['cotizar y comprar', 'vendemos los dispensadores']
    }
  ]);

  console.log('\n-- Eventos ok cotización → datos contacto → cierre --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_COTIZACION';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 50;
    session.celebrationType = 'Cumpleaños';
    session.date = '15 de mayo';
    session.location = 'Providencia';
    session.isRM = true;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 }
      },
      extras: {},
      quote: { total: 109990 }
    };

    const stCot = statesMap.EVENTOS_COTIZACION;
    const rOk = await stCot.validateAndProcess('ok', session);
    assert(rOk.nextState === 'EVENTOS_DATOS_CONTACTO', 'ok cotización → DATOS_CONTACTO');
    assert(String(rOk.customReply || '').includes('email'), 'pide email al confirmar');
    assert(
      String(rOk.customReply || '').toLowerCase().includes('cotización formal')
        || String(rOk.customReply || '').toLowerCase().includes('copia en tu correo'),
      'explica cotización formal / copia al correo'
    );

    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    const stContact = statesMap.EVENTOS_DATOS_CONTACTO;
    const rContact = await stContact.validateAndProcess('Ana Pérez, ana@test.cl', session);
    assert(rContact.nextState === 'EVENTOS_CONFIRMAR_ENVIO', 'contacto completo → CONFIRMAR_ENVIO');
    assert(
      /Resumen para tu cotizaci[oó]n formal/i.test(replyToText(rContact.customReplies || rContact.customReply)),
      'muestra resumen de envío eventos'
    );

    session.currentState = 'EVENTOS_CONFIRMAR_ENVIO';
    const stConfirm = statesMap.EVENTOS_CONFIRMAR_ENVIO;
    const rConfirm = await stConfirm.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', 'confirmar cierra (path legacy sin API)');
    assert(rConfirm.mute === true, 'mute al cerrar cotización eventos');
    assert(session.contact?.email === 'ana@test.cl', 'guarda email de contacto');
    assert(session.contact?.firstName === 'Ana', 'guarda nombre');
    assert(session.contact?.lastName === 'Pérez', 'guarda apellido');
  }

  console.log('\n-- Eventos contacto: fecha solo mes pide día sin pie de asistente --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 50;
    session.celebrationType = 'Cumpleaños';
    session.date = 'septiembre'; // mes solo: no sirve para la API
    session.location = 'Providencia';
    session.isRM = true;
    session.orderBuilder = {
      type: 'dispensador',
      products: { 'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 } },
      extras: {},
      quote: { total: 109990 }
    };

    const stContact = statesMap.EVENTOS_DATOS_CONTACTO;
    const rContact = await stContact.validateAndProcess('Felipe Ramirez, felipe@test.cl', session);
    const t = String(rContact.customReply || '');
    assert(rContact.nextState === 'EVENTOS_DATOS_CONTACTO', 'sigue en DATOS_CONTACTO hasta tener día');
    assert(/septiembre/i.test(t) && /d[ií]a tentativo/i.test(t), 'recuerda el mes y pide día tentativo');
    assert(/necesario para generar la cotizaci[oó]n/i.test(t), 'explica por qué necesita la fecha');
    assert(!/soy asistente virtual/i.test(t), 'no repite el pie de asistente virtual');

    const rDay = await stContact.validateAndProcess('20 de septiembre', session);
    assert(rDay.nextState === 'EVENTOS_CONFIRMAR_ENVIO', 'con día concreto → CONFIRMAR_ENVIO');

    session.currentState = 'EVENTOS_CONFIRMAR_ENVIO';
    const stConfirm = statesMap.EVENTOS_CONFIRMAR_ENVIO;
    const rConfirm = await stConfirm.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', 'confirmar cierra (path legacy sin API)');
    assert(rConfirm.mute === true, 'mute al cerrar tras completar fecha');
  }

  console.log('\n-- Eventos contacto: "15 diciembre" sin "de" también cierra --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 50;
    session.celebrationType = 'Cumpleaños';
    session.date = 'diciembre';
    session.location = 'Providencia';
    session.isRM = true;
    session.orderBuilder = {
      type: 'dispensador',
      products: { 'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 } },
      extras: {},
      quote: { total: 109990 }
    };
    session.contact = { firstName: 'Felipe', lastName: 'Ramirez', email: 'felipe@test.cl' };

    const stContact = statesMap.EVENTOS_DATOS_CONTACTO;
    const rDay = await stContact.validateAndProcess('15 diciembre', session);
    assert(rDay.nextState === 'EVENTOS_CONFIRMAR_ENVIO', '"15 diciembre" sin "de" → CONFIRMAR_ENVIO');
    assert(/15\s+diciembre/i.test(String(session.date || '')), 'guarda día+mes sin "de"');
    assert(session.guests === 50, 'fecha no pisa invitados (sigue 50)');
    assert(session.contact?.firstName === 'Felipe', 'fecha no pisa nombre');
    assert(session.contact?.lastName === 'Ramirez', 'fecha no pisa apellido');

    session.currentState = 'EVENTOS_CONFIRMAR_ENVIO';
    const stConfirm = statesMap.EVENTOS_CONFIRMAR_ENVIO;
    const rConfirm = await stConfirm.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', '"15 diciembre" sin "de" cierra tras confirmar (legacy sin API)');
    assert(rConfirm.mute === true, 'mute tras fecha sin "de"');
  }

  console.log('\n-- Eventos contacto: "15 de diciembre" no corrompe nombre ni invitados --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 50;
    session.celebrationType = 'Cumpleaños';
    session.date = 'diciembre';
    session.location = 'Providencia';
    session.sessionId = '56912345678@s.whatsapp.net';
    session.clientPhoneE164 = '+56912345678';
    session.orderBuilder = {
      type: 'dispensador',
      products: { 'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 } },
      extras: {},
      quote: { total: 109990 }
    };
    session.contact = {
      firstName: 'Felipe',
      lastName: 'Ramirez',
      email: 'felipe@test.cl',
      phone: '+56912345678'
    };

    const stContact = statesMap.EVENTOS_DATOS_CONTACTO;
    const rDay = await stContact.validateAndProcess('15 de diciembre', session);
    assert(rDay.nextState === 'EVENTOS_CONFIRMAR_ENVIO', '"15 de diciembre" → CONFIRMAR_ENVIO');
    assert(session.guests === 50, '"15 de diciembre" no cambia invitados a 15');
    assert(session.contact?.firstName === 'Felipe', '"15 de diciembre" no pisa nombre a "de"');
    assert(session.contact?.lastName === 'Ramirez', '"15 de diciembre" no pisa apellido a "diciembre"');
    assert(session.contact?.phone === '+56912345678', 'conserva WhatsApp del JID');

    session.currentState = 'EVENTOS_CONFIRMAR_ENVIO';
    const stConfirm = statesMap.EVENTOS_CONFIRMAR_ENVIO;
    const rConfirm = await stConfirm.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', '"15 de diciembre" cierra tras confirmar (legacy sin API)');
  }

  console.log('\n-- Eventos contacto: comuna e invitados faltantes con tono formal --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = null;
    session.date = '15 de mayo';
    session.location = null;
    session.orderBuilder = {
      type: 'dispensador',
      products: { 'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 } },
      extras: {},
      quote: { total: 109990 }
    };
    session.contact = { firstName: 'Ana', lastName: 'Pérez', email: 'ana@test.cl' };

    const stContact = statesMap.EVENTOS_DATOS_CONTACTO;
    // Sin mensaje nuevo: shortQuestion / ask directo vía validate vacío no aplica;
    // simulamos un mensaje que no agrega datos para re-preguntar.
    const r1 = await stContact.validateAndProcess('ok', session);
    const t1 = String(r1.customReply || '');
    assert(/comuna|invitados/i.test(t1), 'pide comuna o invitados faltantes');
    assert(/cotizaci[oó]n formal/i.test(t1), 'explica que es para la cotización formal');
    assert(!/soy asistente virtual/i.test(t1), 'sin pie de asistente en datos faltantes');

    // Completa comuna → debe pedir invitados con el mismo tono
    const r2 = await stContact.validateAndProcess('Providencia', session);
    const t2 = String(r2.customReply || '');
    assert(session.location === 'Providencia', 'guarda comuna');
    assert(/invitados/i.test(t2), 'después de comuna pide invitados');
    assert(/cotizaci[oó]n formal/i.test(t2), 'invitados también con tono formal');
  }

  // --------------------------------------------------------------------------
  // Remediación pre-prod: anti-loop contacto, bleed cross-flow, email typo,
  // idempotencia sesión, falso positivo modificar, multi-intent despacho
  // --------------------------------------------------------------------------
  console.log('\n-- P0: anti-loop en BARRILES_DATOS_CONTACTO (ruido → handoff) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_DATOS_CONTACTO';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: {
        name: null,
        date: '15 de mayo',
        location: 'Providencia',
        locationData: { name: 'Providencia', isRM: true }
      },
      quote: { total: 45000 }
    };
    saveSession(SESSION_ID, session);

    const r1 = await processMessage(SESSION_ID, '??? ???', {
      sendAdminAlert: () => {}
    });
    const s1 = getSession(SESSION_ID);
    assert(s1.currentState === 'BARRILES_DATOS_CONTACTO', '1er ruido sigue en contacto');
    assert(!s1.isMuted, '1er ruido no mutea aún');
    assert(/email|nombre|correo|direcci/i.test(replyToText(r1)), '1er ruido re-pide dato');

    const adminAlerts = [];
    await processMessage(SESSION_ID, '### ###', {
      sendAdminAlert: (a) => adminAlerts.push(a)
    });
    const s2 = getSession(SESSION_ID);
    assert(s2.isMuted === true, '2do ruido → mute anti-loop contacto barriles');
    assert(s2.currentState === 'CERRADO', '2do ruido → CERRADO');
    assert(adminAlerts.some((a) => String(a.type).toUpperCase() === 'SOS'), 'SOS anti-loop contacto barriles');
  }

  console.log('\n-- P0: anti-loop en EVENTOS_DATOS_CONTACTO (ruido → handoff) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 50;
    session.date = '15 de mayo';
    session.location = 'Providencia';
    session.orderBuilder = {
      type: 'dispensador',
      products: { 'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 } },
      extras: {},
      quote: { total: 109990 }
    };
    saveSession(SESSION_ID, session);

    await processMessage(SESSION_ID, '??? ???', { sendAdminAlert: () => {} });
    const adminAlerts = [];
    await processMessage(SESSION_ID, '### ###', {
      sendAdminAlert: (a) => adminAlerts.push(a)
    });
    const s2 = getSession(SESSION_ID);
    assert(s2.isMuted === true, '2do ruido → mute anti-loop contacto eventos');
    assert(s2.currentState === 'CERRADO', '2do ruido eventos → CERRADO');
    assert(adminAlerts.some((a) => String(a.type).toUpperCase() === 'SOS'), 'SOS anti-loop contacto eventos');
  }

  console.log('\n-- P1: bleed cross-flow Eventos→Barriles→Eventos limpia invitados --');
  resetSession(SESSION_ID);
  {
    // Entra a eventos y da invitados
    await processMessage(SESSION_ID, 'evento');
    await processMessage(SESSION_ID, 'cumpleaños para 50 invitados en Providencia el 15 de mayo');
    const sMid = getSession(SESSION_ID);
    assert(sMid.guests === 50, 'guarda 50 invitados en eventos');
    assert(sMid.currentState === 'EVENTOS_CONFIRMAR_DATOS', 'está en confirmar datos');

    // Cambia a barriles (switchIntent limpia guests)
    await processMessage(SESSION_ID, 'mejor barriles desechables');
    const sBar = getSession(SESSION_ID);
    assert(sBar.currentState === 'BARRILES_FILTRO_CANAL', 'cambió a barriles');
    assert(!sBar.guests, 'limpia guests al ir a barriles');

    // Reiniciamos el contador de switches (env puede tener maxIntentSwitches=2)
    // para probar el reingreso sin disparar SOS por indecisión.
    sBar.intentSwitchCount = 0;
    // Simulamos “datos viejos” que el bug anterior dejaba: si no limpiáramos, esto saltaría
    sBar.guests = 50;
    sBar.date = '15 de mayo';
    sBar.location = 'Providencia';
    saveSession(SESSION_ID, sBar);

    // Sin el fix de limpieza en switch, volver a eventos confirmaría con guests=50.
    // Con el fix, el switch limpia guests otra vez al entrar a EVENTOS.
    await processMessage(SESSION_ID, 'servicio para eventos');
    const sBack = getSession(SESSION_ID);
    assert(sBack.currentState === 'EVENTOS_RECOGIDA_DATOS', 'vuelve a recogida datos (no confirmar)');
    assert(!sBack.guests, 'no reutiliza invitados viejos al reentrar');
  }

  console.log('\n-- P1: email typo gmial no se acepta --');
  {
    const { parseEmailFromText, getEmailTypoSuggestion } = await import('../src/logic/cot-contact.js');
    assert(parseEmailFromText('ana@gmial.com') == null, 'gmial.com rechazado');
    assert(parseEmailFromText('ana@gmail.com') === 'ana@gmail.com', 'gmail.com aceptado');
    assert(parseEmailFromText('ana@hotmial.com') == null, 'hotmial.com rechazado');
    const tip = getEmailTypoSuggestion('Ana Pérez, ana@gmial.com');
    assert(tip?.suggestion === 'ana@gmail.com', 'sugiere ana@gmail.com');

    resetSession(SESSION_ID);
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_DATOS_CONTACTO';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: { date: '15 de mayo', location: 'Providencia' },
      quote: { total: 45000 }
    };
    const st = statesMap.BARRILES_DATOS_CONTACTO;
    const r = await st.validateAndProcess('Ana Pérez, ana@gmial.com', session);
    assert(!session.contact?.email, 'no guarda email con typo');
    assert(/gmial|gmail|quisiste decir/i.test(String(r.customReply || '')), 'pide corrección de typo email');
  }

  console.log('\n-- P1: idempotencia sesión cotSale (no re-POST) --');
  {
    const { submitBarrilesSaleConfirmed } = await import('../src/logic/cot-barriles-contact.js');
    const session = {
      contact: { firstName: 'Ana', lastName: 'Pérez', email: 'ana@test.cl', address: 'Los Alerces 123' },
      cotSale: {
        token: 'tok-previo',
        url: 'https://cocktailsontap.cl/pedido/abc',
        totalPrice: 45000,
        quoteId: 'q1'
      }
    };
    const r = await submitBarrilesSaleConfirmed(session);
    assert(r.nextState === 'CERRADO', 'idempotencia → CERRADO');
    assert(r.mute === true, 'idempotencia → mute');
    assert(String(r.customReply || '').includes('https://cocktailsontap.cl/pedido/abc'), 'reusa URL guardada');
  }

  console.log('\n-- P1: falso positivo "¿el pedido llega rápido?" no modifica --');
  {
    const { wantsToChangeBarrilesOrder } = await import('../src/logic/cot-barriles-contact.js');
    const { wantsToChangeEventosOrder } = await import('../src/logic/cot-eventos-contact.js');
    assert(!wantsToChangeBarrilesOrder('¿el pedido llega rápido?'), 'pregunta logística ≠ modificar barriles');
    assert(!wantsToChangeEventosOrder('¿el pedido llega rápido?'), 'pregunta logística ≠ modificar eventos');
    assert(wantsToChangeBarrilesOrder('quiero cambiar el pedido'), 'sí detecta cambiar pedido');
    assert(wantsToChangeEventosOrder('quiero cambiar el menú'), 'sí detecta cambiar menú');
  }

  console.log('\n-- P1: multi-intent carrito + despacho (barriles) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_RECOGIDA_PRODUCTOS';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { date: '15 de mayo', location: 'Providencia' }
    };
    const st = statesMap.BARRILES_RECOGIDA_PRODUCTOS;
    const r = await st.validateAndProcess('2 mojitos y 1 sangría, ¿hacen despacho a Maipú?', session);
    const t = String(r.customReply || '');
    assert(session.orderBuilder.products.Mojito >= 1, 'suma Mojito con multi-intent');
    assert(/despacho|Metropolitana|Serena/i.test(t), 'responde duda de despacho junto al carrito');
  }

  console.log('\n-- P1: multi-intent carrito + despacho (eventos) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 40;
    session.orderBuilder = { type: 'dispensador', products: {}, extras: {} };
    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r = await st.validateAndProcess('5L Mojito, ¿hacen despacho a Maipú?', session);
    const t = String(r.customReply || '');
    assert(/Mojito/i.test(t), 'suma Mojito en eventos multi-intent');
    assert(/despacho|Metropolitana|Serena/i.test(t), 'responde despacho en eventos multi-intent');
  }

  console.log('\n-- P2: SOS indecisión fija CERRADO --');
  resetSession(SESSION_ID);
  {
    // Fuerza contador al límite-1 y dispara un switch más
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_RECOGIDA_DATOS';
    session.userIntent = 'EVENTOS';
    session.intentSwitchCount = 2; // default maxIntentSwitches = 3
    saveSession(SESSION_ID, session);

    const alerts = [];
    await processMessage(SESSION_ID, 'mejor barriles desechables', {
      sendAdminAlert: (a) => alerts.push(a)
    });
    const s = getSession(SESSION_ID);
    assert(s.isMuted === true, 'indecisión → mute');
    assert(s.currentState === 'CERRADO', 'indecisión → CERRADO (no deja a mitad de flujo)');
    assert(alerts.some((a) => /INDECIS/i.test(String(a.title || ''))), 'alerta INDECISIÓN');
  }

  console.log('\n-- P2: SHORT_Q confirmar lleva footer asistente --');
  {
    const stB = statesMap.BARRILES_CONFIRMAR_COMPRA;
    const stE = statesMap.EVENTOS_CONFIRMAR_ENVIO;
    assert(/asistente virtual|HUMANO/i.test(String(stB.shortQuestion || '')), 'footer en BARRILES_CONFIRMAR_COMPRA');
    assert(/asistente virtual|HUMANO/i.test(String(stE.shortQuestion || '')), 'footer en EVENTOS_CONFIRMAR_ENVIO');
  }

  console.log('\n-- helpers: asksDeliveryOrDispatchQuestion --');
  {
    const {
      asksDeliveryOrDispatchQuestion,
      stripDeliveryQuestionForCart,
      parseBarrilesProductsProgrammatic
    } = await import('../src/logic/eventos-helpers.js');
    assert(asksDeliveryOrDispatchQuestion('2 mojitos, ¿hacen despacho a Maipú?'), 'detecta despacho+pedido');
    assert(asksDeliveryOrDispatchQuestion('van a la serena?'), 'detecta cobertura');
    assert(!asksDeliveryOrDispatchQuestion('2 mojitos'), 'pedido solo no es despacho');
    assert(/2 mojitos/i.test(stripDeliveryQuestionForCart('2 mojitos, ¿hacen despacho a Maipú?')), 'strip deja el pedido');
    const catalog = Object.keys(datosPrecios.cocteles || {});
    const parsed = parseBarrilesProductsProgrammatic('2 mojitos y 1 sangría, ¿hacen despacho a Maipú?', catalog);
    assert(parsed.some((p) => p.name === 'Mojito' && p.quantity === 2), 'parser barriles multi-intent');
  }

  console.log('\n-- nudge: elegibilidad + copy + anti-doble --');
  {
    const {
      evaluateNudgeEligibility,
      buildNudgeMessage,
      markNudgeSent,
      clearNudgeFlag,
      getHourInTimezone,
      buildStallKey
    } = await import('../src/logic/inactivity-nudge.js');

    const HOUR = 60 * 60 * 1000;
    const now = Date.now();
    const chileHour = getHourInTimezone(now, 'America/Santiago');
    assert(chileHour >= 0 && chileHour <= 23, 'getHourInTimezone Chile válido');

    const baseCfg = {
      enabled: true,
      states: ['BARRILES_FILTRO_CANAL', 'EVENTOS_RECOGIDA_DATOS'],
      minInactiveHours: 4,
      cronHours: [chileHour], // hora actual → pasa el filtro cron en el test
      timezone: 'America/Santiago',
      maxPerStall: 1,
      includeWeb: true,
      includeInstagram: true,
      maxInboundAgeHours: 24
    };

    // Sesión eventos atascada en invitados, inactiva 5h, bot esperando
    const eventosSession = {
      currentState: 'EVENTOS_RECOGIDA_DATOS',
      userIntent: 'EVENTOS',
      guests: null,
      isMuted: false,
      lastInboundAt: now - 5 * HOUR,
      lastOutboundAt: now - 5 * HOUR + 1000,
      nudge: null
    };

    const okEventos = evaluateNudgeEligibility(eventosSession, baseCfg, now);
    assert(okEventos.ok === true, 'eventos inactivo 5h en hora cron → elegible');
    assert(okEventos.stallKey === 'EVENTOS_RECOGIDA_DATOS:guests', 'stallKey eventos=guests');

    const msgE = buildNudgeMessage(eventosSession, baseCfg);
    assert(/Seguimos.*Eventos/i.test(msgE), 'copy retoma eventos');
    assert(/invitados/i.test(msgE), 'copy pide invitados');
    assert(/cocktailsontap\.cl\/eventos/i.test(msgE), 'copy incluye web eventos');
    assert(/instagram\.com\/cocktailsontap\.chile/i.test(msgE), 'copy incluye Instagram');

    markNudgeSent(eventosSession, okEventos.stallKey, now);
    const blocked = evaluateNudgeEligibility(eventosSession, baseCfg, now);
    assert(blocked.ok === false && blocked.reason === 'already_sent', 'segundo nudge bloqueado por flag');
    assert(eventosSession.isMuted !== true, 'nudge NO mutea la sesión');

    clearNudgeFlag(eventosSession);
    const again = evaluateNudgeEligibility(eventosSession, baseCfg, now);
    assert(again.ok === true, 'tras clearNudgeFlag vuelve a ser elegible');

    // Barriles: delivery pendiente
    const barrilesSession = {
      currentState: 'BARRILES_FILTRO_CANAL',
      userIntent: 'BARRILES',
      isMuted: false,
      orderBuilder: { clientData: { date: null, location: null } },
      lastInboundAt: now - 5 * HOUR,
      lastOutboundAt: now - 4 * HOUR,
      nudge: null
    };
    const okBar = evaluateNudgeEligibility(barrilesSession, baseCfg, now);
    assert(okBar.ok === true, 'barriles sin fecha/comuna → elegible');
    assert(okBar.stallKey === buildStallKey('BARRILES_FILTRO_CANAL', 'delivery'), 'stallKey barriles=delivery');
    const msgB = buildNudgeMessage(barrilesSession, baseCfg);
    assert(/Barriles Desechables/i.test(msgB), 'copy retoma barriles');
    assert(/cocktailsontap\.cl\/barriles/i.test(msgB), 'copy web barriles');

    // Off master switch
    assert(
      evaluateNudgeEligibility(eventosSession, { ...baseCfg, enabled: false }, now).ok === false,
      'NUDGE_ENABLED=false → no elegible'
    );

    // Demasiado pronto (< 4h)
    const tooSoon = {
      ...eventosSession,
      nudge: null,
      lastInboundAt: now - 2 * HOUR,
      lastOutboundAt: now - 2 * HOUR + 500
    };
    assert(
      evaluateNudgeEligibility(tooSoon, baseCfg, now).reason === 'too_soon',
      'inactivo 2h → too_soon'
    );

    // Fuera de ventana 24h
    const tooOld = {
      ...eventosSession,
      nudge: null,
      lastInboundAt: now - 30 * HOUR,
      lastOutboundAt: now - 30 * HOUR + 500
    };
    assert(
      evaluateNudgeEligibility(tooOld, baseCfg, now).reason === 'outside_24h',
      'inactivo 30h → outside_24h'
    );

    // Hora fuera de cron
    const wrongHour = (chileHour + 1) % 24;
    assert(
      evaluateNudgeEligibility(eventosSession, { ...baseCfg, cronHours: [wrongHour] }, now).reason
        === 'outside_cron_hour',
      'fuera de cronHours → outside_cron_hour'
    );

    // Router no está en NUDGE_STATES
    const routerSession = {
      currentState: 'ESPERANDO_INTENCION',
      isMuted: false,
      lastInboundAt: now - 5 * HOUR,
      lastOutboundAt: now - 5 * HOUR + 1,
      nudge: null
    };
    assert(
      evaluateNudgeEligibility(routerSession, baseCfg, now).reason === 'state_not_allowed',
      'ESPERANDO_INTENCION fuera de v1'
    );

    // Mute → no nudge
    assert(
      evaluateNudgeEligibility({ ...eventosSession, nudge: null, isMuted: true }, baseCfg, now).ok
        === false,
      'sesión muteada no recibe nudge'
    );

    // Engine limpia nudge al inbound
    resetSession(SESSION_ID);
    const sNudge = getSession(SESSION_ID);
    sNudge.currentState = 'EVENTOS_RECOGIDA_DATOS';
    sNudge.userIntent = 'EVENTOS';
    sNudge.nudge = { sentAt: now, stateId: 'EVENTOS_RECOGIDA_DATOS', stallKey: 'EVENTOS_RECOGIDA_DATOS:guests' };
    saveSession(SESSION_ID, sNudge);
    await processMessage(SESSION_ID, 'hola otra vez');
    const afterInbound = getSession(SESSION_ID);
    assert(afterInbound.nudge == null, 'inbound del cliente limpia session.nudge');
    assert(typeof afterInbound.lastInboundAt === 'number', 'inbound setea lastInboundAt');
  }
} catch (err) {
  failed += 1;
  console.error('  FAIL: excepción en simulación:', err);
}

// Restaura credenciales COT por si el proceso padre las reutiliza
if (_savedCotApiKey != null) process.env.COT_API_KEY = _savedCotApiKey;
if (_savedCotApiBase != null) process.env.COT_API_BASE_URL = _savedCotApiBase;

console.log('\n=== Resultado ===\n');
if (failed > 0) {
  console.error(`VERIFY FAILED (${failed} assertion(s))`);
  try { closeDb(); } catch (_) {}
  process.exit(1);
}
console.log('VERIFY PASSED');
try { closeDb(); } catch (_) {}
process.exit(0);

