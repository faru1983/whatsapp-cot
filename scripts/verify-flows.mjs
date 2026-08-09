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
// verify no debe esperar delays de burbujas (el smoke llama processMessage directo)
process.env.REPLY_DELAY_AFTER_USER_SEC = '0';
process.env.REPLY_DELAY_BETWEEN_BUBBLES_SEC = '0';

const EXPECTED_STATES = [
  'ESPERANDO_INTENCION',
  'BARRILES_FILTRO_CANAL',
  'BARRILES_INTRO_MENU',
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
const {
  isOnlyAdvanceProductsOrder,
  wantsAdvanceProductsOrder,
  asksCocktailPriceOrCatalog,
  buildContextualPriceOrCatalogTip,
  resolveFlowLane
} = await import('../src/logic/interruptions.js');
assert(isOnlyAdvanceProductsOrder('seguimos'), `"seguimos" puro → isOnlyAdvance`);
assert(isOnlyAdvanceProductsOrder('listo'), `"listo" puro → isOnlyAdvance`);
assert(isOnlyAdvanceProductsOrder('ok'), `"ok" puro → isOnlyAdvance`);
assert(!isOnlyAdvanceProductsOrder('2 mojitos y 1 aperol seguimos'), `pedido+seguimos NO es only-advance`);
assert(wantsAdvanceProductsOrder('2 mojitos y 1 aperol seguimos'), `pedido+seguimos sí quiere avanzar`);
assert(wantsAdvanceProductsOrder('ok'), `"ok" sí quiere avanzar`);
assert(!isOnlyAdvanceProductsOrder('aka'), `"aka" no es advance`);

// Precio contextual: no mezclar Barriles↔Eventos según el carril
assert(asksCocktailPriceOrCatalog('Valor de los cocteles'), `detecta valor de cócteles`);
assert(!asksCocktailPriceOrCatalog('cuánto cuesta el despacho a Providencia'), `despacho ≠ tip de cócteles`);
assert(resolveFlowLane({ userIntent: 'EVENTOS' }, 'EVENTOS_ELECCION_FORMATO') === 'EVENTOS', `carril eventos`);

console.log('\n-- replyTiming (.env REPLY_DELAY_*) --');
{
  const { loadBotConfig } = await import('../src/core/config.js');
  const { sleepMs } = await import('../src/logic/reply-timing.js');
  const cfg = loadBotConfig();
  assert(cfg.replyTiming?.afterUserMs === 0, 'verify fuerza afterUserMs=0');
  assert(cfg.replyTiming?.betweenBubblesMs === 0, 'verify fuerza betweenBubblesMs=0');
  const t0 = Date.now();
  await sleepMs(0);
  assert(Date.now() - t0 < 50, 'sleepMs(0) no espera');
}
{
  const tipFmt = buildContextualPriceOrCatalogTip(
    { userIntent: 'EVENTOS' },
    'EVENTOS_ELECCION_FORMATO',
    'Valor de los cocteles'
  );
  assert(/Dispensador|Muro/i.test(tipFmt), `tip formato menciona Dispensador/Muro`);
  assert(/cocktailsontap\.cl\/eventos/i.test(tipFmt), `tip formato linkea /eventos`);
  assert(!/desechable/i.test(tipFmt), `tip formato NO mezcla Barriles Desechables`);
  assert(/elige el formato|elige.*formato/i.test(tipFmt), `tip formato pide elegir formato`);

  const tipConFormato = buildContextualPriceOrCatalogTip(
    { userIntent: 'EVENTOS', eventoFormato: 'Dispensador Portátil' },
    'EVENTOS_ELECCION_MENU',
    'precios'
  );
  assert(/Dispensador Portátil/i.test(tipConFormato), `tip con formato nombra el servicio`);
  assert(!/desechable/i.test(tipConFormato), `tip con formato sin desechable`);

  const tipBar = buildContextualPriceOrCatalogTip(
    { userIntent: 'BARRILES' },
    'BARRILES_FILTRO_CANAL',
    'precios'
  );
  assert(/31\.990|desechable/i.test(tipBar), `tip barriles menciona desechable/precio base`);
  assert(!/Dispensador|Muro/i.test(tipBar), `tip barriles no pivotea a eventos`);
}

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
  const { hasDrinkSelection, hasProductOrderSignal, findClosestCatalogMatch, preciosData } = await import('../src/logic/utils.js');
  const { isGreetingOrNoise } = await import('../src/logic/interruptions.js');
  const { parseBarrilesProductsProgrammatic } = await import('../src/logic/eventos-helpers.js');
  assert(!hasDrinkSelection('Providencia, 5 de agosto'), `"Providencia, 5 de agosto" no es pedido de cócteles`);
  assert(!hasDrinkSelection('Las Condes, 15 de mayo'), `fecha+comuna no es pedido de cócteles`);
  assert(hasDrinkSelection('2 mojitos y 1 sangría'), `sí detecta pedido de cócteles`);
  assert(hasDrinkSelection('1 aperol'), `sí detecta aperol`);

  // Cortesía / señal de pedido (anti alucinación NLU en menú de cócteles)
  assert(isGreetingOrNoise('Gracias por la información'), `gracias por la info = ruido`);
  assert(isGreetingOrNoise('perfecto gracias'), `perfecto gracias = ruido`);
  assert(isGreetingOrNoise('muchas gracias'), `muchas gracias = ruido`);
  assert(!isGreetingOrNoise('gracias, 10L Mojito'), `gracias + cóctel NO es solo ruido`);
  assert(!hasProductOrderSignal('Gracias por la información'), `cortesía sin señal de pedido`);
  assert(hasProductOrderSignal('10L Mojito'), `10L Mojito sí es señal`);
  assert(hasProductOrderSignal('2 barriles'), `2 barriles sí es señal`);

  // Typos / nombres incompletos → catálogo (patrón, no un solo string)
  const catalogNames = Object.keys(preciosData.cocteles || {});
  assert(findClosestCatalogMatch('ramazzoti', catalogNames) === 'Ramazzotti Spritz', 'typo ramazzoti');
  assert(findClosestCatalogMatch('ramazoti', catalogNames) === 'Ramazzotti Spritz', 'typo ramazoti');
  assert(findClosestCatalogMatch('mamazoti', catalogNames) === 'Ramazzotti Spritz', 'typo mamazoti');
  assert(findClosestCatalogMatch('margarita', catalogNames) === 'Tequila Margarita', 'incompleto margarita');
  assert(findClosestCatalogMatch('negroni', catalogNames) == null, 'negroni fuera de carta ≠ match forzado');
  assert(findClosestCatalogMatch('mocktails', catalogNames) == null, 'mocktails (categoría) ≠ un cóctel concreto');
  assert(findClosestCatalogMatch('mocktail', catalogNames) == null, 'mocktail (categoría) ≠ un cóctel concreto');
  const progRam = parseBarrilesProductsProgrammatic('ramazzoti', catalogNames);
  assert(progRam.some((p) => p.name === 'Ramazzotti Spritz'), 'programático reconoce ramazzoti');
}

// Fechas: día+mes (con/sin "de"), solo mes, y conversión ISO para la API
const { toIsoDateFromBotText } = await import('../src/logic/cot-event-quote.js');
assert(parseDate('15 de mayo') === '15 de mayo', `día+mes → 15 de mayo`);
assert(parseDate('15 diciembre') === '15 diciembre', `día+mes sin "de" → 15 diciembre`);
assert(parseDate('el 3 diciembre 2027') === 'el 3 diciembre 2027', `día+mes+año sin "de"`);
assert(parseDate('quiero cotizar un matrimonio para diciembre') === 'para diciembre', `mes solo con para`);
assert(parseDate('en marzo 2027') === 'en marzo 2027', `mes + año`);
assert(parseDate('sin fecha acá') == null, `sin fecha → null`);
// Meses no pueden matchear como subcadena (género ≠ enero, etc.)
assert(parseDate('Es una Rebelacion de Genero') == null, `"género" no es fecha enero`);
assert(parseDate('revelación de género') == null, `género acentuado ≠ enero`);
assert(parseDate('enero') === 'enero', `mes enero suelto sí vale`);
assert(/pr[oó]ximo\s+a[nñ]o/i.test(String(parseDate('es para el proximo año') || '')), `próximo año es fecha vaga`);
assert(parseDate('el año que viene') != null, `año que viene es fecha vaga`);
assert(toIsoDateFromBotText('15 de mayo') != null, `ISO: 15 de mayo`);
assert(toIsoDateFromBotText('15 diciembre') != null, `ISO: 15 diciembre (sin "de")`);
assert(toIsoDateFromBotText('15/12') != null, `ISO: 15/12`);
assert(toIsoDateFromBotText('16 /9 /2026') === '2026-09-16', `ISO: 16 /9 /2026 con espacios`);
assert(parseDate('16 /9 /2026') != null, `parseDate: 16 /9 /2026 con espacios`);
assert(toIsoDateFromBotText('diciembre') == null, `ISO: solo mes → null`);
assert(toIsoDateFromBotText('15 diciembre 2027') === '2027-12-15', `ISO: año explícito`);
assert(toIsoDateFromBotText('mañana') != null, `ISO: mañana relativa`);
assert(toIsoDateFromBotText('este sábado') != null, `ISO: este sábado relativa`);
{
  const { normalizeBotDateText, exampleConcreteDateHint, todayPartsChile } = await import('../src/logic/cot-event-quote.js');
  const normSab = normalizeBotDateText('este sábado');
  assert(/^\d{2}\/\d{2}\/\d{4}$/.test(String(normSab)), `normaliza este sábado → DD/MM/YYYY (es ${normSab})`);
  assert(toIsoDateFromBotText(normSab) != null, `DD/MM/YYYY de sábado sigue siendo ISO-válida`);
  assert(/\d{1,2}\s+de\s+\w+/i.test(exampleConcreteDateHint()), `ejemplo concreto de entrega (copy)`);

  // "8 de agosto" → 08/08/<año Chile o siguiente>
  const today = todayPartsChile();
  const normAgo = normalizeBotDateText('8 de agosto');
  assert(/^\d{2}\/08\/\d{4}$/.test(String(normAgo)), `"8 de agosto" → DD/MM/YYYY (es ${normAgo})`);
  assert(String(normAgo).startsWith('08/08/'), `"8 de agosto" día/mes 08/08`);
  const yAgo = Number(String(normAgo).slice(6));
  const expectY = (today.month > 8 || (today.month === 8 && today.day > 8))
    ? today.year + 1
    : today.year;
  assert(yAgo === expectY, `"8 de agosto" año correcto (es ${yAgo}, esperaba ${expectY})`);

  assert(normalizeBotDateText('diciembre') === 'diciembre', `solo mes no se inventa día`);
  assert(normalizeBotDateText('15/12/2027') === '15/12/2027', `DD/MM/YYYY explícita se conserva`);
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
  const { applyEventDataFromMessage, extractGuestsFromMessage, parseCelebrationType, normalizeCelebrationLabel, wantsSkipCelebrationType, looksLikeCelebrationUncertainty, asksEquipmentOrResaleQuestion, wantsEventInfoOnly, wantsUnknownGuestsCount, wantsSkipEventLogistics, wantsUnknownLocationOnly } = await import('../src/logic/eventos-helpers.js');
  const { applyContactFromMessage, splitStreetAndComuna } = await import('../src/logic/cot-contact.js');
  assert(extractGuestsFromMessage('15 diciembre') == null, `fecha "15 diciembre" ≠ invitados`);
  assert(extractGuestsFromMessage('15 de diciembre') == null, `fecha "15 de diciembre" ≠ invitados`);
  assert(extractGuestsFromMessage('50 invitados') === 50, `explícito 50 invitados`);
  assert(parseCelebrationType('Es un bautizo') === 'Bautizo', `parser bautizo`);
  assert(parseCelebrationType('bautismo') === 'Bautizo', `parser bautismo`);
  assert(parseCelebrationType('Es una Rebelacion de Genero') === 'Revelación de género', `parser revelación (typo)`);
  assert(normalizeCelebrationLabel('bautizo') === 'Bautizo', `normalize bautizo`);
  assert(normalizeCelebrationLabel('Otro') === 'Otro', `normalize Otro`);
  assert(wantsSkipCelebrationType('ninguno') === true, `skip tipo: ninguno`);
  assert(wantsSkipCelebrationType('aún no lo sé') === true, `skip tipo: aún no lo sé`);
  assert(wantsSkipCelebrationType('au no lo se') === true, `skip tipo: typo au no lo se`);
  assert(wantsSkipCelebrationType('no sé') === true, `skip tipo: no sé`);
  assert(wantsSkipCelebrationType('es un bautizo') === false, `bautizo no es skip`);
  assert(looksLikeCelebrationUncertainty('aún no lo tengo claro') === true, `incertidumbre: aún no lo tengo claro`);
  assert(looksLikeCelebrationUncertainty('Mi gustar') === false, `gibberish no es incertidumbre de tipo`);
  assert(asksEquipmentOrResaleQuestion('se pueden comprar?') === true, `compra equipo: se pueden comprar`);
  assert(asksEquipmentOrResaleQuestion('solo quiero cotizar') === false, `cotizar ≠ compra equipo`);
  assert(wantsEventInfoOnly('solo quiero cotizar') === true, `info-only: solo quiero cotizar`);
  assert(wantsEventInfoOnly('aún no tengo evento') === true, `info-only: sin evento`);
  assert(wantsEventInfoOnly('cumpleaños 50 invitados') === false, `datos reales no son info-only`);
  assert(wantsUnknownGuestsCount('es que aun no se cuantos seran') === true, `unknown guests`);
  assert(wantsUnknownGuestsCount('solo quiero cotizar') === false, `cotizar no es unknown guests`);

  assert(wantsSkipEventLogistics('ok') === true, `skip logística: ok`);
  assert(wantsSkipEventLogistics('el lugar aun no lo se') === true, `skip logística: lugar no sé`);
  assert(wantsUnknownLocationOnly('es para el proximo año, el lugar aun no lo se') === true, `unknown location only`);

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
    assert(/15\/12\/\d{4}/.test(String(sess.date || '')), `applyEvent: sí guarda fecha canónica (es ${sess.date})`);
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
    // "lunes" relativo → DD/MM/YYYY (ya no queda la palabra lunes)
    { msg: '50 invitados en lunes', guests: 50, dateRe: /^\d{2}\/\d{2}\/\d{4}$/, loc: null },
    { msg: 'en diciembre en Providencia', guests: null, dateRe: /diciembre/i, loc: 'Providencia' },
    { msg: 'cumpleaños en septiembre en Las Condes', guests: null, dateRe: /septiembre/i, loc: 'Las Condes' },
    { msg: '8 de agosto, las condes', guests: null, dateRe: /^08\/08\/\d{4}$/, loc: 'Las Condes' }
  ];
  for (const c of cases) {
    const sess = {};
    applyEventDataFromMessage(c.msg, sess);
    if (c.guests != null) assert(sess.guests === c.guests, `${c.msg} → guests`);
    assert(c.dateRe.test(String(sess.date || '')), `${c.msg} → fecha (es ${sess.date})`);
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
  fixEventLitrageShorthand,
  asksAvailableCocktailsList,
  getCoctelesNamesCatalog
} = await import('../src/logic/utils.js');
const catalogNames = Object.keys(datosPrecios.cocteles || {});

assert(asksAvailableCocktailsList('Cuales tienes?'), `"cuales tienes" pide catálogo general`);
assert(asksAvailableCocktailsList('que cocteles hay'), `"que cocteles hay" pide catálogo general`);
assert(!asksAvailableCocktailsList('que mojito sabor tienes?'), `sabores de familia no es catálogo general`);
{
  const namesCatalog = getCoctelesNamesCatalog();
  assert(/🍸 \*CLÁSICOS\*/.test(namesCatalog), `catálogo nombres: sección clásicos`);
  assert(/\n\n🥃 \*COMBINADOS\*/.test(namesCatalog), `catálogo nombres: salto entre categorías`);
  assert(/- Pisco Sour/.test(namesCatalog), `catálogo nombres: viñetas`);
}

// El resumen del carrito no es un menú: si lo fuera, cualquier respuesta sumaría ese mismo cóctel
const cartBubble = '🍹 Te confirmo los cócteles seleccionados:\n\n- 5L Mojito: $69.990\n';
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
// Estilo canónico de preguntas: *pregunta completa?* + _(ej: …)_ en minúscula
assert(
  /\*\¿.+\?\*\n_\(ej: /s.test(ASK_EVENT_COCKTAILS),
  `ASK_EVENT_COCKTAILS usa *pregunta?* + _(ej: …)_`
);
{
  const { askForMissingBarriles } = await import('../src/logic/cot-barriles-contact.js');
  const { askForMissingEventosContact } = await import('../src/logic/cot-eventos-contact.js');
  const askNameB = askForMissingBarriles(['nombre']);
  const askNameE = askForMissingEventosContact(['nombre']);
  const askGuestsE = askForMissingEventosContact(['invitados']);
  assert(/\*\¿.+\?\*\n_\(ej: /s.test(askNameB), `barriles ask nombre: *pregunta?* + _(ej:)_`);
  assert(/\*\¿.+\?\*\n_\(ej: /s.test(askNameE), `eventos ask nombre: *pregunta?* + _(ej:)_`);
  assert(/\*\¿.+\?\*\n_\(ej: /s.test(askGuestsE), `eventos ask invitados: *pregunta?* + _(ej:)_`);
  assert(!/\bEjemplo:|\(Ej:/m.test(askNameB + askNameE + askGuestsE), `ejemplos en minúscula ej: (no Ejemplo:/Ej:)`);
}
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
const dotSepLitros = parseEventProductsProgrammatic(
  '20 L mojito. 10 L aperol',
  catalogNames,
  dispLitrages,
  '5L'
);
assert(
  dotSepLitros.some((p) => p.name === 'Mojito' && p.litrage === '20L'),
  `punto: Mojito 20L`
);
assert(
  dotSepLitros.some((p) => /Aperol/i.test(p.name) && p.litrage === '10L'),
  `punto: Aperol 10L (no hereda el 20L)`
);
const shorthandDe = parseEventProductsProgrammatic(
  '15L de mojito y 5 de aperol',
  catalogNames,
  dispLitrages,
  '5L'
);
assert(
  shorthandDe.some((p) => p.name === 'Mojito' && p.litrage === '15L'),
  `"5 de": Mojito 15L`
);
assert(
  shorthandDe.some((p) => /Aperol/i.test(p.name) && p.litrage === '5L'),
  `"5 de aperol" = 5L (no hereda el 15L del Mojito)`
);
const bareNumAperol = parseEventProductsProgrammatic(
  '15L mojito y 5 aperol',
  catalogNames,
  dispLitrages,
  '5L'
);
assert(
  bareNumAperol.some((p) => /Aperol/i.test(p.name) && p.litrage === '5L'),
  `"5 aperol" sin L = 5L`
);
const tenDeMojito = parseEventProductsProgrammatic(
  '10 de mojito',
  catalogNames,
  dispLitrages,
  '5L'
);
assert(
  tenDeMojito.length === 1 && tenDeMojito[0].litrage === '10L',
  `"10 de mojito" solo = 10L (no default 5L)`
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

// Cierre cotización/compra: aire entre bloques (no pegar con filter(Boolean))
{
  const { getEventQuoteCreatedReply, getBarrilesSaleCreatedReply, getEventFormatPitch } = await import('../src/views/templates.js');
  const eventClose = getEventQuoteCreatedReply({
    url: 'https://cocktailsontap.cl/cotizar/abc',
    totalStr: '$100.000',
    email: 'ana@test.cl'
  });
  assert(/\n\n/.test(eventClose), `cierre eventos conserva saltos en blanco`);
  assert(/¡Cotización lista!/i.test(eventClose), `cierre eventos título corto`);
  assert(/💰/.test(eventClose) && /🔗/.test(eventClose) && /📧/.test(eventClose), `cierre eventos con emojis`);
  assert(/Revisar y modificar/.test(eventClose), `cierre eventos bullets cortos`);
  assert(!/Cuando estés segura/.test(eventClose), `cierre eventos sin párrafo largo viejo`);

  const saleClose = getBarrilesSaleCreatedReply({
    url: 'https://cocktailsontap.cl/compra/xyz',
    totalStr: '$50.000',
    email: 'ana@test.cl'
  });
  assert(/\n\n/.test(saleClose), `cierre barriles conserva saltos en blanco`);
  assert(/¡Compra lista!/i.test(saleClose), `cierre barriles título corto`);
  assert(!/filter\(Boolean\)/.test(saleClose), `sanity`);

  // Pitch formato: corto + misma promesa de incluido
  const pitchMuro = getEventFormatPitch('muro');
  const pitchDisp = getEventFormatPitch('dispensador');
  assert(/Todo esto está incluido, sin costo adicional/i.test(pitchMuro), `pitch muro mantiene incluido`);
  assert(/Hielo/.test(pitchMuro) && /Garnish/.test(pitchMuro) && /Vasos/.test(pitchMuro), `pitch muro lista lo incluido`);
  assert(pitchMuro.length < 520, `pitch muro compacto (len=${pitchMuro.length})`);
  assert(!/verdadero punto de atracción para tus invitados/i.test(pitchMuro), `pitch muro sin intro larga`);
  assert(/Todo esto está incluido, sin costo adicional/i.test(pitchDisp), `pitch dispensador mantiene incluido`);
  assert(pitchDisp.length < 520, `pitch dispensador compacto (len=${pitchDisp.length})`);
}

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
      expectIncludes: ['Cocktails on Tap', 'tipo de evento', 'ej:', 'matrimonio'],
      expectNotIncludes: ['¡Hola!', 'te guiaré', 'Soy el', 'asistente virtual', 'cocktailsontap.cl/eventos', 'Escribe el número']
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
      expectIncludes: ['Cocktails on Tap', 'tipo de evento', 'ej:'],
      expectNotIncludes: ['te guiaré', 'Soy el', 'asistente virtual', 'Escribe el número']
    }
  ]);

  await runCase('Router menú emoji 2️⃣ → Barriles', [
    {
      input: '2️⃣',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['barriles desechables', 'listos para servir', '31.990', 'Para continuar', 'Quiero hacer un pedido', 'Quiero ver precios', 'Tengo una duda'],
      expectNotIncludes: ['¡Hola!', 'te guiaré', 'Soy el', 'asistente virtual']
    }
  ]);

  // Pitch Barriles: 2 burbujas (info + menú intención), pregunta no pegada al pitch
  {
    const stBar = statesMap.BARRILES_FILTRO_CANAL;
    const welcome = typeof stBar.promptQuestion === 'function'
      ? stBar.promptQuestion({})
      : stBar.promptQuestion;
    assert(Array.isArray(welcome) && welcome.length === 2, 'barriles entrada = 2 burbujas');
    assert(/listos para servir/i.test(welcome[0]) && !/Para continuar/i.test(welcome[0]), 'burbuja 1 = pitch sin menú');
    assert(/vuelve a refrigerarlo/i.test(welcome[0]) && /Se conserva por/i.test(welcome[0]), 'pitch: bullets refrigerar y conservación separados');
    assert(/Para continuar/i.test(welcome[1]) && /Quiero hacer un pedido/i.test(welcome[1]), 'burbuja 2 = menú intención');
  }

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
      expectIncludes: ['barriles desechables', 'listos para servir', 'Quiero hacer un pedido'],
      expectNotIncludes: ['te guiaré', 'Soy el', 'asistente virtual']
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
      expectIncludes: ['Cocktails on Tap', 'tipo de evento'],
      expectNotIncludes: ['¡Hola!', 'te guiaré', 'Soy el', 'asistente virtual']
    }
  ]);

  await runCase('CTA Meta con barriles desechables en la frase', [
    {
      input: 'Hola, quiero más info sobre los barriles desechables',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['barriles desechables', 'listos para servir', 'Quiero hacer un pedido'],
      expectNotIncludes: ['¡Hola!', 'te guiaré', 'Soy el', 'asistente virtual']
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
      expectIncludes: ['barriles desechables', 'listos para servir', 'Quiero hacer un pedido'],
      expectNotIncludes: ['te guiaré', 'Soy el', 'asistente virtual']
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
      expectIncludes: ['pedido', 'precios', 'duda']
    }
  ]);

  await runCase('Barriles menú 1️⃣ pedido → catálogo + pide sabores', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: '1',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios', 'cóctel', 'catálogo'],
      expectNotIncludes: ['no estoy seguro', 'Cotizar mi pedido', 'aún no lo tenemos']
    }
  ]);

  await runCase('Barriles menú palabras "hacer un pedido" → pedido (no "fuera de carta")', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'hacer un pedido',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios', 'cóctel'],
      expectNotIncludes: ['aún no lo tenemos', 'no entendí la opción']
    }
  ]);

  // Variantes del mismo patrón (compra/orden), no solo el string "pedido"
  await runCase('Barriles menú "ok quiero hacer una compra" → pedido', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'ok quiero hacer una compra',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios', 'cóctel'],
      expectNotIncludes: ['no entendí la opción']
    }
  ]);

  await runCase('Barriles menú "quiero armar una orden" → pedido', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'quiero armar una orden',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios', 'cóctel'],
      expectNotIncludes: ['no entendí la opción']
    }
  ]);

  await runCase('Barriles menú estricto: sabor suelto → disculpa + menú (no atajo carrito)', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'mojito',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['no entendí la opción', 'número', 'Quiero hacer un pedido', 'Quiero ver precios'],
      expectNotIncludes: ['aún no lo tenemos', 'Excelente elección']
    }
  ]);

  await runCase('Barriles tras 1️⃣: match sabor → Excelente elección sin reenviar catálogo', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'mojito',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Excelente elección', 'Mojito', 'OK'],
      expectNotIncludes: ['no estoy seguro', 'Cotizar mi pedido', 'barril_desechable_precios']
    }
  ]);

  await runCase('Barriles tras 1️⃣: sangría → match Excelente elección', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'sangria',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Excelente elección', 'Sangría', 'OK'],
      expectNotIncludes: ['Sabores disponibles y precios']
    }
  ]);

  await runCase('Barriles tras 1️⃣: 1 real + 1 inexistente → match + aviso honesto', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'mojito y piña colada',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Mojito', 'piña colada', 'aún no', 'OK'],
      expectNotIncludes: ['por si quieres agregar otro sabor', 'barril_desechable_precios']
    }
  ]);

  await runCase('Barriles tras 1️⃣: 2 cócteles a la vez → ambos en carrito', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'Sangría y Ramazzotti',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Anoté', 'Sangría', 'Ramazzotti', 'Subtotal'],
      expectNotIncludes: ['Cotizar mi pedido']
    }
  ]);

  await runCase('Barriles menú 2️⃣ precios → catálogo + ¿quieres pedir?', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: '2',
      expectState: 'BARRILES_INTRO_MENU',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios', 'pedido', 'No, gracias'],
      expectNotIncludes: ['Cotizar mi pedido', 'Tengo una consulta']
    }
  ]);

  // Variantes del mismo patrón (valores/costo/valen), no solo "precios"
  await runCase('Barriles menú "valores" → precios', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'valores',
      expectState: 'BARRILES_INTRO_MENU',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios', 'pedido'],
      expectNotIncludes: ['no entendí la opción']
    }
  ]);

  await runCase('Barriles menú "cuánto cuestan" → precios', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL', expectMuted: false },
    {
      input: 'cuánto cuestan',
      expectState: 'BARRILES_INTRO_MENU',
      expectMuted: false,
      expectIncludes: ['barril_desechable_precios'],
      expectNotIncludes: ['no entendí la opción']
    }
  ]);

  await runCase('Barriles solo precios sin cotizar → web + mute', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'solo quiero ver precios, no cotizo',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['cocktailsontap.cl/barriles']
    }
  ]);

  await runCase('Barriles post-precios 1️⃣ sí → pide sabores', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '2', expectState: 'BARRILES_INTRO_MENU' },
    {
      input: '1',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['cóctel', 'catálogo']
    }
  ]);

  await runCase('Barriles productos: texto no entendido → miss suave (catálogo ya enviado)', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'tienes piña colada?',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['no entendí tu pedido', 'catálogo', 'más arriba'],
      expectNotIncludes: ['barril_desechable_precios', 'Todo bien con el pedido', 'aún no lo tenemos']
    }
  ]);

  await runCase('Barriles productos: "valores" → tip de precios (no miss de cóctel)', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'valores',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['precios', '31.990'],
      expectNotIncludes: ['no entendí tu pedido', 'aún no lo tenemos']
    }
  ]);

  console.log('\n-- Barriles productos: strikes miss → HUMANO / SOS --');
  resetSession(SESSION_ID);
  {
    const { registerBarrilesProductOrderMiss, buildBarrilesProductOrderMissReply } = await import('../src/logic/barriles-intro.js');
    assert(/no entendí tu pedido/i.test(buildBarrilesProductOrderMissReply(1)), 'miss strike 1: pedido + catálogo');
    assert(/asistente virtual/i.test(buildBarrilesProductOrderMissReply(2)) && /HUMANO/i.test(buildBarrilesProductOrderMissReply(2)), 'miss strike 2: asistente + HUMANO');

    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_RECOGIDA_PRODUCTOS';
    session.userIntent = 'BARRILES';
    session.orderBuilder = { type: 'desechable', products: {}, extras: {}, clientData: {} };
    session.consecutiveErrors = 0;

    const st = statesMap.BARRILES_RECOGIDA_PRODUCTOS;
    const r1 = await st.validateAndProcess('xyzabc raro', session);
    assert(r1.stallHandled === true, 'miss 1: stallHandled');
    assert(session.consecutiveErrors === 1, 'miss 1: strike=1');
    assert(/no entendí tu pedido/i.test(String(r1.customReply || '')), 'miss 1: copy suave');
    assert(r1.mute !== true, 'miss 1: sin mute');

    const r2 = await st.validateAndProcess('otro texto raro', session);
    assert(session.consecutiveErrors === 2, 'miss 2: strike=2');
    assert(/asistente virtual/i.test(String(r2.customReply || '')) && /HUMANO/i.test(String(r2.customReply || '')), 'miss 2: copy con HUMANO');
    assert(r2.mute !== true, 'miss 2: aún sin mute (última chance)');

    const r3 = await st.validateAndProcess('tercera vez raro', session);
    assert(session.consecutiveErrors === 3, 'miss 3: strike=3');
    assert(r3.mute === true, 'miss 3: mute SOS');
    assert(r3.notifyAdmin?.type === 'SOS', 'miss 3: alerta SOS');

    // Helper directo: umbral 2 → al 3er miss mute
    const sDirect = { consecutiveErrors: 0 };
    registerBarrilesProductOrderMiss(sDirect, 2);
    registerBarrilesProductOrderMiss(sDirect, 2);
    const last = registerBarrilesProductOrderMiss(sDirect, 2);
    assert(last.mute === true && sDirect.consecutiveErrors === 3, 'register miss: 3er → mute');
  }

  await runCase('Barriles productos: "cuáles tienes" → lista compacta (sin imagen)', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'cuáles tienes',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Cócteles:', 'Combinados:', 'Mocktails:', 'Mojito'],
      expectNotIncludes: ['barril_desechable_precios']
    }
  ]);

  // Bug reportado: cliente eligió Mojito y pidió "Sin alcohol" → el bot respondía
  // "Ese cóctel aún no lo tenemos en la carta" (trataba el pedido válido de Mocktails
  // como un sabor inventado). Ahora debe ofrecer la versión sin alcohol de esa familia.
  await runCase('Barriles "sin alcohol" con Mojito en carrito → sugiere Mojito Mocktail (no "fuera de carta")', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    { input: 'mojito', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'Sin alcohol',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['sin alcohol', 'Mojito Mocktail'],
      expectNotIncludes: ['aún no lo tenemos', 'no te entendí']
    },
    {
      // Confirma el nombre exacto → debe agregarse al carrito (no repetir la sugerencia)
      input: 'Mojito Mocktail',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Mojito Mocktail', 'Subtotal'],
      expectNotIncludes: ['Dime el nombre de la que quieres']
    }
  ]);

  // Mismo patrón sin ningún sabor mencionado antes (carrito vacío) → carta completa de Mocktails
  await runCase('Barriles "mocktail" con carrito vacío → carta completa Mocktails', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: '¿tienen mocktails?',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Mojito Mocktail', 'Sangría Mocktail'],
      expectNotIncludes: ['aún no lo tenemos']
    }
  ]);

  // Tras elegir pedido: sabor + "sin alcohol" en el mismo mensaje → Mocktail (no alcohol).
  await runCase('Barriles "mojito sin alcohol" en productos → sugiere Mocktail (no agrega Mojito con alcohol)', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
    {
      input: 'mojito sin alcohol',
      expectState: 'BARRILES_RECOGIDA_PRODUCTOS',
      expectMuted: false,
      expectIncludes: ['Mojito Mocktail'],
      expectNotIncludes: ['$39.990', 'Ron Blanco']
    }
  ]);

  await runCase('Barriles post-precios 2️⃣ no → mute sin SOS', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '2', expectState: 'BARRILES_INTRO_MENU' },
    {
      input: '2',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['cuando quieras']
    }
  ]);

  await runCase('Barriles menú 3️⃣ duda → pide texto; luego mute + SOS con la pregunta', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: '3',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['duda']
    },
    {
      input: '¿hacen envíos a Viña?',
      expectState: 'CERRADO',
      expectMuted: true,
      expectSilent: true,
      expectAdminAlert: true,
      expectSosTitle: 'DUDA BARRILES',
      expectSosReason: 'Viña'
    }
  ]);

  // Variantes del mismo patrón (consulta/pregunta/ayuda), no solo "duda" o "3"
  await runCase('Barriles menú "tengo una consulta" → duda', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'tengo una consulta',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['duda'],
      expectNotIncludes: ['no entendí la opción']
    }
  ]);

  await runCase('Barriles menú "quiero preguntar" → duda', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'quiero preguntar',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['duda'],
      expectNotIncludes: ['no entendí la opción']
    }
  ]);

  await runCase('Seguimos con carrito vacío', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    { input: '1', expectState: 'BARRILES_RECOGIDA_PRODUCTOS' },
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

  await runCase('Barriles adelanta comuna sin sabor → reencauza (guarda comuna)', [
    { input: 'desechables', expectState: 'BARRILES_FILTRO_CANAL' },
    {
      input: 'Las Condes',
      expectState: 'BARRILES_FILTRO_CANAL',
      expectMuted: false,
      expectIncludes: ['pedido', 'precios', 'duda']
    }
  ]);
  {
    const s = getSession(SESSION_ID);
    assert(s.orderBuilder?.clientData?.location === 'Las Condes', 'soft-save comuna en intro barriles');
  }

  console.log('\n-- Barriles intro helpers: match pitch + prices-only --');
  {
    const {
      buildBarrilesMatchPitch,
      buildBarrilesMatchedCartReplies,
      buildBarrilesNoMatchGateReplies,
      buildBarrilesUnknownFlavorGateReplies,
      buildBarrilesPedidoReplies,
      buildBarrilesPreciosReplies,
      barrilesIntentMenuQuestion,
      looksLikeBarrilesFlavorInterest,
      looksLikeUnrecognizedFlavorAttempt,
      resolveBarrilesFlavorMatches
    } = await import('../src/logic/barriles-intro.js');
    const { wantsPricesOnlyBrowseClose } = await import('../src/logic/interruptions.js');
    const pitch = buildBarrilesMatchPitch('Mojito');
    assert(/Excelente elección/i.test(pitch), 'pitch match abre con Excelente elección');
    assert(/\*Mojito\*/.test(pitch), 'pitch nombra el cóctel');
    assert(/Ron Blanco|Menta/i.test(pitch), 'pitch usa ingredientes de datos.json');
    assert(/25 c[oó]cteles/i.test(pitch), 'pitch menciona rendimiento');
    assert(/\$/.test(pitch), 'pitch muestra precio');
    const matchReplies = buildBarrilesMatchedCartReplies(['Mojito'], { Mojito: 1 });
    assert(matchReplies.length === 1, 'con 1 match: una sola burbuja (pitch + OK, sin reenviar imagen)');
    assert(typeof matchReplies[0] === 'string' && /Excelente elección/i.test(matchReplies[0]), 'con match: pitch en texto');
    assert(/OK/i.test(matchReplies[0]), 'con match: incluye CTA OK');
    assert(!/barril_desechable_precios/.test(String(matchReplies[0])), 'con match: NO reenvía imagen catálogo');
    const multiReplies = buildBarrilesMatchedCartReplies(['Sangría', 'Ramazzotti Spritz'], { Sangría: 1, 'Ramazzotti Spritz': 1 });
    assert(/Sangría/.test(multiReplies[0]) && /Ramazzotti/.test(multiReplies[0]), 'con 2+ match: resumen nombra ambos');
    assert(multiReplies.length === 1, 'con 2+ match: una sola burbuja sin imagen');
    const pedidoReplies = buildBarrilesPedidoReplies();
    assert(pedidoReplies.length === 2, 'pedido: imagen + pregunta sabores');
    assert(/barril_desechable_precios/.test(String(pedidoReplies[0]?.file || '')), 'pedido: incluye catálogo');
    assert(/c[oó]ctel/i.test(String(pedidoReplies[1] || '')), 'pedido: pide sabores');
    const preciosReplies = buildBarrilesPreciosReplies();
    assert(preciosReplies.length === 2, 'precios: imagen + menú sí/no');
    assert(/hacer un pedido/i.test(String(preciosReplies[1] || '')), 'precios: pregunta si quiere pedir');
    assert(/Quiero hacer un pedido/i.test(barrilesIntentMenuQuestion()), 'menú intención tiene pedido');
    assert(/Tengo una duda/i.test(barrilesIntentMenuQuestion()), 'menú intención tiene duda');
    const { BARRILES_PEDIDO_SYNONYMS, BARRILES_PRECIOS_SYNONYMS } = await import('../src/logic/barriles-intro.js');
    assert(BARRILES_PEDIDO_SYNONYMS.test('ok quiero hacer una compra'), 'sinónimo: hacer una compra');
    assert(BARRILES_PEDIDO_SYNONYMS.test('quiero armar una orden'), 'sinónimo: armar una orden');
    assert(BARRILES_PEDIDO_SYNONYMS.test('quiero comprar'), 'sinónimo: quiero comprar');
    assert(!BARRILES_PEDIDO_SYNONYMS.test('mojito'), 'mojito ≠ sinónimo de pedido');
    assert(BARRILES_PRECIOS_SYNONYMS.test('valores'), 'sinónimo precios: valores');
    assert(BARRILES_PRECIOS_SYNONYMS.test('cuánto cuestan'), 'sinónimo precios: cuánto cuestan');
    assert(BARRILES_PRECIOS_SYNONYMS.test('vale'), 'sinónimo precios: vale');
    assert(BARRILES_PRECIOS_SYNONYMS.test('costo'), 'sinónimo precios: costo');
    assert(!BARRILES_PRECIOS_SYNONYMS.test('mojito'), 'mojito ≠ sinónimo de precios');
    const {
      formatBarrilesCompactCatalog,
      buildBarrilesUnknownFlavorTextReply,
      asksBarrilesCatalogList
    } = await import('../src/logic/barriles-intro.js');
    const compact = formatBarrilesCompactCatalog();
    assert(/\*Cócteles:\*/.test(compact) && /\*Combinados:\*/.test(compact) && /\*Mocktails:\*/.test(compact), 'lista compacta tiene 3 categorías');
    assert(/Mojito/.test(compact) && / \/ /.test(compact), 'lista compacta une con /');
    assert(/Sin Alcohol/.test(compact), 'mocktails se muestran como Sin Alcohol');
    assert(/no entendí tu pedido/i.test(buildBarrilesUnknownFlavorTextReply()), 'miss productos: no entendí pedido');
    assert(/más arriba/i.test(buildBarrilesUnknownFlavorTextReply()), 'miss productos: remite al catálogo previo');
    assert(asksBarrilesCatalogList('cuáles tienes'), 'detecta cuáles tienes');
    assert(asksBarrilesCatalogList('cuál es la lista'), 'detecta cuál es la lista');
    assert(asksBarrilesCatalogList('qué tienes disponible'), 'detecta qué tienes disponible');
    const { BARRILES_DUDA_SYNONYMS } = await import('../src/logic/barriles-intro.js');
    assert(BARRILES_DUDA_SYNONYMS.test('tengo una consulta'), 'sinónimo duda: tengo una consulta');
    assert(BARRILES_DUDA_SYNONYMS.test('quiero preguntar'), 'sinónimo duda: quiero preguntar');
    assert(BARRILES_DUDA_SYNONYMS.test('ayuda'), 'sinónimo duda: ayuda');
    assert(BARRILES_DUDA_SYNONYMS.test('hablar con un asesor'), 'sinónimo duda: hablar con un asesor');
    assert(!BARRILES_DUDA_SYNONYMS.test('mojito'), 'mojito ≠ sinónimo de duda');
    const noMatchReplies = buildBarrilesNoMatchGateReplies();
    assert(noMatchReplies.length === 2, 'sin match: imagen+caption + menú');
    assert(noMatchReplies[0]?.type === 'image' || noMatchReplies[0]?.file, 'sin match: primer bubble es imagen');
    assert(/👆/.test(String(noMatchReplies[0]?.caption || '')), 'sin match: caption con 👆');
    assert(/pedido/i.test(noMatchReplies[1]), 'sin match: segunda burbuja es el menú sí/no pedir');
    const unknownReplies = buildBarrilesUnknownFlavorGateReplies();
    assert(/catálogo|carta/i.test(String(unknownReplies[0]?.caption || '')), 'gate desconocido: remite a catálogo');
    assert(/pedido/i.test(unknownReplies[1]), 'fuera de carta: menú sí/no pedir');
    assert(looksLikeBarrilesFlavorInterest('tienes sangria?'), 'tienes sangria = interés sabor');
    assert(looksLikeBarrilesFlavorInterest('tienes piña colada?'), 'tienes X? = interés sabor (conjugación tienes)');
    assert(!looksLikeBarrilesFlavorInterest('hacen despacho a Maipú?'), 'despacho ≠ interés sabor');
    assert(looksLikeUnrecognizedFlavorAttempt('negroni'), 'nombre suelto fuera de carta');
    assert(looksLikeUnrecognizedFlavorAttempt('tienes piña colada?'), 'tienes X? fuera de carta');
    assert(looksLikeUnrecognizedFlavorAttempt('hay cosmopolitan'), 'hay X fuera de carta');
    assert(!looksLikeUnrecognizedFlavorAttempt('algo bien dulce y raro que no tienen'), 'preferencia genérica ≠ nombre desconocido');
    assert(!looksLikeUnrecognizedFlavorAttempt('hacen despacho?'), 'despacho ≠ nombre desconocido');
    assert(wantsPricesOnlyBrowseClose('solo quiero ver precios, no cotizo'), 'prices-only + no cotizo');
    assert(!wantsPricesOnlyBrowseClose('cuánto vale el mojito?'), 'precio de un cóctel ≠ cierre');

    // Bug reportado: nombrar 2 cócteles en el mismo mensaje debe reconocer AMBOS
    const twoMatches = await resolveBarrilesFlavorMatches('Sangría y Ramazzotti', 'contexto');
    assert(twoMatches.includes('Sangría') && twoMatches.includes('Ramazzotti Spritz'), 'detecta AMBOS cócteles en "Sangría y Ramazzotti"');
    // Comuna suelta (sin ninguna señal de sabor) nunca debe gatillar la IA / inventar un cóctel
    const comunaMatches = await resolveBarrilesFlavorMatches('Las Condes', 'contexto');
    assert(comunaMatches.length === 0, '"Las Condes" (comuna, sin señal de sabor) no dispara la IA ni inventa un cóctel');

    // Bug reportado: "sin alcohol" NO debe tratarse como sabor inventado (categoría
    // Mocktails real). Cubrimos el patrón general, no solo el string del reporte.
    assert(!looksLikeUnrecognizedFlavorAttempt('Sin alcohol'), '"sin alcohol" ≠ sabor inexistente (hay categoría Mocktails)');
    assert(!looksLikeUnrecognizedFlavorAttempt('no alcohólico'), '"no alcohólico" ≠ sabor inexistente');
    assert(!looksLikeUnrecognizedFlavorAttempt('cero alcohol'), '"cero alcohol" ≠ sabor inexistente');
    assert(!looksLikeUnrecognizedFlavorAttempt('mocktail'), '"mocktail" ≠ sabor inexistente');
    assert(!looksLikeUnrecognizedFlavorAttempt('mojito sin alcohol'), '"mojito sin alcohol" ≠ sabor inexistente');
  }

  console.log('\n-- Sin alcohol (Mocktails): detección + sugerencia --');
  {
    const {
      wantsNonAlcoholicOption,
      getMocktailFamilyOptions,
      getAllMocktailNames,
      isMocktailName
    } = await import('../src/logic/utils.js');
    const { getNonAlcoholicSuggestionReply } = await import('../src/views/templates.js');

    // Detección: variantes del mismo patrón (no solo "sin alcohol" literal)
    assert(wantsNonAlcoholicOption('Sin alcohol'), 'detecta "sin alcohol"');
    assert(wantsNonAlcoholicOption('mojito sin alcohol'), 'detecta sabor + "sin alcohol" en el mismo mensaje');
    assert(wantsNonAlcoholicOption('no alcohólico por favor'), 'detecta "no alcohólico"');
    assert(wantsNonAlcoholicOption('cero alcohol'), 'detecta "cero alcohol"');
    assert(wantsNonAlcoholicOption('0% alcohol'), 'detecta "0% alcohol"');
    assert(wantsNonAlcoholicOption('libre de alcohol'), 'detecta "libre de alcohol"');
    assert(wantsNonAlcoholicOption('mocktail'), 'detecta "mocktail" directo');
    assert(wantsNonAlcoholicOption('tienen mocktails?'), 'detecta "mocktails?"');
    assert(!wantsNonAlcoholicOption('sin problema, dame un mojito'), '"sin problema" NO dispara (sin palabra alcohol/mocktail)');
    assert(!wantsNonAlcoholicOption('algo bien fuerte con alcohol'), 'pedir CON alcohol no dispara la sugerencia sin alcohol');

    // Mapeo a la carta Mocktail: familia conocida (Mojito) vs sin familia (Aperol Spritz)
    const mojitoOptions = getMocktailFamilyOptions('Mojito');
    assert(mojitoOptions.includes('Mojito Mocktail') && mojitoOptions.length >= 4, 'Mojito → 4+ variantes Mocktail de esa familia');
    const sangriaOptions = getMocktailFamilyOptions('Sangría');
    assert(sangriaOptions.length === 1 && sangriaOptions[0] === 'Sangría Mocktail', 'Sangría → Sangría Mocktail');
    const aperolOptions = getMocktailFamilyOptions('Aperol Spritz');
    assert(aperolOptions.length === 0, 'Aperol Spritz sin familia Mocktail conocida → []');
    assert(getAllMocktailNames().every(isMocktailName), 'getAllMocktailNames devuelve solo nombres Mocktail');
    assert(getAllMocktailNames().length >= 6, 'carta Mocktails tiene las 6 variantes de datos.json');

    // Respuesta: con referencia (Mojito en carrito) sugiere la familia; sin referencia, la carta completa
    const withRef = getNonAlcoholicSuggestionReply(['Mojito']);
    assert(/Mojito Mocktail/.test(withRef) && !/Sangría Mocktail/.test(withRef), 'con Mojito en carrito: solo sugiere variantes Mojito Mocktail');
    const withoutRef = getNonAlcoholicSuggestionReply([]);
    assert(/Sangría Mocktail/.test(withoutRef) && /Mojito Mocktail/.test(withoutRef), 'sin referencia: muestra toda la carta Mocktails');
    const eventReply = getNonAlcoholicSuggestionReply(['Mojito'], undefined, { withLitersHint: true });
    assert(/litros/i.test(eventReply), 'en eventos (withLitersHint) pregunta también por litraje');
  }

  console.log('\n-- Barriles pedido: comuna → fecha → nombre → email → dirección → OK --');
  resetSession(SESSION_ID);
  {
    const {
      formatBarrilesShippingNote,
      resolveBarrilesPedidoPhase,
      buildBarrilesPedidoIntro
    } = await import('../src/logic/cot-barriles-contact.js');
    const { evaluateDeliveryLeadTime, exampleConcreteDateHint } = await import('../src/logic/cot-event-quote.js');
    const { findLocationByFuzzyMatch } = await import('../src/logic/utils.js');

    // Patrones: RM con precio vs región Blue Express por confirmar
    const rm = findLocationByFuzzyMatch('Providencia');
    assert(rm?.isRM === true, 'Providencia es RM');
    assert(/Región Metropolitana/i.test(formatBarrilesShippingNote(rm)), 'nota RM menciona Metropolitana');
    assert(/\$|Despacho/i.test(formatBarrilesShippingNote(rm)), 'nota RM menciona despacho');
    const region = findLocationByFuzzyMatch('Valparaíso');
    assert(region && region.isRM === false, 'Valparaíso no es RM');
    assert(/Blue Express|por confirmar/i.test(formatBarrilesShippingNote(region)), 'región → Blue Express / por confirmar');

    // Anticipación: hoy/mañana tooSoon; +3 días OK
    assert(evaluateDeliveryLeadTime('hoy', 2).tooSoon === true, 'hoy → tooSoon');
    assert(evaluateDeliveryLeadTime('mañana', 2).tooSoon === true, 'mañana → tooSoon');
    assert(evaluateDeliveryLeadTime(exampleConcreteDateHint(), 2).tooSoon === false, 'ejemplo +3 días OK');
    assert(evaluateDeliveryLeadTime('1 de enero de 2020', 2).ok === false, 'fecha pasada → no ok');

    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_RECOGIDA_PRODUCTOS';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: { name: null, date: null, location: null }
    };

    const stProd = statesMap.BARRILES_RECOGIDA_PRODUCTOS;
    const rOkCart = await stProd.validateAndProcess('ok', session);
    assert(rOkCart.nextState === 'BARRILES_RECOGIDA_DATOS', 'OK carrito → RECOGIDA_DATOS (pedido, no cotización)');
    assert(rOkCart.nextState !== 'BARRILES_REVISION_COTIZACION', 'no pasa por revisión de cotización');

    session.currentState = 'BARRILES_RECOGIDA_DATOS';
    const stDatos = statesMap.BARRILES_RECOGIDA_DATOS;
    const intro = buildBarrilesPedidoIntro(session);
    assert(/pedido/i.test(intro) && /comuna/i.test(intro), 'intro orienta a pedido y pide comuna');
    assert(!/cotizaci[oó]n/i.test(intro), 'intro no habla de cotización');
    assert(resolveBarrilesPedidoPhase(session) === 'comuna', 'fase inicial = comuna');

    const rComuna = await stDatos.validateAndProcess('Providencia', session);
    assert(rComuna.nextState === 'BARRILES_RECOGIDA_DATOS', 'tras comuna sigue en datos');
    assert(/fecha/i.test(String(rComuna.customReply || '')), 'tras comuna pide fecha');
    assert(/Metropolitana|Despacho/i.test(String(rComuna.customReply || '')), 'tras comuna RM explica despacho');
    assert(session.orderBuilder.clientData.location === 'Providencia', 'guarda comuna');

    const rFecha = await stDatos.validateAndProcess(exampleConcreteDateHint(), session);
    assert(/nombre y apellido/i.test(String(rFecha.customReply || '')), 'tras fecha pide nombre');
    assert(session.barrilesDateNeedsAvailabilityConfirm !== true, 'fecha con anticipación OK sin aviso');

    const rNombre = await stDatos.validateAndProcess('Ana Pérez', session);
    const tNombre = String(rNombre.customReply || '');
    assert(/correo.*confirmaci[oó]n|confirmaci[oó]n.*pedido/i.test(tNombre), 'tras nombre pide correo de confirmación');
    assert(!/Gracias,\s*\*Ana/i.test(tNombre), 'no antepone Gracias + nombre (redundante)');
    assert(session.contact?.firstName === 'Ana' && session.contact?.lastName === 'Pérez', 'guarda nombre');

    const rEmail = await stDatos.validateAndProcess('ana@test.cl', session);
    const tEmail = String(rEmail.customReply || '');
    assert(/direcci[oó]n de entrega/i.test(tEmail), 'tras email pide dirección de entrega');
    assert(!/Correo anotado/i.test(tEmail), 'no antepone Correo anotado (ya está en el chat)');
    assert(session.contact?.email === 'ana@test.cl', 'guarda email');

    const rAddr = await stDatos.validateAndProcess('Los Alerces 123, Depto 456', session);
    assert(rAddr.nextState === 'BARRILES_CONFIRMAR_COMPRA', 'dirección → CONFIRMAR_COMPRA');
    const summaryText = replyToText(rAddr.customReplies || rAddr.customReply);
    assert(/Resumen de tu pedido|👤 \*Datos:\*/i.test(summaryText), 'resumen de pedido');
    assert(/Mojito|🍹 \*Producto\*/i.test(summaryText), 'resumen incluye productos');
    assert(/TOTAL|Subtotal/i.test(summaryText), 'resumen incluye totales del pedido');
    assert(!/\*Costos\*/i.test(summaryText), 'no usa título Costos');
    assert(/OK/i.test(summaryText) && /modificar/i.test(summaryText), 'pide OK o modificar');
    assert(/Los Alerces 123/i.test(String(session.contact?.address || '')), 'guarda dirección');

    session.currentState = 'BARRILES_CONFIRMAR_COMPRA';
    const stConfirm = statesMap.BARRILES_CONFIRMAR_COMPRA;
    const rConfirm = await stConfirm.validateAndProcess('ok', session);
    assert(rConfirm.nextState === 'CERRADO', 'OK cierra barriles (legacy sin API)');
    assert(rConfirm.mute === true, 'mute al cerrar pedido barriles');
  }

  console.log('\n-- Barriles pedido: fecha urgente avisa disponibilidad; región Blue Express --');
  resetSession(SESSION_ID);
  {
    const { exampleConcreteDateHint } = await import('../src/logic/cot-event-quote.js');
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_RECOGIDA_DATOS';
    session.userIntent = 'BARRILES';
    session.barrilesPedidoPhase = 'comuna';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: { name: null, date: null, location: null }
    };

    const stDatos = statesMap.BARRILES_RECOGIDA_DATOS;
    const rRegion = await stDatos.validateAndProcess('Valparaíso', session);
    assert(/Blue Express|por confirmar/i.test(String(rRegion.customReply || '')), 'Valparaíso → Blue Express');
    assert(/fecha/i.test(String(rRegion.customReply || '')), 'luego pide fecha');

    const rSoon = await stDatos.validateAndProcess('mañana', session);
    assert(/confirmar disponibilidad/i.test(String(rSoon.customReply || '')), 'fecha urgente → aviso disponibilidad');
    assert(session.barrilesDateNeedsAvailabilityConfirm === true, 'flag disponibilidad');
    assert(/nombre y apellido/i.test(String(rSoon.customReply || '')), 'igual avanza a nombre');

    // Completar resto y confirmar
    await stDatos.validateAndProcess('Felipe Ramirez', session);
    await stDatos.validateAndProcess('felipe@test.cl', session);
    const rAddr = await stDatos.validateAndProcess('Calle Falsa 123', session);
    assert(rAddr.nextState === 'BARRILES_CONFIRMAR_COMPRA', 'completa → confirmar');
    assert(/confirmaremos disponibilidad/i.test(replyToText(rAddr.customReplies || rAddr.customReply)), 'resumen menciona disponibilidad');

    session.currentState = 'BARRILES_CONFIRMAR_COMPRA';
    const rConfirm = await statesMap.BARRILES_CONFIRMAR_COMPRA.validateAndProcess('1', session);
    assert(rConfirm.nextState === 'CERRADO', 'confirmar cierra tras fecha urgente');
    assert(rConfirm.mute === true, 'mute al cerrar');
    // exampleConcreteDateHint solo para no dejar import muerto si el linter lo marca
    assert(typeof exampleConcreteDateHint() === 'string', 'hint fecha usable');
  }

  console.log('\n-- Barriles pedido: corrección de dato anterior (fecha en fase nombre) --');
  resetSession(SESSION_ID);
  {
    const { tryApplyBarrilesPedidoPriorCorrection } = await import('../src/logic/cot-barriles-contact.js');
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_RECOGIDA_DATOS';
    session.userIntent = 'BARRILES';
    session.barrilesPedidoPhase = 'nombre';
    session.orderBuilder = {
      type: 'desechable',
      products: { Mojito: 1 },
      extras: {},
      clientData: {
        name: null,
        date: '10/08/2026',
        location: 'Las Condes',
        locationData: { name: 'Las Condes', isRM: true, deliveryCost: { desechable: 5000 } }
      }
    };
    session.contact = {};

    // Patrón: corrección explícita de fecha mientras pedimos nombre
    const helper = tryApplyBarrilesPedidoPriorCorrection(
      'me equivoque es para el 13 de agosto',
      session,
      'nombre'
    );
    assert(helper?.field === 'fecha', 'helper: detecta corrección de fecha');
    assert(/13\/08\/2026|13 de agosto/i.test(String(helper?.ack || '')), 'helper: ack con fecha nueva');
    assert(/13\/08\/2026|13 de agosto/i.test(String(session.orderBuilder.clientData.date)), 'helper: guarda fecha');

    // Reset fecha y probar vía estado completo
    session.orderBuilder.clientData.date = '10/08/2026';
    session.barrilesPedidoPhase = 'nombre';
    const stDatos = statesMap.BARRILES_RECOGIDA_DATOS;
    const rFix = await stDatos.validateAndProcess('me equivoque es para el 13 de agosto', session);
    assert(rFix.nextState === 'BARRILES_RECOGIDA_DATOS', 'sigue en datos');
    assert(/corregí la entrega/i.test(String(rFix.customReply || '')), 'ack de corrección');
    assert(/nombre y apellido/i.test(String(rFix.customReply || '')), 're-pide la fase actual (nombre)');
    assert(!/Necesito \*nombre/i.test(String(rFix.customReply || '')), 'no trata el mensaje como nombre fallido');

    // Nombre real sigue funcionando
    const rName = await stDatos.validateAndProcess('Felipe Ramirez', session);
    assert(/correo|confirmaci[oó]n/i.test(String(rName.customReply || '')), 'tras nombre pide correo');

    // Corregir comuna en fase email (variante hermana)
    session.barrilesPedidoPhase = 'email';
    const rComuna = await stDatos.validateAndProcess('mejor Providencia', session);
    assert(/corregí la comuna/i.test(String(rComuna.customReply || '')), 'corrige comuna en fase email');
    assert(/correo|confirmaci[oó]n/i.test(String(rComuna.customReply || '')), 're-pide email');
    assert(session.orderBuilder.clientData.location === 'Providencia', 'guarda Providencia');
  }

  await runCase('Eventos keyword', [
    {
      input: 'evento',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Cocktails on Tap', 'tipo de evento'],
      expectNotIncludes: ['te guiaré', 'Soy el', 'asistente virtual']
    }
  ]);

  await runCase('Eventos logística: próximo año + lugar no sé → confirmar', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    { input: 'matrimonio', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    { input: '50', expectState: 'EVENTOS_RECOGIDA_DATOS', expectIncludes: ['fecha', 'comuna'] },
    {
      input: 'es para el proximo año, el lugar aun no lo se',
      expectState: 'EVENTOS_CONFIRMAR_DATOS',
      expectIncludes: ['50', 'proximo año', 'Por confirmar']
    }
  ]);

  await runCase('Eventos info-only → web', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'solo quiero cotizar',
      expectState: 'CERRADO',
      expectMuted: true,
      expectIncludes: ['aún no tienes un evento', 'Cotizar', 'https://www.cocktailsontap.cl/']
    }
  ]);

  await runCase('Eventos skip tipo (no sé) → invitados → resumen Por confirmar', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'aún no lo sé',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectIncludes: ['por confirmar', 'invitados'],
      expectNotIncludes: ['Cumpleaños', 'tipo de evento estás']
    },
    {
      input: '60',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectIncludes: ['fecha', 'comuna']
    },
    {
      input: 'ok',
      expectState: 'EVENTOS_CONFIRMAR_DATOS',
      expectIncludes: ['60', 'Por confirmar']
    }
  ]);

  await runCase('Eventos tipo abierto (texto típico → invitados, sin menú numérico)', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'cumpleaños',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectIncludes: ['Cumpleaños', 'invitados', 'mejor formato'],
      expectNotIncludes: ['Escribe el número', 'fecha', 'comuna']
    }
  ]);

  await runCase('Eventos progresivo: tipo → invitados → skip logística → confirmar', [
    { input: 'evento', expectState: 'EVENTOS_RECOGIDA_DATOS' },
    {
      input: 'matrimonio',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectIncludes: ['Matrimonio', 'invitados', 'mejor formato'],
      expectNotIncludes: ['Escribe el número', 'fecha']
    },
    {
      input: '80',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectIncludes: ['fecha', 'comuna', 'después']
    },
    {
      input: 'ok',
      expectState: 'EVENTOS_CONFIRMAR_DATOS',
      expectIncludes: ['80', 'Matrimonio', 'Por confirmar']
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
        'Escribe el número de la opción que prefieres'
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
      expectIncludes: ['evalu', 'Valparaíso', 'Coquimbo', 'cotiz'],
      expectNotIncludes: ['Bienvenidos', 'no hay problema', 'Sobre *', 'queda *fuera']
    }
  ]);

  await runCase('Cobertura Viña al inicio: evaluar, no afirmar zona fija', [
    {
      input: 'evento',
      expectState: 'EVENTOS_RECOGIDA_DATOS'
    },
    {
      input: '¡Hola! Llegan. Viña Del Mar?',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Fuera de la RM', 'evalu', 'Valparaíso', 'Coquimbo', 'tipo de evento'],
      expectNotIncludes: ['Bienvenidos', 'Soy asistente virtual', 'Sobre *Viña', 'queda *fuera']
    }
  ]);

  await runCase('Cobertura RM: confirma todas las comunas', [
    {
      input: 'evento',
      expectState: 'EVENTOS_RECOGIDA_DATOS'
    },
    {
      input: 'llegan a Providencia?',
      expectState: 'EVENTOS_RECOGIDA_DATOS',
      expectMuted: false,
      expectIncludes: ['Providencia', 'Metropolitana', 'tipo de evento'],
      expectNotIncludes: ['fuera de la Región', 'Bienvenidos']
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

  console.log('\n-- Eventos menú: cortesía no inventa cócteles (ni Barriles) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Muro de Coctelería';
    session.guests = 40;
    session.orderBuilder = { type: 'muro', products: {}, extras: {} };
    // Contexto típico: el bot acabó de mostrar rendimiento + ej. "5L Mojito…"
    session.history = {
      turns: [{
        role: 'model',
        text: 'Para orientarte…\n\n¿Qué cócteles te gustaría incluir?\n_(ej: 5L Mojito y 10L Aperol)_'
      }]
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r = await st.validateAndProcess('Gracias por la información', session);
    assert(r.success === false, 'cortesía en menú eventos → success false (sin inventar carrito)');
    assert(Object.keys(session.orderBuilder.products).length === 0, 'carrito eventos sigue vacío');

    const r2 = await st.validateAndProcess('perfecto gracias', session);
    assert(r2.success === false, 'perfecto gracias → sin productos');
  }
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'BARRILES_RECOGIDA_PRODUCTOS';
    session.userIntent = 'BARRILES';
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { date: '08/08/2026', location: 'Providencia' }
    };
    session.history = {
      turns: [{ role: 'model', text: '¿Qué sabor? _(ej: 1 mojito y 1 sangría)_' }]
    };
    const st = statesMap.BARRILES_RECOGIDA_PRODUCTOS;
    const r = await st.validateAndProcess('Gracias por la información', session);
    assert(r.success === false, 'cortesía en menú barriles → success false');
    assert(Object.keys(session.orderBuilder.products).length === 0, 'carrito barriles sigue vacío');
    const shortEmpty = typeof st.shortQuestion === 'function' ? st.shortQuestion(session) : st.shortQuestion;
    assert(/sabor/i.test(String(shortEmpty)) && !/Todo bien con el pedido/i.test(String(shortEmpty)),
      'sin carrito: shortQuestion pide sabor (no OK)');
    session.orderBuilder.products = { Mojito: 1 };
    const shortFull = typeof st.shortQuestion === 'function' ? st.shortQuestion(session) : st.shortQuestion;
    assert(/Todo bien con el pedido/i.test(String(shortFull)) && !/Qué sabor/i.test(String(shortFull)),
      'con carrito: shortQuestion pide OK (no sabor otra vez)');
  }

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
    assert(/5L Mojito/.test(t1), `Mojito queda en 5L (formato litros)`);
    assert(t1.includes('Sangría') || t1.includes('Sangria'), `incluye Sangría`);
    assert(/15L Sangr[ií]a \(10L \+ 5L\)/.test(t1), `15L Sangría se muestra como 10L+5L`);
    assert(!/10L Mojito/.test(t1), `no duplica Mojito al partir la Sangría`);
    const totalMatch = t1.match(/\*Litros:\*\s*(\d+)L/i);
    assert(totalMatch && Number(totalMatch[1]) === 20, `total 5+15 = 20L`);
    assert(/≈\s*\*100\*\s*cócteles/i.test(t1), `20L muestra ≈ 100 cócteles`);
  }

  console.log('\n-- Eventos: "Quitar" solo pide qué eliminar (no avanza) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Mojito::10L': { name: 'Mojito', quantity: 2, litrage: '10L' },
        'Aperol Spritz::10L': { name: 'Aperol Spritz', quantity: 2, litrage: '10L' }
      },
      extras: {}
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('Quitar', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(r1.nextState === 'EVENTOS_ELECCION_MENU', `Quitar solo no avanza a cotización`);
    assert(/qu[eé] quieres quitar/i.test(t1), `pregunta qué quitar`);
    assert(/20L Mojito \(2×10L\)/.test(t1), `lista pedido en litros al pedir qué quitar`);
    assert(Object.keys(session.orderBuilder.products).length === 2, `Quitar solo no borra el carrito`);
  }

  console.log('\n-- Eventos: "quita el aperol" elimina (no agrega) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Mojito::10L': { name: 'Mojito', quantity: 1, litrage: '10L' },
        'Aperol Spritz::5L': { name: 'Aperol Spritz', quantity: 1, litrage: '5L' },
        'Aperol Spritz::10L': { name: 'Aperol Spritz', quantity: 1, litrage: '10L' }
      },
      extras: {}
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('quita el aperol', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(/Quit[eé].*Aperol/i.test(t1), `confirma que quitó Aperol`);
    assert(/10L Mojito/.test(t1), `conserva Mojito`);
    assert(!/Aperol Spritz/.test(t1) || /Quit[eé]/i.test(t1), `Aperol fuera del listado de pedido`);
    assert(!session.orderBuilder.products['Aperol Spritz::5L'], `borra Aperol 5L`);
    assert(!session.orderBuilder.products['Aperol Spritz::10L'], `borra Aperol 10L`);
    assert(session.orderBuilder.products['Mojito::10L'], `Mojito sigue`);

    // Misma frase sin Aperol en carrito → avisar, NO agregar
    const r2 = await st.validateAndProcess('quita el aperol', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(/No tienes/i.test(t2), `si no está, avisa en vez de sumar`);
    assert(!session.orderBuilder.products['Aperol Spritz::5L'], `no re-agrega Aperol`);
    assert(!/Te confirmo los cócteles/i.test(t2), `no usa copy de agregado`);
  }

  console.log('\n-- Eventos: rechazo natural "no quiero / sin" elimina --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Caipiriña::10L': { name: 'Caipiriña', quantity: 2, litrage: '10L' },
        'Caipiriña::5L': { name: 'Caipiriña', quantity: 1, litrage: '5L' }
      },
      extras: {}
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('no quiero la caipiriña', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(/Quit[eé].*Caipiri/i.test(t1), `"no quiero la caipiriña" confirma quitar`);
    assert(!session.orderBuilder.products['Caipiriña::10L'], `borra Caipiriña 10L`);
    assert(!session.orderBuilder.products['Caipiriña::5L'], `borra Caipiriña 5L (no deja 5L)`);
    assert(!/5L Caipiri/i.test(t1) || /Quit[eé]/i.test(t1), `no deja 5L como "actualización"`);
    assert(Object.keys(session.orderBuilder.products).length === 0, `carrito vacío tras rechazo`);

    // Variantes hermanas
    session.orderBuilder.products = {
      'Mojito::10L': { name: 'Mojito', quantity: 1, litrage: '10L' },
      'Aperol Spritz::10L': { name: 'Aperol Spritz', quantity: 1, litrage: '10L' }
    };
    const r2 = await st.validateAndProcess('sin el aperol', session);
    assert(!session.orderBuilder.products['Aperol Spritz::10L'], `"sin el aperol" elimina`);
    assert(session.orderBuilder.products['Mojito::10L'], `conserva Mojito`);

    session.orderBuilder.products = {
      'Sangría::10L': { name: 'Sangría', quantity: 1, litrage: '10L' }
    };
    const r3 = await st.validateAndProcess('no me gusta la sangria', session);
    assert(!session.orderBuilder.products['Sangría::10L'], `"no me gusta la sangria" elimina`);
  }

  console.log('\n-- Eventos: "cuales tienes?" lista categorías sin FAQ --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = { type: 'dispensador', products: {}, extras: {} };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('Cuales tienes?', session);
    assert(Array.isArray(r1.customReplies) && r1.customReplies.length === 2, `"cuales tienes" → 2 burbujas`);
    const catalog = String(r1.customReplies[0] || '');
    const followUp = String(r1.customReplies[1] || '');
    assert(/CLÁSICOS/.test(catalog) && /COMBINADOS/.test(catalog), `categorías en burbuja 1`);
    assert(/\n\n🥃/.test(catalog), `categorías separadas con línea en blanco`);
    assert(/- Pisco Sour/.test(catalog) && /- Mojito/.test(catalog), `nombres con viñeta`);
    assert(!/amplia y variada/i.test(catalog), `no copy FAQ/LLM`);
    assert(/qu[eé] c[oó]cteles te gustar[ií]a/i.test(followUp), `burbuja 2 re-pregunta pedido`);
  }

  console.log('\n-- Eventos: pregunta sabores lista sin mutar carrito --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Mojito Frambuesa::10L': { name: 'Mojito Frambuesa', quantity: 2, litrage: '10L' },
        'Mojito Frambuesa::5L': { name: 'Mojito Frambuesa', quantity: 1, litrage: '5L' },
        'Sangría::10L': { name: 'Sangría', quantity: 1, litrage: '10L' },
        'Sangría::5L': { name: 'Sangría', quantity: 1, litrage: '5L' }
      },
      extras: {}
    };
    // Historial tipo carrito: no debe auto-resolver "Mojito Frambuesa"
    session.history = {
      turns: [{
        role: 'model',
        text: `🍹 Te confirmo los cócteles seleccionados:\n\n- 25L Mojito Frambuesa (2×10L + 5L): $314.970\n- 15L Sangría (10L + 5L): $179.980\n`
      }]
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const beforeKeys = Object.keys(session.orderBuilder.products).sort().join('|');
    const r1 = await st.validateAndProcess('que mojito sabor tienes?', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(/Mojito Maracuy/i.test(t1) && /Frambuesa/i.test(t1) && /Mango/i.test(t1), `lista sabores de Mojito`);
    assert(/10L/i.test(t1), `invita a elegir con litros`);
    assert(!/actualic[eé] tu pedido|Te confirmo los cócteles/i.test(t1), `no muta/confirma carrito`);
    const afterKeys = Object.keys(session.orderBuilder.products).sort().join('|');
    assert(beforeKeys === afterKeys, `carrito intacto tras pregunta de sabores`);
    assert(session.orderBuilder.products['Mojito Frambuesa::10L']?.quantity === 2, `conserva 25L Frambuesa`);
  }

  console.log('\n-- Eventos: "saca X" no confunde familia (Mojito vs Mojito Frambuesa) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Mojito::10L': { name: 'Mojito', quantity: 2, litrage: '10L' },
        'Mojito::5L': { name: 'Mojito', quantity: 1, litrage: '5L' },
        'Mojito Frambuesa::10L': { name: 'Mojito Frambuesa', quantity: 1, litrage: '10L' },
        'Mojito Frambuesa::5L': { name: 'Mojito Frambuesa', quantity: 1, litrage: '5L' }
      },
      extras: {}
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('saca el mojito frambuesa', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(/Quit[eé].*Mojito Frambuesa/i.test(t1), `"saca el mojito frambuesa" confirma quitar la variante`);
    assert(!session.orderBuilder.products['Mojito Frambuesa::10L'], `borra Mojito Frambuesa 10L`);
    assert(!session.orderBuilder.products['Mojito Frambuesa::5L'], `borra Mojito Frambuesa 5L`);
    assert(session.orderBuilder.products['Mojito::10L'], `NO toca el Mojito base (10L)`);
    assert(session.orderBuilder.products['Mojito::5L'], `NO toca el Mojito base (5L)`);
    const remainingCartBlock = t1.split('Ahora tu pedido incluye:')[1] || '';
    assert(!/Frambuesa/i.test(remainingCartBlock), `el pedido restante ya no incluye Frambuesa`);

    // Caso inverso: pedir el base no debe tocar la variante
    session.orderBuilder.products = {
      'Mojito::10L': { name: 'Mojito', quantity: 2, litrage: '10L' },
      'Mojito Frambuesa::10L': { name: 'Mojito Frambuesa', quantity: 1, litrage: '10L' }
    };
    const r2 = await st.validateAndProcess('saca el mojito', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(!session.orderBuilder.products['Mojito::10L'], `"saca el mojito" borra el Mojito base`);
    assert(session.orderBuilder.products['Mojito Frambuesa::10L'], `"saca el mojito" NO toca Mojito Frambuesa`);
    assert(/10L Mojito Frambuesa/i.test(t2), `Frambuesa sigue en el resumen`);
  }

  // Mismo patrón que en Barriles (sistémico, no un parche puntual de Barriles):
  // "sin alcohol" en Eventos con Mojito en el carrito → sugiere la familia Mojito
  // Mocktail; confirmar el nombre exacto lo agrega normalmente (con litraje).
  console.log('\n-- Eventos: "sin alcohol" sugiere Mocktail de la misma familia --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: { 'Mojito::10L': { name: 'Mojito', quantity: 1, litrage: '10L' } },
      extras: {}
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('sin alcohol', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(/Mojito Mocktail/.test(t1), 'sugiere Mojito Mocktail (misma familia que el Mojito del carrito)');
    assert(!/Sangría Mocktail/.test(t1), 'no mezcla otras familias Mocktail sin relación');
    assert(r1.nextState === 'EVENTOS_ELECCION_MENU', 'se queda en el mismo paso (no muta el carrito solo)');
    assert(session.orderBuilder.products['Mojito::10L'], 'no toca el Mojito con alcohol ya en el carrito');

    const r2 = await st.validateAndProcess('10L Mojito Mocktail', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(/Mojito Mocktail/.test(t2) && /10L/.test(t2), 'confirmar el nombre exacto lo agrega al carrito (con litraje)');
    assert(session.orderBuilder.products['Mojito Mocktail::10L'], 'Mojito Mocktail queda en el carrito');
  }

  console.log('\n-- Eventos: re-pedir litros reemplaza (no suma) --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_MENU';
    session.userIntent = 'EVENTOS';
    session.eventoFormato = 'Dispensador Portátil';
    session.guests = 60;
    session.orderBuilder = {
      type: 'dispensador',
      products: {
        'Mojito::10L': { name: 'Mojito', quantity: 2, litrage: '10L' },
        'Aperol Spritz::10L': { name: 'Aperol Spritz', quantity: 2, litrage: '10L' }
      },
      extras: {}
    };

    const st = statesMap.EVENTOS_ELECCION_MENU;
    const r1 = await st.validateAndProcess('20 L mojito. 10 L aperol', session);
    const t1 = typeof r1.customReply === 'string' ? r1.customReply : '';
    assert(/20L Mojito \(2×10L\)/.test(t1), `deja Mojito en 20L (no 40L)`);
    assert(/10L Aperol/.test(t1), `deja Aperol en 10L (no 30L)`);
    assert(!/40L Mojito/.test(t1) && !/30L Aperol/.test(t1), `no suma encima del carrito`);
    const liters = t1.match(/\*Litros:\*\s*(\d+)L/i);
    assert(liters && Number(liters[1]) === 30, `total tras reemplazo = 30L`);

    // Agregar explícito sí suma
    const r2 = await st.validateAndProcess('agrega 5L sangria', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(/5L Sangr[ií]a/.test(t2), `agrega Sangría nueva`);
    assert(/20L Mojito/.test(t2), `conserva Mojito al agregar otro`);
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
    assert(/5L Mojito/.test(t1), `mojito 5L entra como 5 litros`);

    // El último mensaje del bot lista el carrito; eso no debe leerse como menú de opciones
    session.history = { turns: [{ role: 'model', text: t1 }] };
    const r2 = await st.validateAndProcess('5 sangria', session);
    const t2 = typeof r2.customReply === 'string' ? r2.customReply : '';
    assert(/5L Sangr[ií]a/.test(t2), `5 sangria agrega Sangría como 5 litros`);
    assert(/5L Mojito/.test(t2), `conserva el Mojito`);
    assert(!/10L Mojito/.test(t2), `5 sangria no vuelve a sumar el Mojito del carrito`);
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
    assert(/10L Mojito \(2×5L\)/.test(t2), `opción 1 anota 2 barriles de 5L (=10L)`);

    // 2️⃣ = prefiere indicar el tamaño, y luego lo responde
    await st.validateAndProcess('3 sangria', session);
    const r3 = await st.validateAndProcess('2', session);
    const t3 = typeof r3.customReply === 'string' ? r3.customReply : '';
    assert(/tama[nñ]o de barril/i.test(t3), `opción 2 pide el tamaño`);
    const r4 = await st.validateAndProcess('10L', session);
    const t4 = typeof r4.customReply === 'string' ? r4.customReply : '';
    assert(/10L Sangr[ií]a/.test(t4), `tras elegir tamaño, agrega Sangría 10L`);
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

  console.log('\n-- Eventos formato: precio de cócteles no mezcla Desechable --');
  resetSession(SESSION_ID);
  {
    const session = getSession(SESSION_ID);
    session.currentState = 'EVENTOS_ELECCION_FORMATO';
    session.userIntent = 'EVENTOS';
    session.guests = 70;
    session.celebrationType = 'Cumpleaños';
    saveSession(SESSION_ID, session);

    const reply = await processMessage(SESSION_ID, 'Valor de los cocteles');
    const text = typeof reply === 'string'
      ? reply
      : Array.isArray(reply)
        ? reply.map((p) => (typeof p === 'string' ? p : p?.caption || '')).join('\n')
        : String(reply || '');
    const after = getSession(SESSION_ID);
    assert(after.currentState === 'EVENTOS_ELECCION_FORMATO', `sigue en ELECCION_FORMATO`);
    assert(/Dispensador|Muro/i.test(text), `menciona Dispensador/Muro`);
    assert(/cocktailsontap\.cl\/eventos/i.test(text), `ofrece web eventos`);
    assert(!/desechable/i.test(text), `no mezcla Barriles Desechables`);
    assert(!/3 formatos|tres formatos|elige.*desechable/i.test(text), `no pide cotizar desechable`);
    assert(/1️⃣|Dispensador/i.test(text), `re-pregunta el menú de formato`);
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
      expectIncludes: ['no te entendí', 'tipo de evento']
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
    assert(String(rOk.customReply || '').includes('email') || String(rOk.customReply || '').includes('correo'), 'pide email al confirmar');
    assert(
      String(rOk.customReply || '').toLowerCase().includes('copia formal')
        || String(rOk.customReply || '').toLowerCase().includes('correo'),
      'explica copia formal / correo'
    );

    session.currentState = 'EVENTOS_DATOS_CONTACTO';
    const stContact = statesMap.EVENTOS_DATOS_CONTACTO;
    const rContact = await stContact.validateAndProcess('Ana Pérez, ana@test.cl', session);
    assert(rContact.nextState === 'EVENTOS_CONFIRMAR_ENVIO', 'contacto completo → CONFIRMAR_ENVIO');
    const envioText = replyToText(rContact.customReplies || rContact.customReply);
    assert(
      /Datos para enviarte la cotizaci[oó]n/i.test(envioText),
      'muestra confirmación liviana de contacto'
    );
    assert(!/10L Mojito|Subtotal|TOTAL/i.test(envioText), 'no re-lista el pedido completo');
    assert(/OK/i.test(envioText), 'pide OK para crear');

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
    assert(/15\/12\/\d{4}/.test(String(session.date || '')), 'guarda "15 diciembre" como DD/MM/YYYY');
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
    // Primer agregados → customReplies (pitch); siguientes → customReply
    const t = Array.isArray(r.customReplies)
      ? r.customReplies.map((p) => (typeof p === 'string' ? p : (p?.caption || ''))).join('\n')
      : String(r.customReply || '');
    assert(session.orderBuilder.products.Mojito >= 1, 'suma Mojito con multi-intent');
    assert(/despacho|Metropolitana|encomienda|Chile/i.test(t), 'responde duda de despacho junto al carrito');
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
    assert(/cobertura|Metropolitana|Valpara[ií]so|evalu/i.test(t), 'responde despacho en eventos multi-intent');
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

  console.log('\n-- helpers: asksDeliveryOrDispatchQuestion + cobertura Eventos --');
  {
    const {
      asksDeliveryOrDispatchQuestion,
      asksCoverageAreaQuestion,
      buildEventosCoverageReply,
      resolvePlaceForCoverage,
      stripDeliveryQuestionForCart,
      parseBarrilesProductsProgrammatic
    } = await import('../src/logic/eventos-helpers.js');
    assert(asksDeliveryOrDispatchQuestion('2 mojitos, ¿hacen despacho a Maipú?'), 'detecta despacho+pedido');
    assert(asksDeliveryOrDispatchQuestion('van a la serena?'), 'detecta cobertura');
    assert(asksCoverageAreaQuestion('¡Hola! Llegan. Viña Del Mar?'), 'detecta llegan + Viña');
    assert(asksCoverageAreaQuestion('llegan a Temuco?'), 'detecta Temuco vía datos.json');
    assert(!asksCoverageAreaQuestion('matrimonio'), 'tipo de evento ≠ cobertura');
    assert(!asksDeliveryOrDispatchQuestion('2 mojitos'), 'pedido solo no es despacho');

    const placeVina = resolvePlaceForCoverage('¡Hola! Llegan. Viña Del Mar?');
    assert(placeVina?.name === 'Viña del Mar' && placeVina?.isRM === false, 'Viña fuera de RM vía datos.json');
    const placeProv = resolvePlaceForCoverage('llegan a Providencia?');
    assert(placeProv?.isRM === true, 'Providencia es RM');

    const msgVina = buildEventosCoverageReply('¡Hola! Llegan. Viña Del Mar?');
    assert(/^Fuera de la RM/i.test(msgVina) && /evalu/i.test(msgVina), 'copy fuera RM arranca corto');
    assert(!/Sobre \*/i.test(msgVina) && !/queda \*fuera/i.test(msgVina), 'sin preámbulo tipo pensamiento');
    assert(/Valpara[ií]so/i.test(msgVina) && /Coquimbo/i.test(msgVina), 'menciona experiencia Valpo/Coquimbo');
    const msgRm = buildEventosCoverageReply('van a Las Condes?');
    assert(/Metropolitana/i.test(msgRm) && !/Fuera de la RM/i.test(msgRm), 'RM confirma cobertura');

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
      celebrationType: 'Matrimonio',
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
    assert(!/Ejemplo:/i.test(msgE), 'nudge sin tip "Ejemplo:" duplicado');
    assert(!/_\(ej:/i.test(msgE), 'nudge sin línea _(ej:…)_');
    assert(!/Prefieres ver todo con calma/i.test(msgE), 'CTA web suave (sin copy viejo)');

    // celebration: pregunta limpia del tipo de evento
    const msgCel = buildNudgeMessage({
      ...eventosSession,
      celebrationType: null,
      guests: null
    }, baseCfg);
    assert(/tipo de evento/i.test(msgCel), 'nudge celebration pide tipo de evento');
    assert(!/Ejemplo:/i.test(msgCel) && !/_\(ej:/i.test(msgCel), 'celebration sin ejemplo doble');
    assert(/Queda poquito|Seguimos/i.test(msgCel), 'celebration con gancho');

    markNudgeSent(eventosSession, okEventos.stallKey, now);
    const blocked = evaluateNudgeEligibility(eventosSession, baseCfg, now);
    assert(blocked.ok === false && blocked.reason === 'already_sent', 'segundo nudge bloqueado por flag');
    assert(eventosSession.isMuted !== true, 'nudge NO mutea la sesión');

    clearNudgeFlag(eventosSession);
    const again = evaluateNudgeEligibility(eventosSession, baseCfg, now);
    assert(again.ok === true, 'tras clearNudgeFlag vuelve a ser elegible');

    // Barriles: menú de intención pendiente en pitch
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
    assert(okBar.ok === true, 'barriles sin elegir intención → elegible');
    assert(okBar.stallKey === buildStallKey('BARRILES_FILTRO_CANAL', 'intent'), 'stallKey barriles=intent');
    const msgB = buildNudgeMessage(barrilesSession, baseCfg);
    assert(/Barriles Desechables/i.test(msgB), 'copy retoma barriles');
    assert(/pedido|precios|duda/i.test(msgB), 'barriles pide menú intención');
    assert(/cocktailsontap\.cl\/barriles/i.test(msgB), 'copy web barriles');
    assert(!/Ejemplo:/i.test(msgB) && !/_\(ej:/i.test(msgB), 'barriles sin ejemplo duplicado');

    // Barriles recogida datos: solo falta fecha
    const msgBDate = buildNudgeMessage({
      ...barrilesSession,
      currentState: 'BARRILES_RECOGIDA_DATOS',
      barrilesPedidoPhase: 'fecha',
      orderBuilder: { clientData: { date: null, location: 'Providencia' } }
    }, baseCfg);
    assert(/fecha.*entrega|entrega/i.test(msgBDate), 'barriles parcial → solo fecha');
    assert(!/comuna/i.test(msgBDate), 'barriles parcial no pide comuna otra vez');

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

console.log('\n-- CRM Interesado: Eventos al confirmar→formato; Barriles al cotizar --');
{
  const { notifyCrmOnBotStateChange } = await import('../src/logic/cot-crm-sync.js');

  const s1 = { userIntent: 'EVENTOS', guests: 50, waLabelClientePotencialApplied: false };
  assert(
    notifyCrmOnBotStateChange(s1, 'EVENTOS_RECOGIDA_DATOS', 'EVENTOS_CONFIRMAR_DATOS') === false,
    'Eventos: salir de recogida NO marca Interesado'
  );

  const s2 = { userIntent: 'EVENTOS', guests: 50, celebrationType: 'Matrimonio', waLabelClientePotencialApplied: false };
  assert(
    notifyCrmOnBotStateChange(s2, 'EVENTOS_CONFIRMAR_DATOS', 'EVENTOS_ELECCION_FORMATO') === true,
    'Eventos: confirmar→formato SÍ marca Interesado / Cliente potencial'
  );

  const sPitch = { userIntent: 'BARRILES', waLabelClientePotencialApplied: false };
  assert(
    notifyCrmOnBotStateChange(sPitch, 'BARRILES_FILTRO_CANAL', 'BARRILES_INTRO_MENU') === false,
    'Barriles: pitch→precios (solo miró catálogo) NO marca Interesado'
  );

  const sDuda = { userIntent: 'BARRILES', waLabelClientePotencialApplied: false };
  assert(
    notifyCrmOnBotStateChange(sDuda, 'BARRILES_FILTRO_CANAL', 'CERRADO') === false,
    'Barriles: duda/mute NO marca Interesado'
  );

  const s3 = { userIntent: 'BARRILES', waLabelClientePotencialApplied: false };
  assert(
    notifyCrmOnBotStateChange(s3, 'BARRILES_INTRO_MENU', 'BARRILES_RECOGIDA_PRODUCTOS') === true,
    'Barriles: sí tras precios SÍ marca Interesado / Cliente potencial'
  );

  const s4 = { userIntent: 'BARRILES', waLabelClientePotencialApplied: false };
  assert(
    notifyCrmOnBotStateChange(s4, 'BARRILES_FILTRO_CANAL', 'BARRILES_RECOGIDA_PRODUCTOS') === true,
    'Barriles: elige pedido en la entrada SÍ marca Interesado / Cliente potencial'
  );
}

console.log('\n-- CLI API ask: OK → menú 1/2 → simulada cierra sin POST --');
{
  const { setCotApiWriteMode, getCotApiWriteMode } = await import('../src/logic/cot-api.js');
  const prevMode = getCotApiWriteMode();
  setCotApiWriteMode('ask');
  resetSession(SESSION_ID);
  const session = getSession(SESSION_ID);
  session.currentState = 'EVENTOS_CONFIRMAR_ENVIO';
  session.userIntent = 'EVENTOS';
  session.eventoFormato = 'Dispensador Portátil';
  session.guests = 40;
  session.celebrationType = 'Cumpleaños';
  session.date = '20 de septiembre';
  session.location = 'Providencia';
  session.isRM = true;
  session.contact = { firstName: 'Ana', lastName: 'Pérez', email: 'ana@test.cl' };
  session.orderBuilder = {
    type: 'dispensador',
    products: { 'Mojito::10L': { name: 'Mojito', litrage: '10L', quantity: 1 } },
    extras: {},
    quote: { total: 109990 }
  };

  const st = statesMap.EVENTOS_CONFIRMAR_ENVIO;
  const rAsk = await st.validateAndProcess('OK', session);
  assert(rAsk.nextState === 'EVENTOS_CONFIRMAR_ENVIO', 'ask: tras OK sigue en confirmar');
  assert(/\[TEST\].*Real|Simulada/i.test(String(rAsk.customReply || '')), 'ask: muestra menú real/simulada');
  assert(session.cliAwaitingApiMode === true, 'ask: marca espera de 1/2');

  const rMock = await st.validateAndProcess('2', session);
  assert(rMock.nextState === 'CERRADO', 'ask→2: cierra con mock');
  assert(rMock.mute === true, 'ask→2: mute');
  assert(/simulated=1|cotizar\/mock/i.test(String(rMock.customReply || '')), 'ask→2: link simulado en cierre');
  assert(session.cliAwaitingApiMode !== true, 'ask→2: limpia espera');

  setCotApiWriteMode(prevMode === 'ask' ? 'real' : prevMode);
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

