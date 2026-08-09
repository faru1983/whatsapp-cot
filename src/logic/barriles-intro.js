// ==============================================================================
// OBJETIVO: Helpers del intro Barriles — pitch, menú de intención, match de sabor.
// Lo usan BARRILES_FILTRO_CANAL (pedido/precios/duda) y BARRILES_INTRO_MENU (sí/no tras precios).
// Ingredientes y precios salen de datos.json (el catálogo API no trae receta).
// ==============================================================================
import { extractProductsWithAI } from '../core/llm.js';
import { img } from './media.js';
import {
  preciosData,
  formatPrice,
  findClosestCatalogMatch,
  parseDate,
  findLocationByFuzzyMatch,
  hasDrinkSelection,
  wantsNonAlcoholicOption,
  getCoctelesByCategoria,
  asksAvailableCocktailsList
} from './utils.js';
import { findMentionedCocktail, asksPriceOrCatalog, isGreetingOrNoise } from './interruptions.js';
import { formatMenuBlock } from './flow-rails.js';
import { exampleConcreteDateHint, normalizeBotDateText } from './cot-event-quote.js';
import { matchCocktailNamesInText } from './eventos-helpers.js';
import { OrderBuilder } from './order-builder.js';

/** Tragos por barril 5L (dato oficial de negocio). */
const RENDIMIENTO_5L = Number(preciosData.rendimientos_barriles?.['5L']) || 25;

/**
 * CART_OK_CTA: CTA compartido tras mostrar el carrito de Barriles (entrada o RECOGIDA_PRODUCTOS).
 * Un solo lugar para no desalinear el copy entre estados.
 */
export const CART_OK_CTA = `Si está bien así, escribe *OK* para continuar o dime qué agregar o quitar.
_(ej: elimina el aperol, agrega 1 sangría)_`;

/**
 * ASK_BARRILES_FLAVORS: Pregunta de sabores tras elegir pedido (o sí tras ver precios).
 * Va junto al catálogo para que el cliente elija desde la foto.
 *
 * @returns {string}
 */
export function askBarrilesFlavorsCopy() {
  return `👉 *¿Qué cóctel(es) del catálogo te interesan?*
_(ej: Mojito, Sangría, Ramazzotti — o "1 mojito y 2 sangría")_`;
}

/**
 * formatBarrilesCartLines: Lista de ítems del carrito + subtotal + litros/tragos totales.
 * La usan la entrada Barriles (al pre-cargar el sabor mencionado) y BARRILES_RECOGIDA_PRODUCTOS.
 *
 * @param {object} products - Mapa nombre → cantidad
 * @returns {string}
 */
export function formatBarrilesCartLines(products) {
  const orderBuilder = new OrderBuilder('desechable', preciosData);
  orderBuilder.products = products;
  const quote = orderBuilder.calculateQuote();

  let lines = '';
  for (const [name, qty] of Object.entries(products)) {
    const price = preciosData.cocteles[name]?.desechable?.['5L'] || 0;
    lines += `- ${qty}x ${name} 5L: ${formatPrice(price * qty)}\n`;
  }
  lines += `\n*Subtotal de cócteles:* ${formatPrice(quote.subtotal)}`;
  if (quote.totalLiters > 0) {
    lines += `\n\nSerían *${quote.totalLiters}L totales*, que equivalen a *${quote.totalDrinks} tragos* de 200ml en una copa/vaso con hielo.`;
  }
  return lines;
}

/**
 * BARRILES_PEDIDO_SYNONYMS: Palabras/frases que equivalen a la opción 1️⃣ (hacer pedido).
 * Cubre variantes del mismo patrón: pedido, compra, orden, cotizar, etc.
 * Lo usan FILTRO_CANAL e INTRO_MENU para no desalinear sinónimos.
 */
export const BARRILES_PEDIDO_SYNONYMS =
  /hacer\s+((un|una)\s+)?(pedido|compra|orden)|\b(pedido|compra|orden)\b|\bcomprar\b|\border\b|\bcotizar\b|quiero\s+(pedir|comprar|ordenar)|armar\s+((un|una)\s+)?(pedido|compra|orden)|opci[oó]n\s*1|^(uno|primera?)$/i;

/**
 * BARRILES_POST_PRECIOS_SI_SYNONYMS: Tras ver catálogo, equivale a 1️⃣ (sí, pedir).
 * Afirmaciones cortas (sí/ok/dale) O sinónimos de pedido/compra.
 * "ok" solo al mensaje completo — así "ok gracias" no pisa la opción 2️⃣.
 */
export const BARRILES_POST_PRECIOS_SI_SYNONYMS = new RegExp(
  `^(s[ií]|dale|ok|okay|claro|vamos|seguimos|continuar|obvio)[.!]*$|${BARRILES_PEDIDO_SYNONYMS.source}`,
  'i'
);

/**
 * BARRILES_POST_PRECIOS_NO_SYNONYMS: Tras ver catálogo, equivale a 2️⃣ (no / solo miraba).
 * Cubre "no gracias", "gracias" solo, "solo eso" y cierres suaves similares.
 */
export const BARRILES_POST_PRECIOS_NO_SYNONYMS =
  /no,?\s*gracias|\bno\s+gracias\b|^(gracias|grax|gracias\s+igual)[.!]*$|\bok\s*,?\s*gracias\b|\bperfecto\s+gracias\b|solo\s+(eso|eso\s+por\s+ahora|miraba|estaba\s+mirando)|eso\s+es\s+todo|por\s+ahora\s+(no|eso|nada)|nada\s+m[aá]s|ahora\s+no|\bnop\b|\bnope\b|\bnah\b|solo\s+quer[ií]a\s+ver|solo\s+mirar|opci[oó]n\s*2|^(dos|segunda?)$/i;

/**
 * BARRILES_PRECIOS_SYNONYMS: Palabras/frases que equivalen a la opción 2️⃣ (ver precios).
 * Cubre variantes del mismo patrón: precios, valores, costo, vale/valen, catálogo, etc.
 * Lo usa FILTRO_CANAL para no desalinear sinónimos.
 */
export const BARRILES_PRECIOS_SYNONYMS =
  /\bprecios?\b|\bvalores?\b|\bcostos?\b|\btarifas?\b|\bvalen?\b|\bcuestan?\b|cu[aá]nto\s+(valen?|cuestan?|salen?)|ver\s+(precios|valores|costos)|lista\s+de\s+precios|\bcat[aá]logo\b|\bcarta\b|opci[oó]n\s*2|^(dos|segunda?)$/i;

/**
 * BARRILES_DUDA_SYNONYMS: Palabras/frases que equivalen a la opción 3️⃣ (tengo una duda).
 * Cubre variantes del mismo patrón: duda, consulta, pregunta, ayuda, humano/asesor, etc.
 * Lo usa FILTRO_CANAL para no desalinear sinónimos.
 */
export const BARRILES_DUDA_SYNONYMS =
  /\bdudas?\b|\bconsultas?\b|\bpreguntas?\b|\binquietud(es)?\b|\bayuda\b|\bhumano\b|\bpersona\b|\basesor\b|\bejeci?utivo\b|ayuda\s+humana|hablar\s+con\s+(alguien|una?\s+persona|un\s+humano|un\s+asesor)|tengo\s+(una\s+)?(duda|consulta|pregunta)|quiero\s+(consultar|preguntar)|opci[oó]n\s*3|^(tres|tercera?)$/i;

/**
 * barrilesIntentMenuBlock: Menú 1️⃣ pedido / 2️⃣ precios / 3️⃣ duda (entrada Barriles).
 *
 * @returns {string}
 */
export function barrilesIntentMenuBlock() {
  return formatMenuBlock(['Quiero hacer un pedido', 'Quiero ver precios', 'Tengo una duda']);
}

/**
 * barrilesIntentMenuQuestion: Pregunta + menú de intención (burbuja 2 del pitch).
 *
 * @returns {string}
 */
export function barrilesIntentMenuQuestion() {
  return `*Para continuar, ¿qué estás buscando?*

${barrilesIntentMenuBlock()}`;
}

/**
 * barrilesPostPreciosMenuBlock: Menú 1️⃣ sí pedir / 2️⃣ no gracias (tras ver catálogo).
 *
 * @returns {string}
 */
export function barrilesPostPreciosMenuBlock() {
  return formatMenuBlock(['Sí, quiero hacer un pedido', 'No, gracias']);
}

/**
 * barrilesPostPreciosMenuQuestion: Pregunta + menú después de mostrar precios/catálogo.
 *
 * @returns {string}
 */
export function barrilesPostPreciosMenuQuestion() {
  return `*¿Quieres continuar y hacer un pedido?*

${barrilesPostPreciosMenuBlock()}`;
}

/** Alias legacy: el menú de intención reemplazó al viejo cotizar/consulta. */
export const barrilesIntroMenuBlock = barrilesIntentMenuBlock;
/** Alias legacy: misma pregunta de intención de entrada. */
export const barrilesIntroMenuQuestion = barrilesIntentMenuQuestion;

/**
 * ensureDesechableCart: Inicializa orderBuilder tipo desechable si falta.
 *
 * @param {object} session
 */
export function ensureDesechableCart(session) {
  if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { name: null, date: null, location: null }
    };
  }
  if (!session.orderBuilder.clientData) {
    session.orderBuilder.clientData = { name: null, date: null, location: null };
  }
}

/**
 * softSaveDeliveryHints: Si el mensaje trae comuna/fecha, las anota sin cambiar el paso.
 * Así no se pierden si el cliente las adelanta antes de cotizar.
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {boolean} true si el mensaje trajo fecha y/o comuna reconocida
 */
export function softSaveDeliveryHints(messageText, session) {
  ensureDesechableCart(session);
  const cd = session.orderBuilder.clientData;
  let recognizedSomething = false;

  const parsedDate = parseDate(messageText);
  if (parsedDate) {
    cd.date = normalizeBotDateText(parsedDate) || parsedDate;
    recognizedSomething = true;
  }

  const locationSearch = findLocationByFuzzyMatch(messageText);
  if (locationSearch) {
    cd.location = locationSearch.name;
    cd.locationData = locationSearch;
    recognizedSomething = true;
  }

  return recognizedSomething;
}

/**
 * looksLikeBarrilesFlavorInterest: ¿El mensaje apunta a un sabor / carta / preferencia?
 * "tienes sangría?", "algo refrescante", "quiero ver precios" → sí (seguir interacción).
 * "hacen despacho?", "qué hora es?" → no (FAQ / re-pregunta sin catálogo falso).
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function looksLikeBarrilesFlavorInterest(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;

  // Ya nombra un cóctel del catálogo
  if (findMentionedCocktail(trimmed)) return true;
  if (hasDrinkSelection(trimmed)) return true;

  // Quiere ver precios/carta (sigue en el flujo; el mute “solo precios” va aparte)
  if (asksPriceOrCatalog(trimmed)) return true;

  const lower = trimmed.toLowerCase();
  // Logística pura → no es interés de sabor
  const logisticsOnly = /\b(despacho|env[ií]o|encomienda|comuna|fecha|horario|hora|direcci[oó]n|regi[oó]n|blue\s*express)\b/i.test(lower)
    && !/\b(sabor|c[oó]ctel|trago|barril|mojito|sangr|pisco|margarita|aperol)\b/i.test(lower);
  if (logisticsOnly) return false;

  // Disponibilidad / preferencia abierta (“tienes…?”, “busco algo dulce”)
  // Ojo: "tienes" NO lo captura `tienen?` (solo "tiene"/"tienen"); por eso va `tiene(?:n|s)?`.
  if (/\b(tiene(?:n|s)?|hay|vende(?:n)?|maneja(?:n)?|disponible|disponibles|busco|quiero|me\s+gusta|prefiero)\b/i.test(lower)) {
    return true;
  }
  if (/\b(sabor|sabores|c[oó]ctel|c[oó]cteles|trago|tragos|refrescante|dulce|c[ií]trico|amargo|cl[aá]sico)\b/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * looksLikeUnrecognizedFlavorAttempt: ¿Intentó nombrar un cóctel que NO está en la carta?
 * Cubre variantes del mismo patrón (no un string puntual):
 * - Nombre suelto: "negroni", "daiquiri", "piña colada"
 * - Disponibilidad: "tienes piña colada?", "hay cosmopolitan?", "venden negroni"
 * En este paso el bot solo pidió el sabor; si no matchea catálogo, mejor decir "aún no lo
 * tenemos" + catálogo real que caer en el "no entendí" genérico o en un LLM improvisado.
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function looksLikeUnrecognizedFlavorAttempt(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;
  if (isGreetingOrNoise(trimmed)) return false;

  // "sin alcohol" / "mocktail" NO es un sabor inventado: es un pedido válido de la
  // categoría Mocktails (la maneja wantsNonAlcoholicOption / getNonAlcoholicSuggestionReply)
  if (wantsNonAlcoholicOption(trimmed)) return false;

  // Quitamos ¿?¡! para analizar el contenido (así "tienes X?" no se descarta solo por el ?)
  const cleaned = trimmed.replace(/[¿?¡!.,;:…]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return false;

  // Preguntas de info real (cómo/dónde/cuánto…) → FAQ/LLM; no son un nombre de sabor
  if (/\b(como|cómo|donde|dónde|cuando|cuándo|quien|quién|porque|por\s*qu[eé]|que\s+es|qué\s+es|cuanto|cuánto)\b/i.test(cleaned)) {
    return false;
  }

  // Logística / pago / humano → no es intento de sabor
  if (/\b(despacho|env[ií]o|encomienda|comuna|fecha|horario|hora|direcci[oó]n|regi[oó]n|blue\s*express|humano|asesor|instagram|precio|precios|pagar|transferencia|tarjeta)\b/i.test(cleaned)) {
    return false;
  }

  // Preferencia genérica sin nombrar un trago concreto → lo maneja el gate “Excelente elección”
  if (/\b(algo|sabores?|carta|cat[aá]logo|opciones|refrescante|dulce|c[ií]trico|amargo|cl[aá]sico|raro)\b/i.test(cleaned)
      && !/\b(tiene(?:n|s)?|hay|vende(?:n)?)\b/i.test(cleaned)) {
    return false;
  }
  if (/^(algo\s+)?(bien\s+)?(dulce|refrescante|amargo|c[ií]trico|cl[aá]sico)(\s+y\s+\w+)*$/i.test(cleaned)) {
    return false;
  }

  // Sacamos el envoltorio de disponibilidad (“tienes…”, “hay…”) para quedarnos con el
  // candidato a nombre de cóctel: "tienes piña colada" → "piña colada"
  const candidate = cleaned
    .replace(/^(me\s+)?(tiene(?:n|s)?|hay|vende(?:n)?|maneja(?:n)?|busco|quiero|quisiera|necesito)\s+/i, '')
    .replace(/\b(por\s+favor|please|o\s+algo|as[ií]|disponible|disponibles)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const nameToCheck = candidate || cleaned;
  const wordCount = nameToCheck.split(/\s+/).filter(Boolean).length;

  // Disponibilidad + resto corto → casi seguro preguntó por un sabor concreto fuera de carta
  if (/\b(tiene(?:n|s)?|hay|vende(?:n)?|maneja(?:n)?)\b/i.test(cleaned)
      && wordCount >= 1 && wordCount <= 5 && nameToCheck.length <= 40) {
    return true;
  }

  // Nombre suelto corto (1–4 palabras): "negroni", "piña colada", "sex on the beach"
  // (también "1 negroni" / "2 daiquiris" → el dígito es cantidad, no invalida el intento)
  if (wordCount < 1 || wordCount > 4 || nameToCheck.length > 35) return false;
  if (/^\d+$/.test(nameToCheck)) return false;

  return true;
}

/**
 * resolveBarrilesFlavorMatches: Detecta TODOS los barriles desechables que nombra el mensaje.
 * Primero reglas (rápido y barato, y ya soporta varios sabores en un mismo mensaje gracias a
 * `matchCocktailNamesInText`); si no hay match claro, NLU como red de seguridad (usa TODOS los
 * productos que devuelve, no solo el primero — así "Sangría y Ramazzotti" reconoce ambos).
 *
 * Importante: la IA SOLO se llama si el mensaje ya "parece" interés de sabor
 * (`looksLikeBarrilesFlavorInterest`). Si no, mensajes sin ninguna relación a cócteles
 * (ej. una comuna como "Las Condes") podrían hacer que la IA invente un producto que no
 * existe — mejor no arriesgarse y dejar que el engine reencauce con FAQ/re-pregunta.
 *
 * @param {string} messageText
 * @param {string} [lastBotMessage]
 * @returns {Promise<string[]>} Nombres exactos del catálogo (puede ser [])
 */
export async function resolveBarrilesFlavorMatches(messageText, lastBotMessage = '') {
  const catalogNames = Object.keys(preciosData.cocteles || {});
  if (catalogNames.length === 0) return [];

  const trimmed = String(messageText || '').trim();
  if (!trimmed || trimmed.length < 3) return [];
  if (/^(hola|holi|buenas|ok|okay|si|sí|dale|gracias|no|nop)$/i.test(trimmed)) return [];

  // 1) Match programático sobre TODO el mensaje (funciona con "sangría y ramazzotti",
  // "tienes mojito?", listas separadas por coma, etc.)
  const directMatches = matchCocktailNamesInText(trimmed.replace(/[¿?]/g, ' '), catalogNames);
  if (directMatches.length > 0) return directMatches;

  // Sin match directo Y sin ninguna señal de interés de sabor (ej. comuna, fecha, saludo
  // suelto) → no vale la pena (ni es seguro) llamar a la IA para "adivinar" un cóctel.
  if (!looksLikeBarrilesFlavorInterest(trimmed)) return [];

  // 2) Fallback NLU: el cliente puede decir "algo como un daiquiri" o typos raros.
  // Se usan TODOS los productos detectados (no solo el primero).
  try {
    const { productos } = await extractProductsWithAI(
      messageText,
      catalogNames,
      lastBotMessage || '👉 *¿Qué cóctel(es) del catálogo te interesan?*'
    );
    const names = [];
    for (const item of Array.isArray(productos) ? productos : []) {
      if (!item?.name) continue;
      const match = findClosestCatalogMatch(String(item.name), catalogNames);
      if (match && !names.includes(match)) names.push(match);
    }
    return names;
  } catch (err) {
    console.error('[bot] resolveBarrilesFlavorMatches NLU falló:', err.message);
    return [];
  }
}

/**
 * findUnmatchedFlavorSegments: Dentro de un mensaje con 1+ sabores ya reconocidos, detecta
 * qué otros "trozos" (separados por y/,) sonaban a intento de cóctel pero NO están en la
 * carta. Ej. "mojito y piña colada" → Mojito matchea, pero no debemos ignorar en silencio
 * que pidió "piña colada"; hay que decírselo en la misma respuesta.
 *
 * @param {string} messageText
 * @returns {string[]} Trozos sin match (texto limpio, sin verbos de pedido)
 */
export function findUnmatchedFlavorSegments(messageText) {
  const catalogNames = Object.keys(preciosData.cocteles || {});
  if (catalogNames.length === 0) return [];

  const cleaned = String(messageText || '').replace(/[¿?]/g, ' ');
  const segments = cleaned.split(/\s*(?:,|;|\by\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (segments.length <= 1) return [];

  const unmatched = [];
  for (const segment of segments) {
    if (matchCocktailNamesInText(segment, catalogNames).length > 0) continue;
    if (!looksLikeUnrecognizedFlavorAttempt(segment)) continue;
    const clean = segment
      .replace(/^(quiero|busco|dame|hay|tiene(?:n|s)?|tambi[eé]n|me\s+gustar[ií]a|necesito)\s+/i, '')
      .trim();
    if (clean && !unmatched.includes(clean)) unmatched.push(clean);
  }
  return unmatched;
}

/**
 * buildBarrilesMatchPitch: Copy cuando sí hay match (nombre + ingredientes + precio/copa).
 * Ingredientes: datos.json (no vienen en el catálogo API liviano).
 *
 * @param {string} cocktailName - Nombre exacto del catálogo
 * @returns {string|null}
 */
export function buildBarrilesMatchPitch(cocktailName) {
  const data = preciosData.cocteles?.[cocktailName];
  const price = data?.desechable?.['5L'];
  if (price == null) return null;

  const ingredientes = String(data.ingredientes || '').trim().replace(/\.$/, '');
  const perGlass = Math.round(Number(price) / RENDIMIENTO_5L);
  const ingredientesLine = ingredientes
    ? `El *${cocktailName}* lo hacemos con _${ingredientes}._`
    : `El *${cocktailName}* es un cóctel *listo para servir*, con calidad de bar.`;

  return `¡Excelente elección! 🍸
${ingredientesLine}
Tiene un valor de *${formatPrice(price)}* y, como rinde *${RENDIMIENTO_5L} cócteles*, cada uno sale a *${formatPrice(perGlass)}*.`;
}

/**
 * buildBarrilesCatalogImage: Foto de precios/sabores (con o sin caption).
 * La usan el intro (pedido / precios) y RECOGIDA_PRODUCTOS.
 *
 * @param {string} [caption]
 * @returns {object}
 */
export function buildBarrilesCatalogImage(caption = '') {
  return img('barril_desechable_precios.webp', caption);
}

/**
 * formatBarrilesCompactCatalog: Lista compacta por categoría (sin imagen ni precios).
 * Para "¿cuáles tienes?" / "lista" cuando el catálogo foto ya se envió más arriba.
 *
 * @returns {string}
 */
export function formatBarrilesCompactCatalog() {
  const cats = getCoctelesByCategoria();

  /**
   * joinNames: Une nombres de una categoría con " / ".
   *
   * @param {Array<{ name: string }>} items
   * @param {{ mocktailLabel?: boolean }} [opts]
   * @returns {string}
   */
  const joinNames = (items, opts = {}) => {
    const names = (Array.isArray(items) ? items : [])
      .map((item) => {
        const raw = String(item?.name || '').trim();
        if (!raw) return '';
        // Mocktails: "Mojito Mocktail" → "Mojito Sin Alcohol" (más claro para el cliente)
        if (opts.mocktailLabel) {
          return raw.replace(/\s*Mocktail\s*$/i, ' Sin Alcohol');
        }
        return raw;
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'es'));
    return names.join(' / ');
  };

  const clasicos = joinNames(cats['CLÁSICOS']);
  const combinados = joinNames(cats.COMBINADOS);
  const mocktails = joinNames(cats.MOCKTAILS, { mocktailLabel: true });

  return `*Cócteles:* ${clasicos}

*Combinados:* ${combinados}

*Mocktails:* ${mocktails}`;
}

/**
 * buildBarrilesCompactCatalogReply: Respuesta a "¿cuáles tienes?" / lista.
 * Texto compacto + re-pregunta de sabor (sin reenviar la imagen del catálogo).
 *
 * @returns {string}
 */
export function buildBarrilesCompactCatalogReply() {
  return `Estos son los que manejamos 🍸

${formatBarrilesCompactCatalog()}

${askBarrilesFlavorsCopy()}`;
}

/**
 * asksBarrilesCatalogList: ¿Pide ver qué sabores hay (lista / cuáles tienes / disponibles)?
 * Reglas primero; cubre el patrón general (no un string puntual).
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksBarrilesCatalogList(messageText) {
  return asksAvailableCocktailsList(messageText);
}

/**
 * buildBarrilesProductOrderMissReply: Pedido no entendido en RECOGIDA_PRODUCTOS.
 * El catálogo ya se envió: no fingimos “ese cóctel no existe” ante cualquier texto
 * (ej. "valores"). Strike 1 = recordatorio suave; strike 2+ = asistente + HUMANO.
 *
 * @param {number} [strike=1] - Número de strike actual (1, 2, …)
 * @returns {string}
 */
export function buildBarrilesProductOrderMissReply(strike = 1) {
  if (Number(strike) >= 2) {
    return `Disculpa, no te entendí 😊 Soy un *asistente virtual*.
Indícame tu cóctel del *catálogo* o escribe *HUMANO* para que te asista alguien del equipo.`;
  }
  return `Disculpa, no entendí tu pedido 😊
Recuerda revisar el *catálogo* que te envié más arriba.

${askBarrilesFlavorsCopy()}`;
}

/**
 * buildBarrilesUnknownFlavorTextReply: Alias del miss (strike 1).
 * Se mantiene el nombre por tests / imports antiguos.
 *
 * @returns {string}
 */
export function buildBarrilesUnknownFlavorTextReply() {
  return buildBarrilesProductOrderMissReply(1);
}

/**
 * registerBarrilesProductOrderMiss: Suma strike y arma la respuesta del miss de productos.
 * El engine debe respetar `stallHandled` para no resetear ni duplicar el strike.
 *
 * @param {object} session
 * @param {number} [stallThreshold=2] - SECURITY_MAX_CONSECUTIVE_ERRORS
 * @returns {object} Resultado validateAndProcess
 */
export function registerBarrilesProductOrderMiss(session, stallThreshold = 2) {
  const threshold = Math.max(2, Number(stallThreshold) || 2);
  session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
  const strike = session.consecutiveErrors;

  // Último intento (strike == umbral): aviso con HUMANO, aún sin mute
  // Siguiente miss (strike > umbral): SOS + mute
  if (strike > threshold) {
    return {
      success: true,
      stallHandled: true,
      nextState: 'CERRADO',
      mute: true,
      notifyAdmin: {
        type: 'SOS',
        title: 'ANTI-LOOP',
        labelKey: 'asistencia',
        body: 'Varios pedidos de cóctel no entendidos en Barriles (catálogo ya enviado).'
      },
      customReply: `Te comunico con alguien del equipo para ayudarte con tu pedido. ¡Ya te escriben! 🙌`
    };
  }

  return {
    success: true,
    stallHandled: true,
    nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
    customReply: buildBarrilesProductOrderMissReply(strike >= threshold ? 2 : 1)
  };
}

/**
 * buildBarrilesPedidoReplies: Opción 1️⃣ (hacer pedido) → catálogo + pregunta de sabores.
 *
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesPedidoReplies() {
  return [
    buildBarrilesCatalogImage('👆 Catálogo completo con sabores y precios.'),
    askBarrilesFlavorsCopy()
  ];
}

/**
 * buildBarrilesPreciosCatalogCaption: Pie de la imagen al elegir “ver precios”.
 * Recuerda la web y deja el menú sí/no en la burbuja siguiente.
 *
 * @returns {string}
 */
export function buildBarrilesPreciosCatalogCaption() {
  return `👆 Catálogo completo con sabores y precios.

También puedes hacer tu pedido en https://cocktailsontap.cl/barriles`;
}

/**
 * buildBarrilesPreciosReplies: Opción 2️⃣ (ver precios) → catálogo + ¿quieres pedir?
 *
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesPreciosReplies() {
  return [
    buildBarrilesCatalogImage(buildBarrilesPreciosCatalogCaption()),
    barrilesPostPreciosMenuQuestion()
  ];
}

/**
 * buildBarrilesAskDoubtReply: Opción 3️⃣ — pide que escriba la duda (aún no muteamos).
 *
 * @returns {string}
 */
export function buildBarrilesAskDoubtReply() {
  return `Perfecto. 😊 Escríbeme tu duda y te respondemos enseguida.`;
}

/**
 * buildBarrilesNoMatchReplies: Catálogo genérico (caption corto). Legacy / fuera de carta.
 *
 * @returns {Array}
 */
export function buildBarrilesNoMatchReplies() {
  return [
    buildBarrilesCatalogImage(`👆 Te dejo el catálogo con todos los sabores disponibles.`)
  ];
}

/**
 * buildBarrilesNoMatchGateReplies: Sin match claro → catálogo + menú post-precios (sí/no pedir).
 * Se mantiene por compatibilidad con tests/helpers; el intro nuevo ya no llega aquí.
 *
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesNoMatchGateReplies() {
  return [...buildBarrilesNoMatchReplies(), barrilesPostPreciosMenuQuestion()];
}

/**
 * buildBarrilesUnknownFlavorGateReplies: Cóctel fuera de carta → aviso + catálogo + menú sí/no.
 *
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesUnknownFlavorGateReplies() {
  return [
    buildBarrilesCatalogImage(`Ese cóctel aún no lo tenemos en la carta 😅
👆 Mejor te dejo el catálogo para que revises los que sí manejamos.`),
    barrilesPostPreciosMenuQuestion()
  ];
}

/**
 * buildBarrilesMatchedCartReplies: El cliente nombró 1+ cócteles → pitch/resumen + CTA *OK*.
 * NO reenvía la imagen del catálogo: esa foto ya se mandó al elegir 1️⃣ Pedido (o precios).
 * Si el mensaje traía además un sabor fuera de carta, se avisa en el mismo texto.
 *
 * @param {string[]} cocktailNames - Nombres exactos del catálogo ya agregados al carrito
 * @param {object} products - Carrito actualizado (para mostrar subtotal correcto)
 * @param {string[]} [unmatchedNames] - Otros sabores mencionados que NO están en la carta
 * @returns {Array} customReplies para el engine (solo texto)
 */
export function buildBarrilesMatchedCartReplies(cocktailNames, products, unmatchedNames = []) {
  const unmatchedNote = unmatchedNames.length > 0
    ? `\n\n😅 *${unmatchedNames.join(', ')}* aún no ${unmatchedNames.length > 1 ? 'están' : 'está'} en la carta. Si quieres, elige otro del catálogo de arriba.`
    : '';

  // Un solo sabor: pitch rico (ingredientes + precio + valor por copa) + CTA
  if (cocktailNames.length === 1) {
    const pitch = buildBarrilesMatchPitch(cocktailNames[0]);
    if (pitch) {
      return [`${pitch}${unmatchedNote}\n\n${CART_OK_CTA}`];
    }
  }

  // Dos o más sabores: resumen de carrito compacto (evita repetir ingredientes de cada uno)
  return [
    `¡Genial! Anoté en tu pedido:\n\n${formatBarrilesCartLines(products)}${unmatchedNote}\n\n${CART_OK_CTA}`
  ];
}

/**
 * deliveryExampleLine: Ejemplo concreto de fecha (Chile + 3 días).
 * Lo reutiliza RECOGIDA_DATOS / nudges; queda aquí por si el intro lo menciona.
 *
 * @returns {string}
 */
export function deliveryExampleLine() {
  return `_(ej: Providencia, ${exampleConcreteDateHint()})_`;
}
