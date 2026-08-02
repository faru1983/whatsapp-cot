// ==============================================================================
// OBJETIVO: Helpers compartidos del flujo de Eventos (no son estados).
// Los estados de flows/eventos/states/ los importan desde aquí.
// ==============================================================================
import {
  findLocationByFuzzyMatch,
  parseDate,
  formatPrice,
  preciosData,
  normalizeString,
  findClosestCatalogMatch,
  fixEventLitrageShorthand,
  isValidFreeformLocationCapture
} from './utils.js';
import { isLikelyThirdPartyBotReply } from './interruptions.js';
import { OrderBuilder } from './order-builder.js';
import { img } from './media.js';
import { getEventLitersSuggestion } from '../views/templates.js';

/** Ejemplo canónico (litros primero) — intro menú + re-preguntas. */
export const EVENT_COCKTAIL_ORDER_EXAMPLE = '5L Mojito y 10L Aperol';

/** Pregunta estándar al pedir cócteles del evento. */
export const ASK_EVENT_COCKTAILS = `¿Qué cócteles te gustaría incluir en tu evento? (ej: "${EVENT_COCKTAIL_ORDER_EXAMPLE}")`;

/**
 * parseCelebrationType: Detecta qué celebra el cliente (matrimonio, cumpleaños, etc.).
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {string|null}
 */
export function parseCelebrationType(messageText) {
  const lower = String(messageText || '').toLowerCase();

  // "cumpleaños 25 invitados" → 25 son invitados, no la edad del cumpleañero
  const guestsAfterCumple = /\b(?:cumplea[nñ]os|cumple)\s+(?:de\s+|para\s+)?\d+\s*(?:personas|invitados|pax|inv)\b/i.test(lower);
  if (!guestsAfterCumple) {
    // Buscar cumpleaños con edad específica (ej: "15 años", "mis 40", "cumple de 30")
    const ageMatch = lower.match(/\b(?:cumplea[nñ]os|cumple|mis?)?\s*(?:de\s+)?(\d+)\s*(?:añitos|años?|anos?)\b/i)
                  || lower.match(/\b(?:cumplea[nñ]os|cumple|mis)\s+(?:de\s+)?(\d+)\b/i);

    if (ageMatch && parseInt(ageMatch[1], 10) > 0 && parseInt(ageMatch[1], 10) < 150) {
      return `Cumpleaños ${ageMatch[1]} años`;
    }
  }

  const map = [
    [/matrimonio|casamiento|boda|wedding/i, 'Matrimonio'],
    [/cumplea[nñ]os|cumple/i, 'Cumpleaños'],
    [/empresa|corporativ|oficina|trabajo/i, 'Evento corporativo'],
    [/graduaci[oó]n|egreso/i, 'Graduación'],
    [/aniversario/i, 'Aniversario'],
    [/baby\s*shower|babyshower/i, 'Baby shower'],
    [/fiesta|celebraci[oó]n|evento/i, 'Celebración']
  ];
  for (const [re, label] of map) {
    if (re.test(lower)) return label;
  }
  return null;
}

/**
 * extractGuestsFromMessage: Extrae el número de invitados filtrando fechas, edades, horas, etc.
 * @param {string} messageText
 * @returns {number|null}
 */
export function extractGuestsFromMessage(messageText) {
  let clean = String(messageText || '');

  // Prioridad: "25 invitados" en el texto original (antes de quitar "cumpleaños 25")
  const explicitOriginal = clean.match(/\b(\d+)\s*(personas|invitados|pax|inv)\b/i);
  if (explicitOriginal) {
    return parseInt(explicitOriginal[1], 10);
  }

  // 1. Quitar fechas: "15 de mayo", "15 diciembre", "el 3 diciembre 2027"
  // Sin esto, "15 diciembre" deja el 15 y lo toma como invitados.
  const months =
    'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
  clean = clean.replace(
    new RegExp(`\\b(?:el\\s+)?\\d{1,2}\\s+(?:de\\s+)?(?:${months})(?:\\s+(?:de\\s+)?\\d{4})?\\b`, 'gi'),
    ' '
  );
  // Solo mes ("en diciembre", "para marzo") — no aporta invitados
  clean = clean.replace(
    new RegExp(`\\b(?:para|en|durante|este|el)\\s+(?:${months})(?:\\s+(?:de\\s+)?\\d{4})?\\b`, 'gi'),
    ' '
  );

  // 2. Quitar edades/años (ej. 15 años, cumple 50, cumpleaños de 40)
  clean = clean.replace(/\b\d+\s*(añitos|años?|anos?)\b/gi, '');
  clean = clean.replace(/\b(cumpleaños|cumple)\s+(de\s+)?\d+\b/gi, '');
  
  // 3. Quitar horas (ej. 15:00, 20 hrs, a las 15)
  clean = clean.replace(/\b\d{1,2}:\d{2}\b/gi, '');
  clean = clean.replace(/\b\d{1,2}\s*(hrs?|horas?)\b/gi, '');
  clean = clean.replace(/\ba\s+las\s+\d{1,2}\b/gi, '');
  
  // 4. Quitar litrajes (ej. 10L, 20 litros)
  clean = clean.replace(/\b\d+\s*(l|lt|lts|litros?)\b/gi, '');

  // Primero buscar mención explícita de invitados (prioritario)
  const explicitMatch = clean.match(/\b(\d+)\s*(personas|invitados|pax|inv)\b/i);
  if (explicitMatch) {
    return parseInt(explicitMatch[1], 10);
  }

  // Si no, agarrar el primer número aislado que haya quedado
  const implicitMatch = clean.match(/\b(\d+)\b/i);
  if (implicitMatch) {
    return parseInt(implicitMatch[1], 10);
  }

  return null;
}

/**
 * asksEventServiceFormatQuestion: ¿Pregunta por dispensador/muro o si es solo barriles?
 * Ej.: "solo o dispensador", "dispensador o muro", "¿incluye la estación?".
 * En EVENTOS_RECOGIDA_DATOS respondemos con copy fijo (sin FAQ/IA) para no filtrar razonamiento interno.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function asksEventServiceFormatQuestion(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();

  // Elección entre formatos de evento (dispensador vs muro)
  if (/\b(dispensador|muro)\b/i.test(lower) && /\b(o|u|versus|vs)\b/i.test(lower)) {
    return true;
  }

  // "solo" vs dispensador/estación (¿solo barriles o con servicio completo?)
  if (/\bsolo\b/i.test(lower) && /\b(dispensador|muro|barriles?|estaci[oó]n)\b/i.test(lower)) {
    return true;
  }

  // Solo barriles / barriles solos (sin instalación)
  if (/\b(solo\s*(los\s*)?barriles?|barriles?\s+solo(s)?|solamente\s+barriles?)\b/i.test(lower)) {
    return true;
  }

  // ¿Incluye dispensador/instalación?
  if (/\b(con|sin|incluye|traen?|llevan?|viene)\b/i.test(lower)
      && /\b(dispensador|muro|estaci[oó]n|instalaci[oó]n)\b/i.test(lower)) {
    return true;
  }

  // Mensaje corto centrado en dispensador (ej. "solo o dispensador", "dispensador?")
  if (/^(solo\s+o\s+)?dispensador(\s+port[aá]til)?[?.!]?$/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * asksCoverageAreaQuestion: ¿Pregunta si atendemos una ciudad/comuna (no está dando su dato)?
 * Ej.: "¿van a la serena?", "¿llegan a concepción?". Debe ir a FAQ, no extraer comuna.
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksCoverageAreaQuestion(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  const looksLikeQuestion = /\?/.test(trimmed)
    || /\b(van|llegan|atienden|despachan|hacen|realizan|trabajan|pueden)\b/i.test(lower);
  if (!looksLikeQuestion) return false;

  return /\b(van\s+a|llegan\s+a|atienden\s+en|despachan\s+a|hacen\s+en|trabajan\s+en)\b/i.test(lower)
    || /\b(serena|concepci[oó]n|valpara[ií]so|vi[nñ]a|temuco|antofagasta|iquique|fuera\s+de\s+santiago|region|regi[oó]n)\b/i.test(lower);
}

/**
 * asksDeliveryOrDispatchQuestion: ¿Pregunta por despacho/envío (aunque venga junto a un pedido)?
 * Ej.: "2 mojitos, ¿hacen despacho a Maipú?"
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksDeliveryOrDispatchQuestion(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;
  if (asksCoverageAreaQuestion(trimmed)) return true;
  return /\b(despacho|despachan|env[ií]o|envian|envían|entregan|hacen\s+despacho|costo\s+de\s+env[ií]o)\b/i.test(trimmed)
    && (/\?/.test(trimmed) || /\b(hacen|pueden|cu[aá]nto|a\s+[a-záéíóúñ]+)\b/i.test(trimmed));
}

/**
 * REPLY_DISPATCH_SIDEBAR: Respuesta corta de cobertura cuando el cliente mezcla
 * pedido + duda de despacho en el mismo mensaje (pasos de carrito).
 */
export const REPLY_DISPATCH_SIDEBAR =
  '📦 Sobre *despacho*: trabajamos en toda la *Región Metropolitana* y también *La Serena/Coquimbo*. El costo se calcula según la comuna al armar la cotización.';

/**
 * stripDeliveryQuestionForCart: Quita la duda de despacho/envío del mensaje
 * para que el extractor de cócteles no se confunda (multi-intent pedido + pregunta).
 *
 * @param {string} messageText
 * @returns {string} Texto listo para parsear/NLU de productos
 */
export function stripDeliveryQuestionForCart(messageText) {
  return String(messageText || '')
    .replace(/[¿?][^¿?]*/g, ' ')
    .replace(/\b(hacen|pueden|hay)\s+(despacho|env[ií]o)\b.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,\s;]+$/g, '')
    .trim();
}

/**
 * asksEventCartPriceQuestion: ¿Pregunta por discrepancia de precio con lo ya cotizado?
 * Ej.: "¿y por qué sale otro valor?", "en la lista decía menos".
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksEventCartPriceQuestion(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  if (/\b(por\s*qu[eé]|porque)\b/i.test(lower)
      && /\b(valor|precio|sale|cuesta|cobran|caro|barato|diferente|otro)\b/i.test(lower)) {
    return true;
  }
  if (/\b(otro\s+valor|m[aá]s\s+caro|en\s+la\s+(lista|carta|imagen)|no\s+coincide|precio\s+diferente)\b/i.test(lower)) {
    return true;
  }
  if (/\?/.test(trimmed) && /\b(precio|valor|cu[aá]nto|cuesta)\b/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * parseLitrageOnlyMessage: ¿El mensaje es solo un litraje? (ej. "10L", "30 litros")
 *
 * @param {string} messageText
 * @returns {string|null} Litraje normalizado ("10L") o null
 */
export function parseLitrageOnlyMessage(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+)\s*(?:l|lt|lts|litros?)?\.?$/i);
  if (!m) return null;
  return `${m[1]}L`;
}

/**
 * parseBareQuantityWithoutUnit: Número suelto en el mensaje, sin unidad que lo aclare.
 * Sirve para saber si "2 mojito" pudo haber sido "2 barriles" (el bot lo lee como litros).
 * "2 mojito" → 2 | "mojito 10L" → null | "2x mojito" → null | "2 barriles" → null
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {number|null} El número suelto, o null si no hay ambigüedad
 */
export function parseBareQuantityWithoutUnit(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return null;
  // Unidad explícita: el cliente ya dijo si son litros o barriles
  if (/\d+\s*(?:l|lt|lts|litros?)\b/i.test(text)) return null;
  if (/\d+\s*[x×]/i.test(text)) return null;
  if (/\b(?:barril|barriles|unidad|unidades)\b/i.test(text)) return null;

  const numbers = text.match(/\b\d+\b/g) || [];
  if (numbers.length !== 1) return null;

  const n = parseInt(numbers[0], 10);
  return n >= 1 && n <= 20 ? n : null;
}

/**
 * matchCocktailNamesInText: Nombres del catálogo presentes en el mensaje (fuzzy).
 * Compartido por parsers con/sin litraje.
 *
 * @param {string} messageText
 * @param {string[]} catalogNames
 * @returns {string[]}
 */
function matchCocktailNamesInText(messageText, catalogNames) {
  const norm = normalizeString(messageText);
  const matched = [];

  // Nombres más largos primero (evita que "Mojito" robe "Mojito Maracuyá")
  const sorted = [...catalogNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const nameNorm = normalizeString(name);
    if (!nameNorm || !norm.includes(nameNorm)) continue;
    if (matched.some((m) => normalizeString(m).includes(nameNorm) || nameNorm.includes(normalizeString(m)))) {
      // Si ya hay uno más específico que contiene este, o viceversa, preferimos el más largo
      const worse = matched.findIndex((m) => {
        const mn = normalizeString(m);
        return mn !== nameNorm && (mn.includes(nameNorm) || nameNorm.includes(mn));
      });
      if (worse >= 0) {
        if (nameNorm.length > normalizeString(matched[worse]).length) matched[worse] = name;
        continue;
      }
    }
    if (!matched.includes(name)) matched.push(name);
  }

  // Tokens sueltos con fuzzy match (monito → Mojito, aperol → Aperol Spritz)
  // No re-matchear palabras ya cubiertas por un nombre completo (ej. "spritz" tras "Aperol Spritz")
  const covered = new Set();
  for (const m of matched) {
    for (const w of normalizeString(m).split(/\s+/)) {
      if (w.length >= 3) covered.add(w);
    }
  }

  const stop = new Set([
    'para', 'con', 'son', 'una', 'unos', 'quiero', 'dame', 'pon', 'agrega', 'y', 'el', 'la',
    'de', 'un', 'unos', 'barril', 'barriles', 'litro', 'litros'
  ]);
  const tokens = norm
    .replace(/\b\d+\s*(?:l|lt|lts|litros?)\b/g, ' ')
    .split(/[\s,;/+x×]+/)
    .filter((t) => t.length >= 3 && !stop.has(t) && !/^\d+$/.test(t) && !covered.has(t));

  for (const token of tokens) {
    const hit = findClosestCatalogMatch(token, catalogNames);
    if (!hit || matched.includes(hit)) continue;
    const hitNorm = normalizeString(hit);
    const isStrong = token.length >= 4
      || hitNorm.startsWith(token)
      || hitNorm.split(' ').some((w) => w.startsWith(token));
    if (isStrong) matched.push(hit);
  }

  return matched;
}

/**
 * parseCocktailNamesWithoutLitrage: Detecta sabores sin tamaño (typos incluidos).
 * Ej.: "Monito aperol" → ["Mojito", "Aperol Spritz"] antes de llamar al NLU.
 *
 * @param {string} messageText
 * @param {string[]} catalogNames
 * @returns {string[]}
 */
export function parseCocktailNamesWithoutLitrage(messageText, catalogNames) {
  const text = String(messageText || '').trim();
  if (!text) return [];
  if (/\b\d+\s*(?:l|lt|lts|litros?)\b/i.test(text)) return [];
  if (asksEventCartPriceQuestion(text) || /\?/.test(text)) return [];
  return matchCocktailNamesInText(text, catalogNames);
}

/**
 * parseEventProductsProgrammatic: Parsea pedidos de eventos sin IA.
 * Orientación litros-primero: "5L Mojito y 10L Aperol", "15L Sangria", "Mojito 10L".
 * Sin litros: "un mojito" → 1× defaultLitrage (típicamente 5L en dispensador).
 * Varios cócteles: cada segmento (separado por "y"/","/";") lleva su propio litraje.
 *
 * @param {string} messageText
 * @param {string[]} catalogNames
 * @param {string[]} allowedLitrages
 * @param {string} defaultLitrage
 * @returns {Array<{name: string, quantity: number, litrage: string}>}
 */
export function parseEventProductsProgrammatic(messageText, catalogNames, allowedLitrages, defaultLitrage) {
  // Multi-intent: "5L Mojito, ¿hacen despacho?" → parseamos solo la parte del pedido
  let text = String(messageText || '').trim();
  if (asksDeliveryOrDispatchQuestion(text)) {
    text = stripDeliveryQuestionForCart(text);
  }
  if (!text) return [];
  if (asksEventCartPriceQuestion(text) || /\?/.test(text)) return [];

  // Litrajes en todo el mensaje (para "Mojito y Sangría 10L" → ambos 10L)
  const allLitrageMatches = [...text.matchAll(/\b(\d+)\s*(?:l|lt|lts|litros?)\b/gi)];
  const sharedLitrage = allLitrageMatches.length === 1
    ? `${allLitrageMatches[0][1]}L`
    : null;

  // Un segmento por cóctel: "5L Mojito y 15L Sangria" → dos pedidos independientes
  const segments = text
    .split(/\s*(?:,|;|\by\b)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const parts = segments.length > 0 ? segments : [text];
  const results = [];

  for (const segment of parts) {
    const names = matchCocktailNamesInText(segment, catalogNames);
    if (!names.length) continue;

    const litrageMatch = segment.match(/\b(\d+)\s*(?:l|lt|lts|litros?)\b/i);
    // Conservamos litrajes no estándar (15L): validate/fixEvent los parte en barriles válidos
    let litrage = defaultLitrage;
    if (litrageMatch) {
      litrage = `${litrageMatch[1]}L`;
    } else if (sharedLitrage) {
      litrage = sharedLitrage;
    }

    // Cantidad de barriles: "2x Mojito 10L" / "2 Mojito" — no confundir con el número de litros
    let quantity = 1;
    const qtyMatch = segment.match(/\b(\d+)\s*[x×]\b/i)
      || segment.match(/\b(\d+)\s+(?:de\s+)?(?:barriles?\s+(?:de\s+)?)?/i)
      || segment.match(/\b(\d+)\s*[x×]?\s*(?=[A-Za-záéíóúÁÉÍÓÚñÑ])/i);
    if (qtyMatch) {
      const n = parseInt(qtyMatch[1], 10);
      if (litrageMatch && String(n) === litrageMatch[1] && !/[x×]/i.test(segment)) {
        quantity = 1;
      } else if (n >= 1 && n <= 20) {
        quantity = n;
      }
    }

    for (const name of names) {
      results.push({ name, quantity, litrage });
    }
  }

  return results;
}

/**
 * parseBarrilesProductsProgrammatic: Parsea pedidos de barriles desechables sin IA.
 * Formato típico: "2 mojitos y 1 sangría", "un aperol".
 * Si el mensaje mezcla duda de despacho, se limpia antes de parsear.
 *
 * @param {string} messageText
 * @param {string[]} catalogNames
 * @returns {Array<{name: string, quantity: number}>}
 */
export function parseBarrilesProductsProgrammatic(messageText, catalogNames) {
  let text = String(messageText || '').trim();
  if (asksDeliveryOrDispatchQuestion(text)) {
    text = stripDeliveryQuestionForCart(text);
  }
  if (!text) return [];
  // Otras preguntas (precio, ingredientes) las deja la NLU / FAQ
  if (/\?/.test(text)) return [];

  const segments = text
    .split(/\s*(?:,|;|\by\b)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = segments.length > 0 ? segments : [text];
  const results = [];

  for (const segment of parts) {
    const names = matchCocktailNamesInText(segment, catalogNames);
    if (!names.length) continue;

    let quantity = 1;
    const qtyMatch = segment.match(/\b(\d+)\s*[x×]\b/i)
      || segment.match(/\b(\d+)\s+(?:de\s+)?(?:barriles?\s+(?:de\s+)?)?/i)
      || segment.match(/\b(\d+)\s*[x×]?\s*(?=[A-Za-záéíóúÁÉÍÓÚñÑ])/i)
      || segment.match(/\b(un|una|unos|unas)\b/i);
    if (qtyMatch) {
      if (/^(un|una|unos|unas)$/i.test(qtyMatch[1])) {
        quantity = 1;
      } else {
        const n = parseInt(qtyMatch[1], 10);
        if (n >= 1 && n <= 50) quantity = n;
      }
    }

    for (const name of names) {
      results.push({ name, quantity });
    }
  }

  return results;
}

/**
 * validateEventProductLines: Mapea líneas NLU/programáticas al catálogo y valida litraje.
 *
 * @param {string} messageText
 * @param {Array<{name: string, quantity: number, litrage?: string}>} items
 * @param {string} formatKey - 'muro' | 'dispensador'
 * @param {string[]} allowedLitrages
 * @param {string} defaultLitrage
 * @param {string[]} catalogNames
 * @returns {{ parsedProducts: Array, invalidLitrages: Array }}
 */
export function validateEventProductLines(messageText, items, formatKey, allowedLitrages, defaultLitrage, catalogNames) {
  const parsedProducts = [];
  const invalidLitrages = [];

  for (const item of items || []) {
    if (!item?.name || !item.quantity) continue;
    const matchedName = findClosestCatalogMatch(item.name, catalogNames);
    if (!matchedName) continue;

    const fixedProducts = fixEventLitrageShorthand(
      messageText,
      { name: matchedName, quantity: item.quantity, litrage: item.litrage || defaultLitrage },
      allowedLitrages,
      defaultLitrage
    );

    for (const fixed of fixedProducts) {
      const litragesToTry = [fixed.litrage];
      // NLU a veces devuelve 5L en Muro; reintentamos con 10L antes de fallar
      if (formatKey === 'muro' && fixed.litrage === '5L') litragesToTry.push('10L');

      let added = false;
      for (const tryL of litragesToTry) {
        if (!allowedLitrages.includes(tryL)) continue;
        const price = preciosData.cocteles[matchedName]?.[formatKey]?.[tryL];
        if (price == null) continue;
        parsedProducts.push({ name: matchedName, quantity: fixed.quantity, litrage: tryL });
        added = true;
        break;
      }
      if (!added) {
        invalidLitrages.push({ name: matchedName, litrage: fixed.litrage });
      }
    }
  }

  return { parsedProducts, invalidLitrages };
}

/**
 * applyEventDataFromMessage: Extrae celebración, comuna, fecha, invitados y guarda en sesión.
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {boolean}
 */
export function applyEventDataFromMessage(messageText, session) {
  let hasNewInfo = false;

  // Auto-respuesta de otro bot/negocio: no extraer celebración, comuna ni invitados
  if (isLikelyThirdPartyBotReply(messageText)) {
    return false;
  }

  const celebration = parseCelebrationType(messageText);
  if (celebration && celebration !== session.celebrationType) {
    session.celebrationType = celebration;
    hasNewInfo = true;
  }

  // Fecha antes que comuna: "en diciembre" es mes, no ubicación
  const dateSearch = parseDate(messageText);
  if (dateSearch) {
    session.date = dateSearch;
    hasNewInfo = true;
  }

  const locationSearch = findLocationByFuzzyMatch(messageText);
  if (locationSearch) {
    session.location = locationSearch.name;
    session.isRM = locationSearch.isRM;
    session.region = locationSearch.region;
    hasNewInfo = true;
  } else {
    // Fallback: "en Talca" u otra ciudad fuera del catálogo fuzzy
    // Solo rechazamos si la captura ENTERA es un stopword ("la"), no si empieza con "la condes"
    const locationMatch = messageText.match(
      /\b(?:en|comuna(?:\s+de)?)\s+((?:(?:el|la|los|las|lo)\s+)?[A-Za-záéíóúÁÉÍÓÚñÑ0-9]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ0-9]+){0,3})\b/i
    );
    if (locationMatch) {
      const captured = locationMatch[1].trim();
      // Si la captura es el mismo mes/fecha que ya detectamos, no la guardamos como comuna
      if (isValidFreeformLocationCapture(captured)) {
        const fuzzyCaptured = findLocationByFuzzyMatch(captured);
        session.location = fuzzyCaptured?.name || captured;
        session.isRM = fuzzyCaptured?.isRM ?? false;
        session.region = fuzzyCaptured?.region ?? null;
        hasNewInfo = true;
      }
    }
  }

  // Invitados: si ya hay un valor, solo lo pisamos con mención explícita
  // ("50 invitados"). Así "15 de diciembre" no cambia 50 → 15.
  const guests = extractGuestsFromMessage(messageText);
  if (guests !== null) {
    const explicitGuests = /\b\d+\s*(personas|invitados|pax|inv)\b/i.test(messageText);
    if (explicitGuests || session.guests == null || session.guests === '') {
      session.guests = guests;
      hasNewInfo = true;
    }
  }

  return hasNewInfo;
}

/**
 * getEventFormatKey: "Muro de Coctelería" → "muro"; otro → "dispensador".
 *
 * @param {string} eventoFormato
 * @returns {'muro'|'dispensador'}
 */
export function getEventFormatKey(eventoFormato) {
  return eventoFormato === 'Muro de Coctelería' ? 'muro' : 'dispensador';
}

/**
 * getMinLitersForFormat: Pedido mínimo en litros.
 *
 * @param {string} formatKey
 * @returns {number}
 */
export function getMinLitersForFormat(formatKey) {
  return formatKey === 'muro' ? 30 : 10;
}

/**
 * getAllowedLitrages: Litrajes válidos del formato.
 *
 * @param {string} formatKey
 * @returns {string[]}
 */
export function getAllowedLitrages(formatKey) {
  return formatKey === 'muro' ? ['10L', '20L', '30L'] : ['5L', '10L'];
}

/**
 * ensureEventOrderBuilder: Crea o reinicia el carrito de eventos.
 *
 * @param {object} session
 * @param {string} formatKey
 */
export function ensureEventOrderBuilder(session, formatKey) {
  if (!session.orderBuilder || session.orderBuilder.type !== formatKey) {
    session.orderBuilder = {
      type: formatKey,
      products: {},
      extras: {},
      clientData: {
        date: session.date || null,
        location: session.location || null,
        guests: session.guests || null
      }
    };
  }
}

/**
 * formatEventCartSummary: Lista el carrito con precios.
 *
 * @param {object} products
 * @param {string} formatKey
 * @returns {string}
 */
export function formatEventCartSummary(products, formatKey) {
  let reply = '';
  for (const entry of Object.values(products)) {
    const price = preciosData.cocteles[entry.name]?.[formatKey]?.[entry.litrage] || 0;
    reply += `- ${entry.quantity}x ${entry.name} (${entry.litrage}): ${formatPrice(price * entry.quantity)}\n`;
  }
  return reply;
}

/**
 * formatEventCartTotalsLine: Subtotal + litros (+ mínimo) + cócteles ≈.
 * Usa totalDrinks de OrderBuilder (tabla rendimientos_barriles / 5 por litro).
 *
 * @param {{ subtotal: number, totalLiters?: number, totalDrinks?: number }} quote
 * @param {{ minLiters?: number }} [opts]
 * @returns {string}
 */
export function formatEventCartTotalsLine(quote, opts = {}) {
  const liters = Number(quote?.totalLiters) || 0;
  const drinks = Number(quote?.totalDrinks);
  const approxDrinks = Number.isFinite(drinks) && drinks > 0
    ? drinks
    : liters * 5;
  const minPart = opts.minLiters != null ? ` (mín. ${opts.minLiters}L)` : '';
  return `*Subtotal:* ${formatPrice(quote?.subtotal || 0)} | *Litros:* ${liters}L${minPart} | ≈ *${approxDrinks}* cócteles`;
}

/**
 * getEventPriceListImage: Foto de la carta según formato (Dispensador o Muro).
 * Igual que barriles con barril_desechable_precios.webp.
 *
 * @param {'dispensador'|'muro'|string} formatKey
 * @param {string} [caption] - Texto opcional bajo la imagen
 * @returns {{ type: 'image', file: string, caption?: string }}
 */
export function getEventPriceListImage(formatKey, caption = 'Aquí va la lista de sabores y precios 👆') {
  const file = formatKey === 'muro'
    ? 'muro_de_cocteleria_precios.webp'
    : 'dispensador_portatil_precios.webp';
  return img(file, caption);
}

/**
 * buildMenuEntryReplies: Imagen de precios + hint de litros/rendimiento + pregunta (3 burbujas).
 * Lo usa EVENTOS_INTRO_MENU al confirmar (sí/ok), no al elegir el formato.
 *
 * @param {object} session
 * @param {string} formatKey
 * @returns {Array<string|{ type: 'image', file: string, caption?: string }>}
 */
export function buildMenuEntryReplies(session, formatKey) {
  const litersHint = getEventLitersSuggestion(session.guests, formatKey);
  return [
    getEventPriceListImage(formatKey),
    litersHint,
    // Litros primero: orienta al cliente al patrón más común (ej. "5L Mojito y 10L Aperol")
    ASK_EVENT_COCKTAILS
  ];
}

/**
 * buildEventQuoteFromSession: Cotización con OrderBuilder + sesión.
 *
 * @param {object} session
 * @returns {{ quote: object, deliveryCost: number|null, formatKey: string }}
 */
export function buildEventQuoteFromSession(session) {
  const formatKey = getEventFormatKey(session.eventoFormato);
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  orderBuilder.products = session.orderBuilder?.products || {};
  orderBuilder.extras = session.orderBuilder?.extras || {};

  let deliveryCost = null;
  if (session.location) {
    const locationSearch = findLocationByFuzzyMatch(session.location);
    if (locationSearch?.isRM && locationSearch.deliveryCost?.evento != null) {
      deliveryCost = locationSearch.deliveryCost.evento;
    }
  }

  const quote = orderBuilder.calculateQuote(deliveryCost);
  return { quote, deliveryCost, formatKey };
}
