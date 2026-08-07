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
import { findMentionedCocktail, asksPriceOrCatalog } from './interruptions.js';
import { formatMenuBlock } from './flow-rails.js';
import { exampleConcreteDateHint, normalizeBotDateText } from './cot-event-quote.js';

/** Tragos por barril 5L (dato oficial de negocio). */
const RENDIMIENTO_5L = Number(preciosData.rendimientos_barriles?.['5L']) || 25;

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
 */
export function softSaveDeliveryHints(messageText, session) {
  ensureDesechableCart(session);
  const cd = session.orderBuilder.clientData;

  const parsedDate = parseDate(messageText);
  if (parsedDate) {
    cd.date = normalizeBotDateText(parsedDate) || parsedDate;
  }

  const locationSearch = findLocationByFuzzyMatch(messageText);
  if (locationSearch) {
    cd.location = locationSearch.name;
    cd.locationData = locationSearch;
  }
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
  if (/\b(tienen?|hay|venden?|manejan?|disponible|disponibles|busco|quiero|me\s+gusta|prefiero)\b/i.test(lower)) {
    return true;
  }
  if (/\b(sabor|sabores|c[oó]ctel|c[oó]cteles|trago|tragos|refrescante|dulce|c[ií]trico|amargo|cl[aá]sico)\b/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * resolveBarrilesFlavorMatch: Detecta si el mensaje nombra un barril desechable.
 * Primero reglas (rápido y barato); si no hay match claro, NLU como red de seguridad.
 *
 * @param {string} messageText
 * @param {string} [lastBotMessage]
 * @returns {Promise<string|null>} Nombre exacto del catálogo o null
 */
export async function resolveBarrilesFlavorMatch(messageText, lastBotMessage = '') {
  // 1) Match programático: "mojito", "quiero un pisco sour", etc.
  const direct = findMentionedCocktail(messageText);
  if (direct) return direct;

  const catalogNames = Object.keys(preciosData.cocteles || {});
  if (catalogNames.length === 0) return null;

  // Frases muy cortas / solo cortesía → no gastar IA
  const trimmed = String(messageText || '').trim();
  if (!trimmed || trimmed.length < 3) return null;
  if (/^(hola|holi|buenas|ok|okay|si|sí|dale|gracias|no|nop)$/i.test(trimmed)) return null;

  // 2) Fallback NLU: el cliente puede decir "algo como un daiquiri" o typos raros
  try {
    const { productos } = await extractProductsWithAI(
      messageText,
      catalogNames,
      lastBotMessage || '👉 *Escribe el nombre del cóctel que te interesa y te enviaré el catálogo completo.*'
    );
    const first = Array.isArray(productos) && productos.length > 0 ? productos[0] : null;
    if (!first?.name) return null;
    return findClosestCatalogMatch(String(first.name), catalogNames) || null;
  } catch (err) {
    console.error('[bot] resolveBarrilesFlavorMatch NLU falló:', err.message);
    return null;
  }
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
 *
 * @param {string} [caption]
 * @returns {object}
 */
function buildBarrilesCatalogImage(caption = '') {
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
 * buildBarrilesIntroGateReplies: Match o catálogo + burbuja del menú cotizar/consulta.
 * Con match: pitch del sabor + imagen del catálogo (para seguir armando el pedido).
 *
 * @param {string|null} cocktailName
 * @returns {Array} customReplies para el engine
 */
export function buildBarrilesIntroGateReplies(cocktailName) {
  const menuBubble = barrilesIntroMenuQuestion();
  if (cocktailName) {
    const pitch = buildBarrilesMatchPitch(cocktailName);
    if (pitch) {
      return [
        pitch,
        buildBarrilesCatalogImage('👆 Aquí tienes el catálogo completo para armar tu pedido.'),
        menuBubble
      ];
    }
  }
  return [...buildBarrilesNoMatchReplies(), menuBubble];
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
