// ==============================================================================
// OBJETIVO: Helpers compartidos del flujo de Eventos (no son estados).
// Los estados de flows/eventos/states/ los importan desde aquí.
// ==============================================================================
import {
  findLocationByFuzzyMatch,
  parseDate,
  formatPrice,
  preciosData
} from './utils.js';
import { OrderBuilder } from './order-builder.js';
import { img } from './media.js';
import { getEventLitersSuggestion } from '../views/templates.js';

/**
 * parseCelebrationType: Detecta qué celebra el cliente (matrimonio, cumpleaños, etc.).
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {string|null}
 */
export function parseCelebrationType(messageText) {
  const lower = String(messageText || '').toLowerCase();
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
 * applyEventDataFromMessage: Extrae celebración, comuna, fecha, invitados y guarda en sesión.
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {boolean}
 */
export function applyEventDataFromMessage(messageText, session) {
  let hasNewInfo = false;

  const celebration = parseCelebrationType(messageText);
  if (celebration && celebration !== session.celebrationType) {
    session.celebrationType = celebration;
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
      const capturedNorm = captured
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const isBareStopword = /^(el|la|los|las|lo|un|una|mi|tu|su|casa|de|del|en)$/i.test(capturedNorm);
      if (!isBareStopword && capturedNorm.length >= 3) {
        session.location = captured;
        session.isRM = false;
        session.region = null;
        hasNewInfo = true;
      }
    }
  }

  const dateSearch = parseDate(messageText);
  if (dateSearch) {
    session.date = dateSearch;
    hasNewInfo = true;
  }

  const cleanText = messageText.replace(/\b\d+\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi, '');
  const guestsMatch = cleanText.match(/\b(\d+)\s*(personas|invitados|pax|inv)?\b/i);
  if (guestsMatch) {
    session.guests = parseInt(guestsMatch[1], 10);
    hasNewInfo = true;
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
 * buildMenuEntryReplies: Imagen de precios + hint de litros + pregunta (3 burbujas).
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
    // Primera vez: solo pedimos sabores (aún no hay carrito → no mencionar *ok*)
    `¿Qué cócteles te gustaría incluir en tu evento? (ej: "Mojito 10L y 1 Aperol 5L")`
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
