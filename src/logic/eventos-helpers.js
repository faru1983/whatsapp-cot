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
  isValidFreeformLocationCapture,
  groupCocktailLinesByName,
  formatEventCocktailLitersLine
} from './utils.js';
import { isLikelyThirdPartyBotReply } from './interruptions.js';
import { OrderBuilder } from './order-builder.js';
import { img } from './media.js';
import { normalizeBotDateText } from './cot-event-quote.js';

/** Ejemplo canónico (litros primero) — intro menú + re-preguntas. */
export const EVENT_COCKTAIL_ORDER_EXAMPLE = '5L Mojito y 10L Aperol';

/** Pregunta estándar al pedir cócteles del evento. Estilo: *pregunta* + _(ej: …)_. */
export const ASK_EVENT_COCKTAILS = `*¿Qué cócteles te gustaría incluir en tu evento?*
_(ej: ${EVENT_COCKTAIL_ORDER_EXAMPLE})_`;

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
    [/empresa|corporativ|oficina|trabajo/i, 'Empresa'],
    [/otros?\b/i, 'Otro'],
    [/bautizo|bautismo/i, 'Bautizo'],
    [/revelaci[oó]n\s+de\s+g[eé]nero|rebelaci[oó]n\s+de\s+g[eé]nero|gender\s*reveal/i, 'Revelación de género'],
    [/comuni[oó]n/i, 'Primera Comunión'],
    [/graduaci[oó]n|egreso/i, 'Graduación'],
    [/aniversario/i, 'Aniversario'],
    [/baby\s*shower|babyshower/i, 'Baby shower'],
    [/despedida/i, 'Despedida'],
    [/fiesta|celebraci[oó]n|evento/i, 'Celebración']
  ];
  for (const [re, label] of map) {
    if (re.test(lower)) return label;
  }
  return null;
}

/**
 * normalizeCelebrationLabel: Limpia y unifica la etiqueta de celebración
 * (parser local o NLU). Rechaza textos vacíos o demasiado largos.
 *
 * @param {string} raw - Etiqueta cruda
 * @returns {string|null}
 */
export function normalizeCelebrationLabel(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length < 2 || cleaned.length > 40) return null;
  if (/^(unclear|null|none|n\/a|unknown|skip)$/i.test(cleaned)) return null;

  // Preferimos etiquetas canónicas del parser (Cumpleaños, Matrimonio, Bautizo…)
  const fromParser = parseCelebrationType(cleaned);
  if (fromParser) return fromParser;

  // Capitalizar primera letra; el resto se deja como vino (nombres propios)
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * wantsSkipCelebrationType: ¿No sabe / no quiere decir el tipo de evento?
 * Ej.: "ninguno", "aún no lo sé", "au no lo se", "no sé".
 * En ese caso avanzamos sin guardar celebración (queda "Por confirmar").
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsSkipCelebrationType(messageText) {
  const t = String(messageText || '').trim();
  if (!t || t.length > 80) return false;

  const norm = t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.…,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^ningun[oa]s?$/.test(norm)) return true;
  if (/^(no se|no lo se|nse)$/.test(norm)) return true;
  if (/^(au|aun|todavia) no( lo)?( se)?$/.test(norm)) return true;
  if (/^(au|aun|todavia) no lo se$/.test(norm)) return true;
  if (/^(sin|por) definir$/.test(norm)) return true;
  if (/^(no importa|da igual|prefiero no( decir)?)$/.test(norm)) return true;
  if (/^(no tengo( (idea|definido|claro))?|no lo tengo( claro)?)$/.test(norm)) return true;
  if (/^(au|aun|todavia) no lo tengo( claro)?$/.test(norm)) return true;
  return false;
}

/**
 * looksLikeCelebrationUncertainty: ¿El texto habla de no saber / no tener claro el tipo?
 * Sirve para corroborar un skip del NLU (evitar que gibberish avance a "Por confirmar").
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function looksLikeCelebrationUncertainty(messageText) {
  if (wantsSkipCelebrationType(messageText)) return true;

  const norm = String(messageText || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.…,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!norm || norm.length < 3) return false;

  // Señales de incertidumbre (más amplias que el skip exacto de keywords)
  return /\b(no\s+se|no\s+lo\s+se|aun\s+no|todavia\s+no|sin\s+definir|por\s+definir|no\s+tengo|no\s+lo\s+tengo|da\s+igual|prefiero\s+no|ningun[oa]?|no\s+claro|sin\s+definir|mas\s+adelante|por\s+ahora\s+no)\b/.test(norm);
}

/**
 * wantsSkipEventLogistics: ¿Quiere omitir fecha y/o comuna (pregunta C)?
 * Cubre "después"/"ok" cortos y frases naturales ("el lugar aún no lo sé").
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsSkipEventLogistics(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return false;

  // Skip corto (ok / después / no sé)
  if (/^(despu[eé]s|luego|ok|okay|dale|listo|continuar|seguir|no\s*s[eé]|ns[eé]|omitir|skip|por\s+ahora\s+no)(\s+gracias)?[.!]?$/i.test(t)) {
    return true;
  }

  const lower = t.toLowerCase();

  // No sabe lugar / comuna / ubicación / fecha
  if (/\b(lugar|comuna|ubicaci[oó]n|direcci[oó]n|sitio|local)\b/i.test(lower)
      && /\b(a[uú]n\s+no|todav[ií]a\s+no|no\s+lo\s+s[eé]|no\s+s[eé]|no\s+tengo|por\s+definir|sin\s+definir)\b/i.test(lower)) {
    return true;
  }
  if (/\b(fecha|d[ií]a|cu[aá]ndo)\b/i.test(lower)
      && /\b(a[uú]n\s+no|todav[ií]a\s+no|no\s+lo\s+s[eé]|no\s+s[eé]|no\s+tengo|por\s+definir)\b/i.test(lower)
      && !/\b(pr[oó]ximo\s+a[nñ]o|a[nñ]o\s+que\s+viene|\d{1,2}\s+de\s+\w+)\b/i.test(lower)) {
    // "aún no sé la fecha" sin otro dato → skip; si dijo "próximo año" no es skip total
    return true;
  }
  if (/\b(no\s+tengo\s+(fecha|comuna|lugar)|sin\s+(fecha|comuna|lugar)\s+a[uú]n|despu[eé]s\s+te\s+(digo|confirmo))\b/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * wantsUnknownLocationOnly: ¿Dice que no sabe el lugar pero puede haber dado fecha?
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsUnknownLocationOnly(messageText) {
  const lower = String(messageText || '').toLowerCase();
  if (!/\b(lugar|comuna|ubicaci[oó]n|direcci[oó]n|sitio|local)\b/i.test(lower)) return false;
  return /\b(a[uú]n\s+no|todav[ií]a\s+no|no\s+lo\s+s[eé]|no\s+s[eé]|no\s+tengo|por\s+definir)\b/i.test(lower);
}

/**
 * wantsEventInfoOnly: ¿No tiene evento real y solo busca precios / info a futuro?
 * Ej.: "solo quiero cotizar", "aún no tengo evento", "para el futuro".
 * En ese caso lo invitamos a cotizar en la web (simulador).
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsEventInfoOnly(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  if (/\b(solo\s+(quiero\s+)?(cotizar|ver\s+precios|precios|informaci[oó]n|info)|solo\s+info(rmarme)?)\b/i.test(lower)) {
    return true;
  }
  if (/\b(solo\s+quiero\s+(saber|ver|consultar)\s+(los\s+)?precios?)\b/i.test(lower)) {
    return true;
  }
  if (/\b((a[uú]n\s+)?no\s+tengo\s+(un\s+)?evento|sin\s+evento\s+(todav[ií]a|a[uú]n|definido)|no\s+es\s+para\s+(un\s+)?evento|no\s+tengo\s+celebraci[oó]n)\b/i.test(lower)) {
    return true;
  }
  if (/\b(para\s+el\s+futuro|m[aá]s\s+adelante|por\s+ahora\s+solo(\s+info)?|estoy\s+(averiguando|investigando|viendo\s+opciones|cotizando\s+nomas|cotizando\s+nom[aá]s))\b/i.test(lower)) {
    return true;
  }
  if (/\b(no\s+tengo\s+nada\s+concret[oa]|solo\s+estoy\s+mirando\s+precios)\b/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * asksEquipmentOrResaleQuestion: ¿Pregunta si se vende/compra el equipo (dispensador/muro)?
 * No es “solo info sin evento”: debe ir a FAQ / strike, no soft-close a la web.
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksEquipmentOrResaleQuestion(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  return /\b(se\s+pueden\s+comprar|puedo\s+comprar|se\s+vende|venden|comprar\s+(el\s+)?(dispensador|muro|equipo|m[aá]quina)|vendemos|para\s+comprar)\b/i.test(lower);
}

/**
 * wantsUnknownGuestsCount: ¿Dice que aún no sabe cuántos invitados?
 * No es “sin evento”: re-preguntamos un aproximado.
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsUnknownGuestsCount(messageText) {
  const t = String(messageText || '').trim();
  if (!t || t.length > 120) return false;
  const lower = t.toLowerCase();
  if (/\b(a[uú]n\s+no\s+s[eé]|todav[ií]a\s+no\s+s[eé]|no\s+s[eé]|no\s+tengo\s+claro)\b/i.test(lower)
      && /\b(cu[aá]ntos|cantidad|invitad|personas|gente|ser[aá]n|van\s+a\s+ser)\b/i.test(lower)) {
    return true;
  }
  if (/^(no\s+s[eé]|a[uú]n\s+no|todav[ií]a\s+no)(\s+cu[aá]ntos)?[.!]?$/i.test(t)
      && !wantsEventInfoOnly(t)) {
    // Solo si el paso ya pidió invitados; el caller decide el contexto
    return /cu[aá]ntos|invitad|aprox/i.test(lower) || /ser[aá]n/i.test(lower);
  }
  return false;
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
 * hasCoverageIntentVerb: ¿El texto suena a pregunta de cobertura/llegada?
 * Ej.: "llegan", "van a", "atienden en", "hacen despacho".
 *
 * @param {string} lower - Mensaje en minúsculas
 * @returns {boolean}
 */
function hasCoverageIntentVerb(lower) {
  return /\b(van|llegan|llegamos|atienden|despachan|realizan|trabajan|pueden|cubren|cubre)\b/i.test(lower)
    || /\b(hacen\s+(env[ií]o|despacho)|hay\s+cobertura|cobertura)\b/i.test(lower);
}

/**
 * resolvePlaceForCoverage: Ubica comuna o región de Chile con datos.json.
 * Sirve para responder cobertura sin hardcodear ciudades sueltas.
 *
 * @param {string} messageText
 * @returns {{ name: string, region: string, isRM: boolean, kind: 'rm'|'outside' }|null}
 */
export function resolvePlaceForCoverage(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return null;

  // 1) Comuna conocida (RM o regiones_chile)
  const comuna = findLocationByFuzzyMatch(trimmed);
  if (comuna) {
    return {
      name: comuna.name,
      region: comuna.region,
      isRM: Boolean(comuna.isRM),
      kind: comuna.isRM ? 'rm' : 'outside'
    };
  }

  // 2) Nombre de región (ej. "región de Valparaíso", "Coquimbo")
  const normMsg = normalizeString(trimmed);
  const regionesChile = preciosData.regiones_chile || {};
  let bestRegion = null;
  let bestLen = 0;
  for (const regionName of Object.keys(regionesChile)) {
    const normRegion = normalizeString(regionName);
    if (!normRegion || normRegion.length < 4) continue;
    // Frase completa: evita que "rio" mate regiones largas al azar
    const escaped = normRegion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(normMsg) && normRegion.length > bestLen) {
      bestRegion = regionName;
      bestLen = normRegion.length;
    }
  }
  if (bestRegion) {
    const isRM = /metropolitana/i.test(bestRegion);
    return {
      name: bestRegion,
      region: bestRegion,
      isRM,
      kind: isRM ? 'rm' : 'outside'
    };
  }

  // 3) Pistas de RM / Santiago sin comuna concreta
  if (/\b(regi[oó]n\s+metropolitana|\brm\b|santiago)\b/i.test(trimmed)) {
    return {
      name: 'Región Metropolitana',
      region: 'Región Metropolitana',
      isRM: true,
      kind: 'rm'
    };
  }

  return null;
}

/**
 * asksCoverageAreaQuestion: ¿Pregunta si atendemos una ciudad/comuna (no está dando su dato)?
 * Ej.: "¿van a la serena?", "¡Hola! Llegan. Viña Del Mar?".
 * Detecta verbo de cobertura + lugar de datos.json (no solo lista fija de ciudades).
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksCoverageAreaQuestion(messageText) {
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  const looksLikeQuestion = /\?/.test(trimmed) || hasCoverageIntentVerb(lower);
  if (!looksLikeQuestion) return false;

  // Frases explícitas de cobertura/llegada
  if (/\b(van\s+a|llegan\s+a|llegamos\s+a|atienden\s+en|despachan\s+a|hacen\s+en|trabajan\s+en|cubren)\b/i.test(lower)) {
    return true;
  }
  if (/\b(fuera\s+de\s+santiago|fuera\s+de\s+(la\s+)?rm|regiones?|regi[oó]n)\b/i.test(lower)
      && hasCoverageIntentVerb(lower)) {
    return true;
  }

  // Verbo/pregunta + comuna/región conocida en datos.json (Viña, Temuco, etc.)
  if (hasCoverageIntentVerb(lower) && resolvePlaceForCoverage(trimmed)) {
    return true;
  }

  // Pregunta con "?" y lugar conocido ("¿Viña del Mar?" raro, pero "Llegan. Viña?")
  if (/\?/.test(trimmed) && resolvePlaceForCoverage(trimmed) && hasCoverageIntentVerb(lower)) {
    return true;
  }

  return false;
}

/**
 * buildEventosCoverageReply: Copy fijo de cobertura Eventos (sin LLM).
 * RM = todas las comunas; fuera de RM = evaluar por tamaño/fecha; referencia Valparaíso/Coquimbo.
 * No afirma cobertura fija fuera de la RM ni da la bienvenida a la ciudad.
 *
 * @param {string} messageText
 * @returns {string}
 */
export function buildEventosCoverageReply(messageText) {
  const place = resolvePlaceForCoverage(messageText);

  if (place?.kind === 'rm') {
    if (place.name && place.name !== 'Región Metropolitana') {
      return `Sí: *${place.name}* está en la *Región Metropolitana*. En *Servicio para Eventos* llegamos a *todas las comunas* de la RM. 🍸`;
    }
    return `Sí: en *Servicio para Eventos* llegamos a *todas las comunas* de la *Región Metropolitana*. 🍸`;
  }

  if (place?.kind === 'outside') {
    // Corto: sin preámbulo “Sobre X queda fuera…” (suena a razonamiento interno)
    return `Fuera de la RM lo evaluamos caso a caso según el *tamaño del evento* y la *disponibilidad de la fecha*. Tenemos experiencia en *Valparaíso* y *Coquimbo*; lo ideal es *seguir cotizando* y el equipo confirma si podemos viajar. 🥂`;
  }

  return `Fuera de la RM lo evaluamos según el *tamaño del evento* y la *fecha*. Tenemos experiencia en *Valparaíso* y *Coquimbo*; lo ideal es *seguir cotizando* y el equipo confirma si podemos viajar. 🥂`;
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
 * REPLY_DISPATCH_SIDEBAR_EVENTOS: Cobertura corta en carrito Eventos (multi-intent).
 * RM cubierta; fuera = evaluación (no cobertura fija Serena/Coquimbo).
 */
export const REPLY_DISPATCH_SIDEBAR_EVENTOS =
  '📦 Sobre *cobertura*: en eventos llegamos a toda la *Región Metropolitana*. Fuera de la RM lo evaluamos según tamaño y fecha (experiencia de referencia en *Valparaíso* y *Coquimbo*); seguimos cotizando y el equipo confirma.';

/**
 * REPLY_DISPATCH_SIDEBAR_BARRILES: Despacho corto en carrito Barriles (multi-intent).
 */
export const REPLY_DISPATCH_SIDEBAR_BARRILES =
  '📦 Sobre *despacho*: los *Barriles Desechables* van a todo Chile (RM según comuna; regiones por encomienda). El costo se confirma al armar la compra.';

/**
 * REPLY_DISPATCH_SIDEBAR: Alias legacy → Barriles (imports antiguos).
 * @deprecated Preferir REPLY_DISPATCH_SIDEBAR_BARRILES / _EVENTOS
 */
export const REPLY_DISPATCH_SIDEBAR = REPLY_DISPATCH_SIDEBAR_BARRILES;
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
export function matchCocktailNamesInText(messageText, catalogNames) {
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
 * findCatalogNameHits: Ubica cócteles del catálogo en el texto (posiciones).
 * Nombres largos primero; también tokens fuzzy (monito→Mojito, aperol→Aperol Spritz).
 *
 * @param {string} messageText
 * @param {string[]} catalogNames
 * @returns {Array<{ name: string, index: number, end: number }>}
 */
function findCatalogNameHits(messageText, catalogNames) {
  const norm = normalizeString(messageText);
  if (!norm) return [];

  const hits = [];
  const used = new Array(norm.length).fill(false);
  const sorted = [...catalogNames].sort((a, b) => b.length - a.length);

  // 1) Nombres completos del catálogo
  for (const name of sorted) {
    const nameNorm = normalizeString(name);
    if (!nameNorm || nameNorm.length < 3) continue;
    let from = 0;
    while (from < norm.length) {
      const idx = norm.indexOf(nameNorm, from);
      if (idx < 0) break;
      const end = idx + nameNorm.length;
      const free = used.slice(idx, end).every((u) => !u);
      // Borde de palabra aproximado (evita match dentro de otra palabra)
      const leftOk = idx === 0 || /[\s,;./+]/.test(norm[idx - 1]);
      const rightOk = end >= norm.length || /[\s,;./+]/.test(norm[end]);
      if (free && leftOk && rightOk) {
        for (let i = idx; i < end; i++) used[i] = true;
        hits.push({ name, index: idx, end });
      }
      from = idx + 1;
    }
  }

  // 2) Tokens sueltos con fuzzy (solo zonas aún libres)
  const stop = new Set([
    'para', 'con', 'son', 'una', 'unos', 'quiero', 'dame', 'pon', 'agrega', 'y', 'el', 'la',
    'de', 'un', 'unos', 'barril', 'barriles', 'litro', 'litros'
  ]);
  const tokenRe = /[a-z0-9]{3,}/g;
  let tm;
  while ((tm = tokenRe.exec(norm)) !== null) {
    const token = tm[0];
    const idx = tm.index;
    const end = idx + token.length;
    if (stop.has(token) || /^\d+$/.test(token)) continue;
    if (used.slice(idx, end).some((u) => u)) continue;
    // Misma fuzzy que matchCocktailNamesInText (monito→Mojito, aperol→Aperol Spritz)
    const fuzzyHits = matchCocktailNamesInText(token, catalogNames);
    if (fuzzyHits.length !== 1) continue;
    const name = fuzzyHits[0];
    // No duplicar si ya está el mismo nombre muy cerca
    if (hits.some((h) => h.name === name && Math.abs(h.index - idx) < 8)) continue;
    for (let i = idx; i < end; i++) used[i] = true;
    hits.push({ name, index: idx, end });
  }

  return hits.sort((a, b) => a.index - b.index);
}

/**
 * assignLitrageToNameHits: Empareja cada cóctel con el litraje más cercano.
 * Un litraje solo se usa una vez (así "Mojito 5L y Sangria 10L" no deja ambos en 5L).
 *
 * @param {Array<{ name: string, index: number, end: number }>} nameHits
 * @param {Array<{ liters: string, index: number, end: number }>} litHits
 * @param {string|null} sharedLitrage
 * @param {string} defaultLitrage
 * @returns {string[]} litraje por índice de nameHits
 */
function assignLitrageToNameHits(nameHits, litHits, sharedLitrage, defaultLitrage) {
  const result = nameHits.map(() => null);
  if (nameHits.length === 0) return result;

  const pairs = [];
  for (let li = 0; li < litHits.length; li++) {
    const lit = litHits[li];
    for (let ni = 0; ni < nameHits.length; ni++) {
      const hit = nameHits[ni];
      let dist;
      if (lit.end <= hit.index) dist = hit.index - lit.end;
      else if (lit.index >= hit.end) dist = lit.index - hit.end;
      else dist = 0;
      if (dist > 32) continue;
      pairs.push({ li, ni, dist });
    }
  }
  // Más cerca primero; empate: preferir litraje pegado al nombre
  pairs.sort((a, b) => a.dist - b.dist);

  const usedLit = new Set();
  const usedName = new Set();
  for (const p of pairs) {
    if (usedLit.has(p.li) || usedName.has(p.ni)) continue;
    usedLit.add(p.li);
    usedName.add(p.ni);
    result[p.ni] = `${litHits[p.li].liters}L`;
  }

  for (let i = 0; i < result.length; i++) {
    if (!result[i]) result[i] = sharedLitrage || defaultLitrage;
  }
  return result;
}

/**
 * rangesOverlap: ¿Dos rangos [a,b) se cruzan?
 *
 * @param {number} a0
 * @param {number} a1
 * @param {number} b0
 * @param {number} b1
 * @returns {boolean}
 */
function rangesOverlap(a0, a1, b0, b1) {
  return a0 < b1 && a1 > b0;
}

/**
 * collectLitrageHits: Números que significan *litros* en el mensaje.
 * Cubre: "15L", "15 lt", "5 de aperol", "5 aperol" (volumen típico ≥5).
 * No cubre "2 mojito" (queda para el menú de barriles).
 *
 * @param {string} normText - Texto ya normalizado
 * @param {Array<{ name: string, index: number, end: number }>} nameHits
 * @returns {Array<{ liters: string, index: number, end: number }>}
 */
function collectLitrageHits(normText, nameHits) {
  const hits = [];
  const used = [];

  const mark = (start, end, liters) => {
    if (used.some(([a, b]) => rangesOverlap(start, end, a, b))) return;
    hits.push({ liters: String(liters), index: start, end });
    used.push([start, end]);
  };

  // 1) Explícito: "15L", "10 lt", "20 litros"
  for (const m of normText.matchAll(/\b(\d+)\s*(?:l|lt|lts|litros?)\b/g)) {
    mark(m.index, m.index + m[0].length, m[1]);
  }

  // 2) Atajo chileno: "5 de aperol", "10 de mojito" → siempre litros
  for (const m of normText.matchAll(/\b(\d+)\s+de\b/g)) {
    const start = m.index;
    const end = m.index + m[0].length;
    const nearName = nameHits.some((h) => h.index >= end - 1 && h.index - end <= 16);
    if (!nearName) continue;
    mark(start, end, m[1]);
  }

  // 3) Número suelto pegado al cóctel: "5 aperol", "15 sangria"
  // Solo volúmenes típicos (≥5): "2 mojito" no entra aquí (sigue al menú barriles).
  for (const nameHit of nameHits) {
    const before = normText.slice(Math.max(0, nameHit.index - 10), nameHit.index);
    const m = before.match(/(\d+)\s*$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 5 || n > 60) continue;
    const start = nameHit.index - m[0].length;
    const end = nameHit.index;
    mark(start, end, n);
  }

  return hits.sort((a, b) => a.index - b.index);
}

/**
 * quantityNearNameHit: "2x Mojito 10L" → 2; el número de litros no cuenta como cantidad.
 *
 * @param {string} normText
 * @param {{ index: number, end: number }} hit
 * @param {string} litrage
 * @returns {number}
 */
function quantityNearNameHit(normText, hit, litrage) {
  // Solo el texto justo antes del nombre; sacamos litros (con L o "N de") para no contarlos otra vez
  const windowStart = Math.max(0, hit.index - 18);
  const before = normText
    .slice(windowStart, hit.index)
    .replace(/\b\d+\s*(?:l|lt|lts|litros?)\b/g, ' ')
    .replace(/\b\d+\s+de\b/g, ' ')
    .trim();
  const qtyMatch = before.match(/(\d+)\s*[x×]\s*$/i)
    || before.match(/(\d+)\s+(?:de\s+)?(?:barriles?\s+(?:de\s+)?)?\s*$/i)
    || before.match(/(?:^|\s)(\d+)\s*$/);
  if (!qtyMatch) return 1;
  const n = parseInt(qtyMatch[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 20) return 1;
  const litNum = String(parseInt(litrage, 10));
  // "5 aperol" con litrage 5L → el 5 ya es litros, no 5 barriles
  if (String(n) === litNum && !/[x×]/i.test(before)) return 1;
  if (n >= 5 && !/[x×]/i.test(before) && !/\bbarriles?\b/i.test(before)) return 1;
  return n;
}

/**
 * parseEventProductsProgrammatic: Parsea pedidos de eventos sin IA.
 * Orientación litros-primero: "5L Mojito y 10L Aperol", "15L Sangria", "5 de aperol".
 * Cada cóctel toma su litraje más cercano (así "15L mojito y 5 de aperol" no deja ambos en 15L).
 * Sin litros: "un mojito" → 1× defaultLitrage (típicamente 5L en dispensador).
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

  const normText = normalizeString(text);
  const nameHits = findCatalogNameHits(text, catalogNames);
  if (nameHits.length === 0) return [];

  // Litros explícitos + atajos "5 de aperol" / "5 aperol" (≥5)
  const litHits = collectLitrageHits(normText, nameHits);
  // Un solo litraje en el mensaje → aplica a todos ("Mojito y Sangría 10L")
  const sharedLitrage = litHits.length === 1 ? `${litHits[0].liters}L` : null;

  const litrages = assignLitrageToNameHits(nameHits, litHits, sharedLitrage, defaultLitrage);
  const results = [];
  const seen = new Set();
  for (let i = 0; i < nameHits.length; i++) {
    const hit = nameHits[i];
    if (seen.has(hit.name)) continue;
    seen.add(hit.name);
    const litrage = litrages[i];
    const quantity = quantityNearNameHit(normText, hit, litrage);
    results.push({ name: hit.name, quantity, litrage });
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

  // Fecha antes que comuna: "en diciembre" es mes, no ubicación.
  // Si hay día concreto → DD/MM/YYYY (año Chile / próximo si ya pasó).
  const dateSearch = parseDate(messageText);
  if (dateSearch) {
    session.date = normalizeBotDateText(dateSearch) || dateSearch;
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
 * formatEventCartSummary: Lista el carrito en litros (lo que entiende el cliente).
 * Internamente el carrito sigue en barriles; acá agrupamos por cóctel:
 * "20L Mojito (2×10L): $…" / "15L Aperol Spritz (10L + 5L): $…".
 *
 * @param {object} products - session.orderBuilder.products
 * @param {string} formatKey - 'dispensador' | 'muro'
 * @returns {string}
 */
export function formatEventCartSummary(products, formatKey) {
  const lines = Object.values(products || {}).map((entry) => {
    const unitPrice = preciosData.cocteles[entry.name]?.[formatKey]?.[entry.litrage] || 0;
    return {
      name: entry.name,
      quantity: entry.quantity,
      litrage: entry.litrage,
      price: unitPrice,
      lineTotal: unitPrice * (entry.quantity || 0)
    };
  });
  return groupCocktailLinesByName(lines)
    .map((g) => formatEventCocktailLitersLine(g, { prefix: '-' }))
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join('');
}

/**
 * formatEventCartTotalsLine: Subtotal; debajo resumen corto de litros/cócteles/por persona.
 * El mínimo del formato ya se dijo antes: no se repite aquí.
 *
 * @param {{ subtotal: number, totalLiters?: number, totalDrinks?: number }} quote
 * @param {{ guests?: number|null }} [opts]
 * @returns {string}
 */
export function formatEventCartTotalsLine(quote, opts = {}) {
  const liters = Number(quote?.totalLiters) || 0;
  const drinks = Number(quote?.totalDrinks);
  const approxDrinks = Number.isFinite(drinks) && drinks > 0
    ? drinks
    : liters * 5;

  // Una sola línea en cursiva: fácil de leer en el móvil
  let litersLine = `_${liters}L | ${approxDrinks} cócteles`;

  const guests = Number(opts.guests);
  if (guests > 0 && approxDrinks > 0) {
    const perPerson = approxDrinks / guests;
    const perPersonStr = Number.isInteger(perPerson)
      ? String(perPerson)
      : perPerson.toFixed(1);
    litersLine += ` | ${perPersonStr} x persona`;
  }
  litersLine += `_`;

  return `*Subtotal:* ${formatPrice(quote?.subtotal || 0)}
${litersLine}`;
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
 * buildMenuEntryReplies: Imagen de precios + pregunta de cócteles (2 burbujas).
 * La orientación de litros/invitados ya se mostró al salir de RECOGIDA_DATOS.
 *
 * @param {object} session
 * @param {string} formatKey
 * @returns {Array<string|{ type: 'image', file: string, caption?: string }>}
 */
export function buildMenuEntryReplies(session, formatKey) {
  return [
    getEventPriceListImage(formatKey),
    // Orientación de litros ya vino tras indicar invitados; acá pedimos sabores
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

// ==============================================================================
// MISS DE PRODUCTOS (espejo Barriles): sabor fuera de carta / no entendido
// ==============================================================================

/**
 * askEventosFlavorsAfterMiss: Re-pregunta tras un miss (con o sin carrito).
 *
 * @param {object} [session]
 * @returns {string}
 */
function askEventosFlavorsAfterMiss(session = {}) {
  const hasCart = session.orderBuilder?.products
    && Object.keys(session.orderBuilder.products).length > 0;
  if (hasCart) {
    return `*¿Todo bien con el pedido?*
_(ej: escribe *ok* para el resumen, o "20L Mojito" / *quita el aperol*)_`;
  }
  return ASK_EVENT_COCKTAILS;
}

/**
 * buildEventosProductOrderMissReply: Pedido no entendido en ELECCION_MENU.
 * La lista de precios ya se envió: recordamos la carta sin fingir “no te entendí” genérico.
 *
 * @param {number} [strike=1]
 * @param {object} [session]
 * @returns {string}
 */
export function buildEventosProductOrderMissReply(strike = 1, session = {}) {
  if (Number(strike) >= 2) {
    return `Disculpa, no te entendí 😊 Soy un *asistente virtual*.
Indícame un cóctel de la *lista* o escribe *HUMANO* para que te asista alguien del equipo.`;
  }
  return `Disculpa, no entendí tu pedido 😊
Recuerda revisar la *lista de sabores* que te envié más arriba.

${askEventosFlavorsAfterMiss(session)}`;
}

/**
 * registerEventosProductOrderMiss: Suma strike y arma la respuesta del miss de menú.
 * El engine respeta `stallHandled` para no duplicar el strike.
 *
 * @param {object} session
 * @param {number} [stallThreshold=2]
 * @returns {object} Resultado validateAndProcess
 */
export function registerEventosProductOrderMiss(session, stallThreshold = 2) {
  const threshold = Math.max(2, Number(stallThreshold) || 2);
  session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
  const strike = session.consecutiveErrors;

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
        body: 'Varios pedidos de cóctel no entendidos en Eventos (lista ya enviada).'
      },
      customReply: `Te comunico con alguien del equipo para ayudarte con tu pedido. ¡Ya te escriben! 🙌`
    };
  }

  return {
    success: true,
    stallHandled: true,
    nextState: 'EVENTOS_ELECCION_MENU',
    customReply: buildEventosProductOrderMissReply(strike >= threshold ? 2 : 1, session)
  };
}

/**
 * formatEventosUnmatchedFlavorNote: Aviso cuando el mensaje trae un sabor fuera de carta
 * junto a otros que sí matchearon (espejo Barriles).
 *
 * @param {string[]} unmatchedNames
 * @returns {string}
 */
export function formatEventosUnmatchedFlavorNote(unmatchedNames = []) {
  if (!unmatchedNames.length) return '';
  const verb = unmatchedNames.length > 1 ? 'están' : 'está';
  return `\n\n😅 *${unmatchedNames.join(', ')}* aún no ${verb} en la carta. Si quieres, elige otro de la lista de arriba.`;
}
