// ==============================================================================
// OBJETIVO: Helpers del intro Barriles — match de sabor, pitch, menú cotizar/consulta.
// Lo usan BARRILES_FILTRO_CANAL (respuesta abierta) y BARRILES_INTRO_MENU (decisión).
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
  hasDrinkSelection
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
 * barrilesIntroMenuBlock: Menú 1️⃣ cotizar / 2️⃣ consulta (burbuja de decisión).
 *
 * @returns {string}
 */
export function barrilesIntroMenuBlock() {
  return formatMenuBlock(['Cotizar mi pedido', 'Tengo una consulta']);
}

/**
 * barrilesIntroMenuQuestion: Pregunta + menú para la burbuja de alternativas.
 *
 * @returns {string}
 */
export function barrilesIntroMenuQuestion() {
  return `*¿Qué te gustaría hacer ahora?*

${barrilesIntroMenuBlock()}`;
}

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
      lastBotMessage || '👉 *Escribe el nombre del cóctel que te interesa y te enviaré el catálogo completo.*'
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
    ? `Nosotros lo hacemos con _${ingredientes}._`
    : 'Es un cóctel *listo para servir*, con calidad de bar.';

  return `Genial, tenemos disponible *${cocktailName}* 🍸
${ingredientesLine}
Su valor es *${formatPrice(price)}*.

Como rinde *${RENDIMIENTO_5L} tragos*, cada copa te sale alrededor de *${formatPrice(perGlass)}*.`;
}

/**
 * buildBarrilesCatalogImage: Foto de precios/sabores (con o sin caption).
 * La usan el intro (gate sin match / fuera de carta) y RECOGIDA_PRODUCTOS.
 *
 * @param {string} [caption]
 * @returns {object}
 */
export function buildBarrilesCatalogImage(caption = '') {
  return img('barril_desechable_precios.webp', caption);
}

/**
 * buildBarrilesNoMatchReplies: Sin match → imagen del catálogo con el copy en el caption.
 * Una sola burbuja (foto + texto), luego el menú va aparte.
 *
 * @returns {Array}
 */
export function buildBarrilesNoMatchReplies() {
  return [
    buildBarrilesCatalogImage(`👆 Excelente elección. 🍸
Te envío nuestro catálogo para que conozcas todos los sabores disponibles.`)
  ];
}

/**
 * buildBarrilesNoMatchGateReplies: Sin match claro (interés genérico / "quiero ver precios")
 * → catálogo + menú 1️⃣ Cotizar / 2️⃣ Consulta. Aquí sí vale la pena preguntar, porque todavía
 * no sabemos si quiere comprar o solo está curioseando.
 *
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesNoMatchGateReplies() {
  return [...buildBarrilesNoMatchReplies(), barrilesIntroMenuQuestion()];
}

/**
 * buildBarrilesUnknownFlavorGateReplies: El cliente nombró un cóctel que NO está en la carta
 * ("negroni", "tienes piña colada?"). Se lo decimos claro, dejamos el catálogo real y la
 * pregunta Cotizar/Consulta para que elija cómo seguir el pedido.
 *
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesUnknownFlavorGateReplies() {
  return [
    buildBarrilesCatalogImage(`Ese cóctel aún no lo tenemos en la carta 😅
👆 Mejor te dejo el catálogo para que revises los que sí manejamos.`),
    barrilesIntroMenuQuestion()
  ];
}

/**
 * buildBarrilesMatchedCartReplies: El cliente ya nombró 1+ cócteles concretos ("mojito",
 * "sangría y ramazzotti") → los anotamos directo en el carrito (1 barril c/u) y saltamos el
 * menú Cotizar/Consulta: nombrar un sabor de la carta YA es intención de compra clara, no
 * hace falta que además elija "1️⃣ Cotizar" para que el bot le pregunte los mismos sabores
 * de nuevo. Menos pasos = menos fricción (y menos gente perdida antes de cotizar).
 *
 * Un solo CTA (en la burbuja del catálogo) en vez de dos preguntas separadas de "agregar
 * algo más": así queda claro que el siguiente paso natural es *OK* para seguir cotizando.
 * Si el mensaje traía además un sabor que no existe (ej. "mojito y piña colada"), se lo
 * decimos ahí mismo en vez de ignorarlo en silencio.
 *
 * @param {string[]} cocktailNames - Nombres exactos del catálogo ya agregados al carrito
 * @param {object} products - Carrito actualizado (para mostrar subtotal correcto)
 * @param {string[]} [unmatchedNames] - Otros sabores mencionados que NO están en la carta
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesMatchedCartReplies(cocktailNames, products, unmatchedNames = []) {
  const unmatchedNote = unmatchedNames.length > 0
    ? `\n\n😅 *${unmatchedNames.join(', ')}* aún no ${unmatchedNames.length > 1 ? 'están' : 'está'} en la carta, pero revisa el catálogo 👇 por si te gusta otra opción.`
    : '';
  const catalogBubble = buildBarrilesCatalogImage(`👆 Catálogo completo con todos los sabores.\n\n${CART_OK_CTA}`);

  // Un solo sabor: mantenemos el pitch rico (ingredientes + precio + valor por copa)
  if (cocktailNames.length === 1) {
    const pitch = buildBarrilesMatchPitch(cocktailNames[0]);
    if (pitch) {
      return [
        `${pitch}${unmatchedNote}`,
        catalogBubble
      ];
    }
  }

  // Dos o más sabores: resumen de carrito compacto (evita repetir ingredientes de cada uno)
  return [
    `¡Genial! Anoté en tu pedido:\n\n${formatBarrilesCartLines(products)}${unmatchedNote}`,
    catalogBubble
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
