// ==============================================================================
// OBJETIVO: Detectar interrupciones en el chat (ruido, mirón, precio/carta).
// Evita que saludos o "después" se clasifiquen como WEB/CHAT por error.
// Lo usan decision-intent.js, engine.js y los filtros de canal (barriles/eventos).
//
// ORDEN CANÓNICO (engine + estados):
// 1. Handoff explícito (NO / HUMANO / hablar con…)
// 2. Mirón estricto (solo mirando / redes, no "después te confirmo")
// 3. Precio / carta → tip + re-pregunta del dato pendiente
// 4. Estado (validateAndProcess)
// 5. Stall / FAQ acotada (máx. 1) / strikes → handoff hablado
// ==============================================================================
import {
  normalizeString,
  preciosData,
  formatPrice,
  findClosestCatalogMatch,
  isOnlyBrowsing,
  wantsInstagramOrSocial
} from './utils.js';

// ==============================================================================
// 1. SALUDO / RUIDO / ENTUSIASMO (no es decisión de menú)
// ==============================================================================

/**
 * isGreetingOrNoise: ¿El mensaje es solo cortesía, saludo o entusiasmo?
 * Ej.: "hola", "¡Hola!", "Hola buen dia", "Hoooola q genial", "ok", "gracias".
 * NO es una elección de canal ni de producto: el bot debe re-preguntar el paso.
 *
 * @param {string} messageText - Lo que escribió el cliente
 * @returns {boolean} true si no debemos clasificar ni avanzar el flujo
 */
export function isGreetingOrNoise(messageText) {
  const trimmed = String(messageText ?? '').trim();
  if (!trimmed) return true;

  // Quitamos ¡ ¿ y puntuación de bordes (WhatsApp manda mucho "¡Hola!")
  const stripped = trimmed
    .replace(/^[¡!¿?\s.,;:…-]+/u, '')
    .replace(/[¡!¿?.…,;:\s-]+$/u, '')
    .trim();
  if (!stripped) return true;

  // Saludos / ok / gracias / listo (mensaje completo)
  if (/^(hola+|holi|buenas|buen\s*d[ií]a|buenas\s*tardes|buenas\s*noches|hey|hi|hello|ok|okay|dale|gracias|thank(s)?|ya|listo|de\s+nada|genial|super|súper|perfecto|buenísimo|buenisimo|wow|wena|wenas)$/i.test(stripped)) {
    return true;
  }

  // Entusiasmo / saludo + cortesía ("Hola buen dia", "Hoooola q genial", "hola qué tal")
  const norm = normalizeString(stripped);
  if (
    /^h+o+l+a+\b/.test(norm)
    || /^(holi|buenas|buen\s*dia|buenas\s*tardes|buenas\s*noches|hey|hi|hello)\b/.test(norm)
  ) {
    // Solo ruido si el resto son muletillas (no pide precio, web, chat, cóctel…)
    const rest = norm
      .replace(/^h+o+l+a+\b/, '')
      .replace(/^(holi|buenas\s*tardes|buenas\s*noches|buen\s*dia|buenas|hey|hi|hello)\b/, '')
      .replace(/\b(q|que|que tal|como estas|como esta|como te va|muy|tan|la|el|lo|de|y|a|o|u|x|xd|jaja+|jeje+|amigo|amiga|todos|todas)\b/g, ' ')
      .replace(/\b(buen|dia|tardes|noches|dias)\b/g, ' ')
      .replace(/\b(genial|super|buen[oa]s?|buenisimo|bacan|wena|wenas|gracias|ok|okay|dale|perfecto|wow|hola)\b/g, ' ')
      .replace(/[!?.\s]+/g, ' ')
      .trim();
    if (rest.length === 0) return true;
  }

  // Frase corta de solo entusiasmo (sin verbo de compra ni canal)
  if (/^(q|que)?\s*(genial|bacan|buen[oa]|buenisimo|super|wow)$/i.test(norm)) {
    return true;
  }

  return false;
}

/**
 * isLikelyThirdPartyBotReply: ¿Parece auto-respuesta de otro negocio/bot en WhatsApp?
 * Evita extraer datos o improvisar charla cuando llega el mensaje de bienvenida ajeno.
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function isLikelyThirdPartyBotReply(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  if (/\b(te\s+atiende\s+(ia|i\.a\.)|atiende\s+ia|asistente\s+virtual\s+de\s+(?!cocktails|coctel))\b/i.test(lower)) {
    return true;
  }
  if (/\b(nos\s+dedicamos\s+a|bienvenida\s+a|damos\s+la\s+bienvenida)\b/i.test(lower)
      && !/\bcocktails?\s+on\s+tap\b/i.test(lower)) {
    return true;
  }
  if (/\b(catering|banquetes?|florister[ií]a|mobiliario\s+infantil)\b/i.test(lower)
      && /\b(arriendo|producci[oó]n\s+de\s+eventos|decoraci[oó]n)\b/i.test(lower)) {
    return true;
  }
  if (/^no\s+puedo\s+ayudarte\s+con\s+eso/i.test(trimmed)) {
    return true;
  }
  if ((trimmed.match(/\*/g) || []).length >= 3 && trimmed.length > 120) {
    return true;
  }
  return false;
}

// ==============================================================================
// 2. PRECIO / CARTA / LISTA (sin elegir canal todavía)
// ==============================================================================

/**
 * asksPriceOrCatalog: ¿Pide precios, valor, carta o lista de sabores?
 * En el filtro de canal respondemos el dato (o la foto) SIN fingir que eligió chat.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function asksPriceOrCatalog(messageText) {
  const lower = String(messageText || '').toLowerCase();
  // Incluye "valores" (plural) y sinónimos que usa la gente en WhatsApp
  return /\b(precio|precios|valor|valores|vale|cu[aá]nto|cuanto|cuestan|cuesta|carta|lista|cat[aá]logo|menu|men[uú]|sabores|variedades)\b/i.test(lower);
}

/** Regex: el mensaje entero es solo “seguir / listo / ok / no” (sin sabores al lado). */
const ONLY_ADVANCE_PRODUCTS_RE =
  /^(nada|nada\s*mas|nada\s*más|solo\s*esto|solo\s*estos|eso\s*es|listo|ya|fin|sin\s*mas|sin\s*más|no\s*hay\s*mas|no\s*quiero\s*mas|continuar|continuamos|avanzar|seguir|seguimos|siguiente|ok|okay|dale|perfecto|si|sí|no)([\s!.?]*)$/i;

/**
 * isOnlyAdvanceProductsOrder: true solo si el mensaje es *únicamente* avanzar
 * (ej. "ok", "seguimos", "listo"). Así "2 mojitos y seguimos" NO cae aquí y puede ir al NLU.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function isOnlyAdvanceProductsOrder(messageText) {
  const trimmed = String(messageText ?? '').trim();
  if (!trimmed) return false;
  return ONLY_ADVANCE_PRODUCTS_RE.test(trimmed);
}

/**
 * wantsAdvanceProductsOrder: ¿Quiere dejar de agregar cócteles y seguir el flujo?
 * Cubre "ok"/"seguimos" solo o mezclado con pedido (ej. "1 mojito seguimos").
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function wantsAdvanceProductsOrder(messageText) {
  const trimmed = String(messageText ?? '').trim();
  if (!trimmed) return false;
  return ONLY_ADVANCE_PRODUCTS_RE.test(trimmed)
    || /\b(ok|okay|seguimos|continuar|continuamos|solo\s*estos|solo\s*esto)\b/i.test(trimmed);
}

/**
 * findMentionedCocktail: Busca un cóctel del catálogo mencionado en el mensaje.
 * Sirve para responder "¿cuánto vale el margarita?" con el precio oficial.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {string|null} Nombre exacto del catálogo o null
 */
export function findMentionedCocktail(messageText) {
  const catalogNames = Object.keys(preciosData.cocteles || {});
  if (catalogNames.length === 0) return null;

  const normMsg = normalizeString(messageText);
  // Primero: coincidencia exacta de nombre completo dentro del mensaje
  for (const name of catalogNames) {
    const normName = normalizeString(name);
    if (normName.length >= 4 && normMsg.includes(normName)) return name;
  }

  // Segundo: fuzzy por palabras del mensaje (ej. "tequila margarita" → Margarita)
  const words = normMsg.split(/\s+/).filter((w) => w.length >= 4);
  for (const word of words) {
    const match = findClosestCatalogMatch(word, catalogNames);
    if (match) return match;
  }
  return null;
}

/**
 * formatDesechablePriceReply: Precio oficial del barril desechable 5L de un cóctel.
 *
 * @param {string} cocktailName - Nombre exacto del catálogo
 * @returns {string|null} Texto corto con precio, o null si no hay dato
 */
export function formatDesechablePriceReply(cocktailName) {
  const price = preciosData.cocteles?.[cocktailName]?.desechable?.['5L'];
  if (price == null) return null;
  return `El *${cocktailName}* en Barril Desechable de 5L vale *${formatPrice(price)}* (rinde ≈ 25 cócteles).`;
}

// ==============================================================================
// 3. MIRÓN / CIERRE SUAVE (reexport + atajo)
// ==============================================================================

/**
 * wantsBrowseOnlyClose: ¿Quiere cerrar sin cotizar (mirón, después, no gracias…)?
 * Une isOnlyBrowsing + Instagram/redes para los filtros de canal.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function wantsBrowseOnlyClose(messageText) {
  return isOnlyBrowsing(messageText) || wantsInstagramOrSocial(messageText);
}

/**
 * wantsExplicitHandoff: Detecta de forma segura si el cliente solicita asistencia humana,
 * evitando falsos positivos con palabras como "personas" o "contacto" a menos que estén
 * en frases estructuradas.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function wantsExplicitHandoff(messageText) {
  const trimmed = String(messageText ?? '').trim();
  if (!trimmed) return false;

  // 1. Frases compuestas de acción (Regex de Alta Precisión)
  // Ej: "hablar con alguien", "necesito un asesor", "hablar con un humano", "contacto humano"
  const regexHandoffFrase = /\b(hablar|conversar|chatear|comunicar|conectar|necesito|quiero|solicito|llamar|contactar|contacto|pedir)\s+(con|a)?\s*(un[oa]?\s+)?(persona|humano|asesor[a]?|ejecutivo[a]?|vendedor[a]?|agente|operador[a]?|alguien|el\s+equipo|soporte|atencion|atenci[oó]n)\b/i;
  
  if (regexHandoffFrase.test(trimmed)) {
    return true;
  }

  // 2. Sustantivos de rol no ambiguos y palabras sueltas seguras
  // Matcheamos solo palabra completa para evitar falsos positivos
  const norm = trimmed.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[^a-z]/g, ''); // deja solo letras de la palabra suelta

  const rolesSeguros = new Set([
    'humano', 'humana', 'humanos', 'humanas',
    'asesor', 'asesora', 'ejecutivo', 'ejecutiva', 'vendedor', 'vendedora', 'soporte'
  ]);

  if (rolesSeguros.has(norm)) {
    return true;
  }

  return false;
}

export { isOnlyBrowsing, wantsInstagramOrSocial };

