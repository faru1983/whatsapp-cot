// ==============================================================================
// OBJETIVO: Borrador de cotización/venta para el modo operador.
// Checklist de campos, merge en cualquier orden, faltantes, dudas y resumen.
// Convierte el borrador a la forma que esperan buildEventQuotePayload / barriles.
// ==============================================================================
import {
  parseEmailFromText,
  parsePersonNames,
  isPrimarilyDateMessage,
  formatTitleCase,
  normalizeEmail
} from './cot-contact.js';
import { parseDate, findLocationByFuzzyMatch, normalizeString, formatPrice, preciosData } from './utils.js';
import { getCoctelesNamesCatalogCompact } from './utils.js';
import {
  matchCocktailNamesInText,
  getEventFormatKey,
  getAllowedLitrages,
  extractGuestsFromMessage,
  parseCelebrationType,
  normalizeCelebrationType,
  formatEventLitersSummaryLine
} from './eventos-helpers.js';
import { OrderBuilder } from './order-builder.js';
import { quoteCatalogShipping, quoteBarrilesDirectShipping } from './cot-catalog.js';
import { EVENT_SHIPPING_LINE_LABEL } from '../views/templates.js';
import { extractOperatorDraftWithAI } from '../core/llm.js';
import { areCotApiWritesEnabled } from './bot-runtime-flags.js';
import { submitEventQuoteFromSession, toIsoDateFromBotText } from './cot-event-quote.js';
import { submitBarrilesSaleFromSession } from './cot-barriles-sale.js';
import {
  beginCliApiModeAsk,
  getCliApiSubmitAskReply,
  shouldAskCliApiModeOnConfirm
} from './cot-api.js';
import { buildOperatorCancelHint } from './operator-menu.js';
import { matchKeywordIntent, rulesConfirmarOCorregirDatos } from './keyword-intent.js';

/** @typedef {'event'|'event_reserva'|'barriles'} OperatorKind */

/** Rangos de retiro al día siguiente (mismos del wizard web). */
const EVENT_NEXT_DAY_PICKUP_SLOTS = ['12:00 a 14:00', '14:00 a 16:00', '16:00 a 18:00'];

/** Etiquetas legibles de cada campo del checklist */
const FIELD_LABELS = {
  firstName: 'nombre',
  lastName: 'apellido',
  email: 'email',
  phone: 'WhatsApp del cliente',
  comuna: 'comuna',
  date: 'fecha',
  address: 'dirección',
  eventoFormato: 'formato (dispensador o muro)',
  products: 'cócteles / productos',
  guests: 'cantidad de invitados',
  startTime: 'hora de inicio',
  pickupDate: 'fecha de retiro',
  pickupTime: 'hora de retiro'
};

/**
 * isEventOperatorKind: Cotización o reserva de evento (no barriles).
 *
 * @param {string} [kind]
 * @returns {boolean}
 */
export function isEventOperatorKind(kind) {
  return kind === 'event' || kind === 'event_reserva';
}

/**
 * getOperatorFieldLabel: Etiqueta según tipo (dirección de evento vs despacho).
 *
 * @param {OperatorKind} kind
 * @param {string} key
 * @returns {string}
 */
function getOperatorFieldLabel(kind, key) {
  if (key === 'address' && kind === 'event_reserva') return 'dirección del evento';
  if (key === 'address' && kind === 'barriles') return 'dirección de despacho';
  return FIELD_LABELS[key] || key;
}

/**
 * getOperatorChecklist: Campos obligatorios según tipo de acción.
 *
 * @param {OperatorKind} kind
 * @returns {string[]}
 */
export function getOperatorChecklist(kind) {
  const base = ['firstName', 'lastName', 'email', 'phone', 'comuna', 'date', 'products'];
  if (kind === 'event') {
    return [...base, 'eventoFormato', 'guests'];
  }
  if (kind === 'event_reserva') {
    return [...base, 'eventoFormato', 'guests', 'address', 'startTime'];
  }
  return [...base, 'address'];
}

/**
 * buildOperatorDataRequestCopy: Mensaje paso 1 — solicita datos de contacto.
 *
 * @param {OperatorKind} kind
 * @returns {string}
 */
export function buildOperatorDataRequestCopy(kind) {
  if (kind === 'event_reserva') {
    return `*RESERVA DE EVENTO (Paso 1/3: Contacto)*
Por favor indícame los datos de contacto del cliente:

• Nombre y Apellido:
• E-mail:
• Celular:

_Ej: Felipe Ramírez, feliperamirez1983@gmail.com, +56-966755025_
_Paso 1: Contacto. Luego pediremos detalles del evento (Fecha y Hora) y cócteles._
${buildOperatorCancelHint()}`;
  }

  if (kind === 'event') {
    return `*COTIZACIÓN DE EVENTO (Paso 1/3: Contacto)*
Por favor indícame los datos de contacto del cliente:

• Nombre y Apellido:
• E-mail:
• Celular:

_Ej: Felipe Ramírez, feliperamirez1983@gmail.com, +56-966755025_
_Paso 1: Contacto. Luego pediremos detalles del evento y cócteles._
${buildOperatorCancelHint()}`;
  }

  // kind === 'barriles'
  return `*VENTA BARRILES DESECHABLES (Paso 1/3: Contacto)*
Por favor indícame los datos de contacto del cliente:

• Nombre y Apellido:
• E-mail:
• Celular:

_Ej: Felipe Ramírez, feliperamirez1983@gmail.com, +56-966755025_
_Paso 1: Contacto. Luego pediremos dirección de despacho y productos._
${buildOperatorCancelHint()}`;
}

/**
 * isOperatorConfirmOk: ¿El mensaje confirma con OK / sí / correcto / opción 1?
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function isOperatorConfirmOk(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return false;
  if (/^(ok|okay|si|sí|dale|listo|perfecto|correcto|esta bien|está bien|todo bien|vamos|claro)$/i.test(t)) {
    return true;
  }
  const match = matchKeywordIntent(t, rulesConfirmarOCorregirDatos());
  return match === 'CONFIRMAR';
}

/**
 * formatContactConfirmation: Muestra los datos de contacto captados y pregunta si están correctos.
 *
 * @param {object} session
 * @returns {string}
 */
export function formatContactConfirmation(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const nombre = `${d.firstName || ''} ${d.lastName || ''}`.trim() || '—';
  const email = d.email || '—';
  const phone = d.phone || '—';

  return [
    '📋 *Datos de contacto captados:*',
    `• Nombre: ${nombre}`,
    `• Email: ${email}`,
    `• WhatsApp: ${phone}`,
    '',
    '¿Están correctos estos datos o deseas cambiar alguno?',
    'Escribe *OK* para continuar con los detalles del evento, o dime qué dato corregir.',
    buildOperatorCancelHint()
  ].join('\n');
}

/**
 * formatDetailsConfirmation: Muestra los detalles del evento captados y pregunta si están correctos.
 *
 * @param {object} session
 * @returns {string}
 */
export function formatDetailsConfirmation(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const kind = session.operatorKind;

  const lines = ['📋 *Detalles del evento captados:*'];
  if (kind === 'barriles') {
    lines.push(`• Dirección: ${d.address || '—'}`);
    lines.push(`• Comuna: ${d.comuna || '—'}`);
    lines.push(`• Fecha de entrega: ${d.date || '—'}`);
  } else {
    lines.push(`• Invitados: ${d.guests || '—'} personas`);
    lines.push(`• Comuna: ${d.comuna || '—'}`);
    lines.push(`• Fecha: ${d.date || '—'}`);
    if (d.celebrationType) {
      lines.push(`• Temática: ${d.celebrationType}`);
    }
    if (kind === 'event_reserva') {
      lines.push(`• Dirección: ${d.address || '—'}`);
      lines.push(`• Hora inicio: ${d.startTime || '—'}`);
      const retiro = d.pickupNextDay
        ? `día siguiente${d.pickupTime ? ` ${d.pickupTime}` : ''}`
        : d.pickupSameDay
          ? 'mismo día del evento'
          : 'mismo día';
      lines.push(`• Retiro: ${retiro}`);
    }
  }

  lines.push('');
  lines.push('¿Están correctos estos detalles o deseas cambiar alguno?');
  const nextTarget = isEventOperatorKind(kind) ? 'los cócteles y formato' : 'los productos';
  lines.push(`Escribe *OK* para continuar con ${nextTarget}, o dime qué dato corregir.`);
  lines.push(buildOperatorCancelHint());
  return lines.join('\n');
}

/**
 * buildOperatorDetailsRequestCopy: Mensaje paso 2 — solicita detalles del evento / despacho
 * tras confirmar los datos de contacto.
 *
 * @param {OperatorKind} kind
 * @param {object} session
 * @returns {string}
 */
export function buildOperatorDetailsRequestCopy(kind, session) {
  ensureOperatorDraft(session);

  if (kind === 'event_reserva') {
    return `*DETALLES DE LA RESERVA (Paso 2/3)*
Por favor indícame los datos del evento:

• Dirección completa:
• Comuna:
• N° Invitados:
• Fecha y Hora de inicio:
• Retiro (mismo día o día siguiente con rango horario):

_Ej: Av. Las Condes 1234, Las Condes, 50 personas, 15 de diciembre a las 20:00_
${buildOperatorCancelHint()}`;
  }

  if (kind === 'event') {
    return `*DETALLES DEL EVENTO (Paso 2/3)*
Por favor indícame los datos del evento:

• N° Invitados:
• Comuna:
• Fecha del evento:
• Temática:

_Ej: 50 invitados en Las Condes para el 15 de diciembre, Cumpleaños_
${buildOperatorCancelHint()}`;
  }

  // kind === 'barriles'
  return `*DETALLES DEL DESPACHO (Paso 2/3)*
Por favor indícame los datos de entrega:

• Dirección de despacho:
• Comuna:
• Fecha de entrega:

_Ej: Av. Providencia 1234, Providencia, para el viernes 10 de octubre_
${buildOperatorCancelHint()}`;
}

/**
 * buildOperatorProductsRequestCopy: Mensaje paso 3 — solicita cócteles y formato
 * tras registrar los detalles del evento o pedido.
 *
 * @param {OperatorKind} kind
 * @param {object} session
 * @returns {string}
 */
export function buildOperatorProductsRequestCopy(kind, session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;

  if (kind === 'barriles') {
    return `*PRODUCTOS (Paso 3/3)*
Por favor indícame los *cócteles / barriles* para la venta (nombre y cantidad):

_Ej: 3x Limonada Sour, 2x Negroni_
${buildOperatorCancelHint()}`;
  }

  const formato = d.eventoFormato || null;
  const formatoHint = formato
    ? `*(${formato} ya registrado)*`
    : '*(Dispensador Portátil o Muro de Coctelería)*';

  return `*CÓCTELES Y FORMATO (Paso 3/3)*
Por favor indícame el formato y los cócteles:

• Formato: ${formatoHint}
• Cócteles (nombre, cantidad y litros):

_Ej: Dispensador, 2x Mojito 10L, 1x Aperol Spritz 5L_
${buildOperatorCancelHint()}`;
}

/**
 * ensureOperatorDraft: Inicializa el bucket operatorDraft en la sesión.
 *
 * @param {object} session
 */
export function ensureOperatorDraft(session) {
  if (!session.operatorDraft || typeof session.operatorDraft !== 'object') {
    session.operatorDraft = {};
  }
}

/**
 * clearOperatorDraft: Limpia borrador y flags de operador (volver al menú).
 *
 * @param {object} session
 */
export function clearOperatorDraft(session) {
  session.operatorDraft = {};
  session.operatorKind = null;
  session.operatorDoubts = [];
  session.operatorConfirmNow = false;
  delete session.operatorAwaitingApiMode;
}

/**
 * setOperatorKind: Fija el tipo de acción y limpia datos previos.
 *
 * @param {object} session
 * @param {OperatorKind} kind
 */
export function setOperatorKind(session, kind) {
  clearOperatorDraft(session);
  session.operatorMode = true;
  session.operatorKind = kind;
  session.operatorConfirmNow = kind === 'event_reserva';
  ensureOperatorDraft(session);
}

/**
 * parseChilePhoneFromText: Extrae teléfono móvil chileno del texto.
 * Maneja +56-9..., +56 9..., 9..., cel:, wsp:, etc.
 * Ignora secuencias numéricas dentro de direcciones de email para no corromper el parseo.
 *
 * @param {string} text
 * @returns {string|null} E.164 +569... o null
 */
export function parseChilePhoneFromText(text) {
  if (!text) return null;
  // Enmascaramos emails para que números en el email (ej. feliperamirez1983@gmail.com) no interfieran
  const withoutEmails = String(text).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi, ' ');

  // 1. Patrón con indicador explícito: cel, celular, whatsapp, wsp, móvil, etc.
  const keywordMatch = withoutEmails.match(/(?:tel[eé]fono|celular|cel|whatsapp|wsp|fono|movil|móvil)\s*[:\-]?\s*(\+?\d[\d\s.\-]{7,15}\d)/i);
  if (keywordMatch) {
    const digits = keywordMatch[1].replace(/\D/g, '');
    if (/^569\d{8}$/.test(digits)) return `+${digits}`;
    if (/^9\d{8}$/.test(digits)) return `+56${digits}`;
    if (/^56\d{8}$/.test(digits)) return `+569${digits.slice(2)}`;
    if (/^\d{8}$/.test(digits)) return `+569${digits}`;
  }

  // 2. Patrón estándar móvil chileno (+56 9 XXXXXXXX o 9 XXXXXXXX con o sin guiones/espacios)
  const phoneMatch = withoutEmails.match(/(?:(?:\+|00)?56\s*[-.\s]?)?9(?:\s*[-.\s]?\d){8}\b/);
  if (phoneMatch) {
    const digits = phoneMatch[0].replace(/\D/g, '');
    if (/^569\d{8}$/.test(digits)) return `+${digits}`;
    if (/^9\d{8}$/.test(digits)) return `+56${digits}`;
  }

  // 3. Fallback: secuencia de 8-9 dígitos si el texto o fragmento limpio es un número
  const rawDigits = withoutEmails.replace(/\D/g, '');
  if (/^569\d{8}$/.test(rawDigits)) return `+${rawDigits}`;
  if (/^9\d{8}$/.test(rawDigits)) return `+56${rawDigits}`;

  return null;
}

/**
 * parseStartTimeFromText: Hora de inicio (HH:MM 24h).
 * Soporta "20:00", "20:00 hrs", "20 hrs", "8 pm", "8:30 pm", "inicio 20:00", etc.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseStartTimeFromText(text) {
  const raw = String(text || '');
  const m = raw.match(/(?:hora(?:\s+de\s+inicio)?|inicio|empieza|a\s+las)\s*[:\-]?\s*(\d{1,2})(?:[:\.](\d{2}))?\s*(?:hrs?|horas?)?\s*(am|pm)?/i)
    || raw.match(/\b(\d{1,2})[:\.](\d{2})\s*(?:hrs?|horas?)?\s*(am|pm)?\b/i)
    || raw.match(/\b(\d{1,2})\s*(?:hrs?|horas?)\b/i)
    || raw.match(/\b(\d{1,2})(?:[:\.](\d{2}))?\s*(am|pm)\b/i)
    || raw.match(/^\s*(\d{1,2})[:\.](\d{2})\s*(am|pm)?\s*$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] != null ? Number(m[2]) : 0;
  const ap = String(m[3] || '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * parsePickupFromText: Retiro mismo día, día siguiente y/o rango horario.
 *
 * @param {string} text
 * @returns {{ pickupSameDay?: boolean, pickupNextDay?: boolean, pickupTime?: string }}
 */
function parsePickupFromText(text) {
  const raw = String(text || '');
  const n = normalizeString(raw);
  const out = {};
  if (/retiro.{0,40}mismo\s+d[ií]a|\bmismo\s+d[ií]a.{0,20}retiro/i.test(raw)) {
    out.pickupSameDay = true;
  }
  if (/retiro.{0,40}(d[ií]a\s+siguiente|ma[nñ]ana)|\b(d[ií]a\s+siguiente|al\s+otro\s+d[ií]a).{0,20}retiro/i.test(raw)) {
    out.pickupNextDay = true;
  }
  for (const slot of EVENT_NEXT_DAY_PICKUP_SLOTS) {
    const compact = slot.replace(/\s/g, '');
    if (n.includes(normalizeString(slot)) || n.includes(normalizeString(compact))) {
      out.pickupTime = slot;
      break;
    }
  }
  if (!out.pickupTime) {
    const range = raw.match(/\b(12|14|16)\s*(?::00)?\s*a\s*(14|16|18)\s*(?::00)?\b/i);
    if (range) {
      const start = `${range[1]}:00`;
      const end = `${range[2]}:00`;
      const slot = EVENT_NEXT_DAY_PICKUP_SLOTS.find((s) => s.startsWith(start) && s.endsWith(end));
      if (slot) out.pickupTime = slot;
    }
  }
  return out;
}

/**
 * parseFormatFromText: Detecta dispensador vs muro.
 * Soporta "Dispensador", "Muro", "1", "2", "portátil", etc.
 *
 * @param {string} text
 * @returns {'Dispensador Portátil'|'Muro de Coctelería'|null}
 */
function parseFormatFromText(text) {
  const n = normalizeString(text);
  if (/^\s*2\s*$/.test(n) || /\bmuro\b/.test(n)) return 'Muro de Coctelería';
  if (/^\s*1\s*$/.test(n) || /\bdispensador\b|\bportatil\b|\bportátil\b/.test(n)) return 'Dispensador Portátil';
  return null;
}

/**
 * parseGuestsFromText: Número de invitados.
 * Soporta números sueltos ("25"), frases ("somos 25", "para 25 personas"), palabras
 * ("veinticinco") y bloques mixtos ("25, la florida, 3 de noviembre").
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseGuestsFromText(text) {
  if (!text) return null;
  // Usar la función centralizada de eventos que ya maneja fechas, palabras y exclusiones
  const extracted = extractGuestsFromMessage(text);
  if (extracted != null && Number.isFinite(extracted) && extracted > 0 && extracted <= 5000) {
    return extracted;
  }

  // Respaldo para número solitario ("25", "  50  ")
  const loneNumber = String(text).trim().match(/^(\d{1,4})$/);
  if (loneNumber) {
    const n = Number(loneNumber[1]);
    if (n > 0 && n <= 5000) return n;
  }

  // Respaldo para prefijos comunes: "somos 25", "para 25", "unos 25", "25 aprox"
  const prefixMatch = String(text).match(/(?:somos|para|seremos|alrededor\s+de|unos|cerca\s+de|aprox\s*:?)\s*(\d{1,4})\b/i)
    || String(text).match(/\b(\d{1,4})\s*(?:aprox|aproximado|personas?|invitados?|pax)\b/i);
  if (prefixMatch) {
    const n = Number(prefixMatch[1]);
    if (n > 0 && n <= 5000) return n;
  }

  return null;
}

/**
 * parseProductsFromTextLocal: Intenta extraer cócteles del catálogo sin IA.
 *
 * @param {string} text
 * @param {OperatorKind} kind
 * @param {string} [formato]
 * @returns {{ items: Array<{ name: string, quantity: number, litrage?: string }>, doubts: string[] }}
 */
function parseProductsFromTextLocal(text, kind, formato = 'Dispensador Portátil') {
  const catalogNames = Object.keys(preciosData.cocteles || {});

  const formatKey = getEventFormatKey(formato);
  const defaultLiters = formatKey === 'muro' ? '10L' : '10L';
  const allowed = getAllowedLitrages(formatKey);

  const items = [];
  const doubts = [];

  let matched = false;

  const namesInText = matchCocktailNamesInText(text, catalogNames);
  if (namesInText.length > 0) {
    matched = true;
    for (const name of namesInText) {
      const baseName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const qtyMatch = text.match(new RegExp(`(\\d+)\\s*(?:x\\s*)?${baseName}`, 'i'))
        || text.match(new RegExp(`${baseName}[^\\d]*(\\d+)`, 'i'));
      const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      const litMatch = text.match(new RegExp(`${baseName}[^\\d]*(\\d+)\\s*l`, 'i'))
        || text.match(new RegExp(`${baseName}\\s+(?:de\\s+)?(5|10|20|30)\\b`, 'i'))
        || text.match(/(\d+)\s*l/i);
      let litrage = litMatch ? `${litMatch[1]}L` : defaultLiters;
      if (!allowed.includes(litrage)) litrage = defaultLiters;
      items.push({ name, quantity: qty || 1, litrage });
    }
  }

  if (!matched && /spritz/i.test(text) && !/aperol|ramazzotti/i.test(text)) {
    doubts.push('spritz');
  }

  return { items, doubts };
}

/**
 * formatDateToDDMMYYYY: Normaliza cualquier fecha (humana "3 de noviembre", ISO "2026-11-03", "3/11/2026")
 * al formato estándar DD-MM-YYYY (ej: "03-11-2026").
 *
 * @param {string} text
 * @returns {string}
 */
export function formatDateToDDMMYYYY(text) {
  if (!text || typeof text !== 'string') return '';
  const clean = text.trim();
  // 1) Si ya viene DD-MM-YYYY o DD/MM/YYYY
  const m1 = clean.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m1) {
    return `${m1[1].padStart(2, '0')}-${m1[2].padStart(2, '0')}-${m1[3]}`;
  }
  // 2) Si viene YYYY-MM-DD
  const m2 = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m2) {
    return `${m2[3].padStart(2, '0')}-${m2[2].padStart(2, '0')}-${m2[1]}`;
  }
  // 3) Si es texto humano (ej: "3 de noviembre")
  const iso = toIsoDateFromBotText(clean);
  if (iso) {
    const [y, m, d] = iso.split('-');
    return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
  }
  return clean;
}

/**
 * mergeDraftFields: Fusiona campos parseados en operatorDraft (no borra lo existente).
 *
 * @param {object} session
 * @param {object} patch
 */
function mergeDraftFields(session, patch) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'products' && Array.isArray(value) && value.length) {
      d.products = value;
    } else if (key === 'firstName' || key === 'lastName') {
      d[key] = formatTitleCase(String(value));
    } else if (key === 'email') {
      d[key] = normalizeEmail(String(value));
    } else if (key === 'comuna') {
      d[key] = formatTitleCase(String(value));
    } else if (key === 'date') {
      d[key] = formatDateToDDMMYYYY(String(value));
    } else if (key === 'celebrationType') {
      d[key] = normalizeCelebrationType(String(value));
    } else {
      d[key] = value;
    }
  }
}

/**
 * dedupeProducts: Une productos por nombre+litrage.
 *
 * @param {Array<{ name: string, quantity: number, litrage?: string }>} list
 * @param {OperatorKind} kind
 * @returns {Array}
 */
function dedupeProducts(list, kind) {
  const map = new Map();
  for (const item of list || []) {
    if (!item?.name) continue;
    let litrage = isEventOperatorKind(kind) ? (item.litrage || '10L') : '5L';
    if (isEventOperatorKind(kind)) {
      const litDigits = String(litrage).replace(/\D/g, '');
      litrage = litDigits ? `${litDigits}L` : litrage;
    }
    const key = isEventOperatorKind(kind) ? `${item.name}::${litrage}` : item.name;
    const prev = map.get(key);
    const qty = Number(item.quantity) || 1;
    if (prev) {
      prev.quantity += qty;
    } else {
      map.set(key, { name: item.name, quantity: qty, litrage });
    }
  }
  return [...map.values()];
}

/**
 * parseOperatorDraftLocal: Parsers programáticos (email, teléfono, fecha, nombres).
 *
 * @param {string} text
 * @param {OperatorKind} kind
 * @param {object} session
 * @returns {{ patch: object, doubts: string[] }}
 */
export function parseOperatorDraftLocal(text, kind, session) {
  const patch = {};
  const doubts = [];

  const email = parseEmailFromText(text);
  if (email) patch.email = normalizeEmail(email);

  const phone = parseChilePhoneFromText(text);
  if (phone) patch.phone = phone;

  // Creamos un texto limpio removiendo email y teléfono para que fechas, comunas y nombres no colisionen
  let cleanText = String(text || '');
  if (email) {
    cleanText = cleanText.replace(email, ' ');
  }
  if (phone) {
    // Reemplazamos tanto el formato limpio como posibles variantes que estaban en el texto
    cleanText = cleanText.replace(/(?:(?:\+|00)?56\s*[-.\s]?)?9(?:\s*[-.\s]?\d){8}\b/g, ' ');
    cleanText = cleanText.replace(/\+?56\s*[-.\s]?\d{8,9}/g, ' ');
    cleanText = cleanText.replace(/(?:tel[eé]fono|celular|cel|whatsapp|wsp|fono|movil|móvil)\s*[:\-]?\s*\+?\d[\d\s.\-]{7,15}\d/gi, ' ');
  }

  let textForDetails = cleanText;

  if (isPrimarilyDateMessage(cleanText) || parseDate(cleanText)) {
    const dateStr = parseDate(cleanText) || (isPrimarilyDateMessage(cleanText) ? cleanText.trim() : null);
    if (dateStr) {
      patch.date = formatDateToDDMMYYYY(dateStr);
      // Quitamos la fecha para que dígitos de la fecha no confundan al extractor de invitados
      textForDetails = textForDetails.replace(dateStr, ' ');
    }
  }

  const location = findLocationByFuzzyMatch(textForDetails) || findLocationByFuzzyMatch(cleanText);
  if (location) {
    patch.comuna = formatTitleCase(location.name || location);
    if (location.name) {
      textForDetails = textForDetails.replace(new RegExp(`\\b${location.name}\\b`, 'i'), ' ');
    }
  }

  // Detectar temática / tipo de celebración
  const celebration = parseCelebrationType(cleanText);
  if (celebration) patch.celebrationType = normalizeCelebrationType(celebration);
  const explicitTheme = cleanText.match(/(?:tem[aá]tica|motivo|celebraci[oó]n|tipo(?:\s+de\s+evento)?)\s*[:\-]\s*([A-Za-z0-9áéíóúÁÉÍÓÚñÑ\s]{3,30})/i);
  if (explicitTheme && explicitTheme[1]?.trim()) {
    patch.celebrationType = normalizeCelebrationType(explicitTheme[1].trim());
  }

  let cleanTextForNames = cleanText;
  if (patch.date) cleanTextForNames = cleanTextForNames.replace(patch.date, ' ');
  if (patch.comuna) cleanTextForNames = cleanTextForNames.replace(new RegExp(`\\b${patch.comuna}\\b`, 'i'), ' ');
  if (celebration) cleanTextForNames = cleanTextForNames.replace(new RegExp(`\\b${celebration}\\b`, 'i'), ' ');
  if (explicitTheme?.[1]) cleanTextForNames = cleanTextForNames.replace(new RegExp(`\\b${explicitTheme[1].trim()}\\b`, 'i'), ' ');
  if (patch.celebrationType) {
    const rawParts = patch.celebrationType.split(/\s*\/\s*|\s+/);
    for (const p of rawParts) {
      if (p.length > 2) cleanTextForNames = cleanTextForNames.replace(new RegExp(`\\b${p}\\b`, 'i'), ' ');
    }
  }
  cleanTextForNames = cleanTextForNames.replace(/\b\d+\b/g, ' ');

  const names = parsePersonNames(cleanTextForNames);
  const hasExistingName = Boolean(session?.operatorDraft?.firstName);
  const isExplicitNameFix = /(?:(?:cambia(?:r)?|modifica(?:r)?|corrige)\s+(?:el\s+)?)?(?:nombre|apellido\s*s?)\s*(?:cambia\s+(?:a|por)|cambiar\s+(?:a|por)|es|a|por|:|deja\s+en|deja\s+como)|\bme\s+llamo\b|\bsoy\s+[A-Za-z]/i.test(cleanText);
  if (!hasExistingName || isExplicitNameFix) {
    if (names?.firstName) patch.firstName = formatTitleCase(names.firstName);
    if (names?.lastName) patch.lastName = formatTitleCase(names.lastName);
  }

  const addrMatch = cleanText.match(/(?:direcci[oó]n|despacho|entrega)\s*[:\-]?\s*(.+)/i);
  if (addrMatch?.[1]?.trim().length >= 5) {
    patch.address = addrMatch[1].trim();
  }

  const formato = parseFormatFromText(cleanText);
  if (formato) patch.eventoFormato = formato;

  // Extraer invitados usando el texto limpio de fecha y comuna para evitar colisiones
  const guests = parseGuestsFromText(textForDetails) || parseGuestsFromText(cleanText);
  if (guests) patch.guests = guests;

  const pickup = parsePickupFromText(cleanText);
  if (pickup.pickupSameDay) patch.pickupSameDay = true;
  if (pickup.pickupNextDay) patch.pickupNextDay = true;
  if (pickup.pickupTime) patch.pickupTime = pickup.pickupTime;

  const startTime = parseStartTimeFromText(cleanText);
  if (startTime) patch.startTime = startTime;

  const { items, doubts: prodDoubts } = parseProductsFromTextLocal(
    cleanText,
    kind,
    patch.eventoFormato || session?.operatorDraft?.eventoFormato
  );
  if (items.length) patch.products = items;
  doubts.push(...prodDoubts);

  return { patch, doubts };
}

/**
 * applyOperatorDraftPatch: Mergea patch local + IA en la sesión.
 *
 * @param {object} session
 * @param {object} patch
 */
export function applyOperatorDraftPatch(session, patch) {
  mergeDraftFields(session, patch);
  if (Array.isArray(patch.products)) {
    session.operatorDraft.products = dedupeProducts(
      session.operatorDraft.products,
      session.operatorKind
    );
  }
}

/**
 * getMissingContactFields: Campos de contacto que aún faltan (Paso 1).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingContactFields(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const missing = [];
  if (!d.firstName) missing.push('firstName');
  if (!d.lastName) missing.push('lastName');
  if (!d.email) missing.push('email');
  if (!d.phone) missing.push('phone');
  return missing;
}

/**
 * formatMissingContactMessage: Muestra qué datos de contacto se captaron y qué falta.
 *
 * @param {object} session
 * @returns {string}
 */
export function formatMissingContactMessage(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const missing = getMissingContactFields(session);
  if (!missing.length) return '';

  const captured = [];
  if (d.firstName || d.lastName) {
    captured.push(`• Nombre: ${d.firstName || ''} ${d.lastName || ''}`.trim());
  }
  if (d.email) captured.push(`• Email: ${d.email}`);
  if (d.phone) captured.push(`• WhatsApp: ${d.phone}`);

  const missingLabels = [];
  if (missing.includes('firstName') || missing.includes('lastName')) {
    if (missing.includes('firstName') && missing.includes('lastName')) {
      missingLabels.push('Nombre y Apellido');
    } else if (missing.includes('lastName')) {
      missingLabels.push('Apellido');
    } else {
      missingLabels.push('Nombre');
    }
  }
  if (missing.includes('email')) missingLabels.push('Email');
  if (missing.includes('phone')) missingLabels.push('WhatsApp del cliente (+569...)');

  const lines = [];
  if (captured.length) {
    lines.push('📋 *Datos de contacto captados:*');
    lines.push(...captured);
    lines.push('');
  }
  lines.push(`⚠️ *Me falta:* *${missingLabels.join(', ')}*.`);
  lines.push('Puedes enviar solo lo que falta o un bloque nuevo.');
  lines.push(buildOperatorCancelHint());
  return lines.join('\n');
}

/**
 * getMissingDetailsFields: Campos de detalles del evento/despacho que aún faltan (Paso 2).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingDetailsFields(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const kind = session.operatorKind;
  const missing = [];

  if (kind === 'barriles') {
    if (!d.address || String(d.address).trim().length < 5) missing.push('address');
    if (!d.comuna) missing.push('comuna');
    if (!d.date) missing.push('date');
  } else {
    // event / event_reserva
    if (!d.guests || Number(d.guests) <= 0) missing.push('guests');
    if (!d.date) missing.push('date');
    if (kind === 'event_reserva') {
      if (!d.address || String(d.address).trim().length < 5) missing.push('address');
      if (!d.startTime) missing.push('startTime');
      if (d.pickupNextDay && !d.pickupTime) missing.push('pickupTime');
    } else {
      if (!d.comuna) missing.push('comuna');
    }
  }
  return missing;
}

/**
 * formatMissingDetailsMessage: Muestra qué detalles se captaron y qué falta.
 *
 * @param {object} session
 * @returns {string}
 */
export function formatMissingDetailsMessage(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const kind = session.operatorKind;
  const missing = getMissingDetailsFields(session);
  if (!missing.length) return '';

  const captured = [];
  if (d.guests) captured.push(`• Invitados: ${d.guests}`);
  if (d.comuna) captured.push(`• Comuna: ${d.comuna}`);
  if (d.date) captured.push(`• Fecha: ${d.date}`);
  if (d.address) captured.push(`• Dirección: ${d.address}`);
  if (d.startTime) captured.push(`• Hora inicio: ${d.startTime}`);
  if (d.celebrationType) captured.push(`• Temática: ${d.celebrationType}`);

  const labels = missing.map((k) => getOperatorFieldLabel(kind, k));

  const lines = [];
  if (captured.length) {
    lines.push('📋 *Detalles captados hasta ahora:*');
    lines.push(...captured);
    lines.push('');
  }
  lines.push(`⚠️ *Me falta:* *${labels.join(', ')}*.`);
  lines.push('Puedes enviar solo lo que falta.');
  lines.push(buildOperatorCancelHint());
  return lines.join('\n');
}

/**
 * getMissingOperatorFields: Lista de claves que aún faltan (todos los pasos).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingOperatorFields(session) {
  const kind = session.operatorKind;
  if (!kind) return [];
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const checklist = getOperatorChecklist(kind);
  const missing = [];

  for (const key of checklist) {
    if (key === 'products') {
      if (!Array.isArray(d.products) || d.products.length === 0) missing.push(key);
      continue;
    }
    if (key === 'address') {
      if (String(d.address || '').trim().length < 5) missing.push(key);
      continue;
    }
    const val = d[key];
    if (val === undefined || val === null || String(val).trim() === '') {
      missing.push(key);
    }
  }
  if (kind === 'event_reserva' && d.pickupNextDay && !String(d.pickupTime || '').trim()) {
    missing.push('pickupTime');
  }
  return missing;
}

/**
 * getMissingDataFields: Campos de contacto y evento juntos (mantenido por compatibilidad).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingDataFields(session) {
  const contact = getMissingContactFields(session);
  const details = getMissingDetailsFields(session);
  return [...contact, ...details];
}

/**
 * getMissingProductFields: Campos de productos/formato que aún faltan (Paso 2).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingProductFields(session) {
  const kind = session.operatorKind;
  if (!kind) return [];
  ensureOperatorDraft(session);
  const d = session.operatorDraft;

  const missing = [];
  if (isEventOperatorKind(kind) && !d.eventoFormato) {
    missing.push('eventoFormato');
  }
  if (!Array.isArray(d.products) || d.products.length === 0) {
    missing.push('products');
  }
  return missing;
}

/**
 * formatMissingFieldsMessage: Texto "Me faltan: ..."
 *
 * @param {string[]} missingKeys
 * @param {OperatorKind} [kind]
 * @returns {string}
 */
export function formatMissingFieldsMessage(missingKeys, kind) {
  if (!missingKeys.length) return '';
  const labels = missingKeys.map((k) => getOperatorFieldLabel(kind, k));
  return [
    `Me faltan: *${labels.join(', ')}*.`,
    'Puedes enviar solo eso o un bloque nuevo.',
    buildOperatorCancelHint()
  ].join('\n');
}

/**
 * formatOperatorDoubtsMessage: Re-pregunta por campos ambiguos.
 *
 * @param {string[]} doubts
 * @returns {string}
 */
export function formatOperatorDoubtsMessage(doubts) {
  if (!doubts.length) return '';
  const unique = [...new Set(doubts)];
  if (unique.includes('email')) {
    return 'No me quedó claro el *correo*. ¿Me lo confirmas?';
  }
  if (unique.includes('spritz')) {
    return '¿El spritz es *Aperol Spritz* o *Ramazzotti Spritz*?';
  }
  return `No me quedó claro: *${unique.join(', ')}*. ¿Me lo confirmas?`;
}

/**
 * syncOperatorDraftToSession: Copia borrador a contact/orderBuilder para la API.
 *
 * @param {object} session
 */
export function syncOperatorDraftToSession(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const kind = session.operatorKind;

  session.operatorConfirmNow = kind === 'event_reserva';
  session.contact = {
    firstName: String(d.firstName || '').trim(),
    lastName: String(d.lastName || '').trim(),
    email: String(d.email || '').trim().toLowerCase(),
    phone: String(d.phone || '').trim(),
    address: String(d.address || '').trim(),
    comuna: String(d.comuna || '').trim(),
    startTime: String(d.startTime || '').trim(),
    pickupDate: '',
    pickupTime: ''
  };

  session.location = d.comuna || '';
  session.date = d.date || '';
  session.celebrationType = d.celebrationType || 'Otro';
  session.guests = Number(d.guests) || 0;
  session.eventosDrinksPerGuest = Number(d.drinksPerPerson) || 3;

  if (isEventOperatorKind(kind)) {
    const isoDate = toIsoDateFromBotText(d.date) || '';
    let pickupIso = isoDate;
    if (d.pickupNextDay && isoDate) {
      const next = new Date(`${isoDate}T12:00:00`);
      next.setDate(next.getDate() + 1);
      pickupIso = next.toISOString().split('T')[0];
    } else if (d.pickupSameDay) {
      pickupIso = isoDate;
    } else if (String(d.pickupDate || '').trim()) {
      pickupIso = toIsoDateFromBotText(d.pickupDate) || String(d.pickupDate).trim();
    }
    session.contact.pickupDate = pickupIso;
    session.contact.pickupTime = pickupIso && pickupIso !== isoDate
      ? String(d.pickupTime || '').trim()
      : '';

    session.eventoFormato = d.eventoFormato || 'Dispensador Portátil';
    session.orderBuilder = session.orderBuilder || {};
    session.orderBuilder.type = getEventFormatKey(session.eventoFormato);
    session.orderBuilder.products = {};
    for (const item of d.products || []) {
      const litDigits = String(item.litrage || '').replace(/\D/g, '');
      const litrage = litDigits ? `${litDigits}L` : (session.orderBuilder.type === 'muro' ? '10L' : '5L');
      const key = `${item.name}::${litrage}`;
      session.orderBuilder.products[key] = {
        name: item.name,
        litrage,
        quantity: Number(item.quantity) || 1
      };
    }
  } else {
    session.orderBuilder = session.orderBuilder || {};
    session.orderBuilder.type = 'desechable';
    session.orderBuilder.products = {};
    session.orderBuilder.clientData = {
      name: `${d.firstName || ''} ${d.lastName || ''}`.trim(),
      date: d.date || '',
      location: d.comuna || ''
    };
    for (const item of d.products || []) {
      session.orderBuilder.products[item.name] = Number(item.quantity) || 1;
    }
  }
}

/**
 * formatOperatorDataSummary: Resumen solo de datos de contacto/evento (Paso 1).
 * No incluye productos. Se muestra antes de pedir cócteles.
 *
 * @param {object} session
 * @returns {string}
 */
export function formatOperatorDataSummary(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const kind = session.operatorKind;

  const lines = [
    '*Resumen — Datos del evento*',
    '',
    '*Contacto:*',
    `- Nombre: ${d.firstName || '—'} ${d.lastName || '—'}`,
    `- Email: ${d.email || '—'}`,
    `- Celular: ${d.phone || '—'}`,
    '',
    '*Detalles:*'
  ];

  if (kind === 'barriles') {
    lines.push(`- Dirección despacho: ${d.address || '—'}`);
    lines.push(`- Comuna: ${d.comuna || '—'}`);
    lines.push(`- Fecha entrega: ${d.date || '—'}`);
  } else {
    lines.push(`- Temática: ${d.celebrationType || '—'}`);
    lines.push(`- Invitados: ${d.guests || '—'}`);
    if (kind === 'event_reserva') {
      lines.push(`- Dirección: ${d.address || '—'}`);
      lines.push(`- Fecha y hora: ${d.date || '—'}${d.startTime ? ` a las ${d.startTime}` : ''}`);
      const retiro = d.pickupNextDay
        ? `día siguiente${d.pickupTime ? ` ${d.pickupTime}` : ''}`
        : d.pickupSameDay
          ? 'mismo día del evento'
          : '—';
      lines.push(`- Retiro: ${retiro}`);
    } else {
      lines.push(`- Comuna: ${d.comuna || '—'}`);
      lines.push(`- Fecha: ${d.date || '—'}`);
    }
  }

  lines.push('');
  lines.push('¿Los datos están correctos? Escribe *OK* para continuar con los cócteles, o dime qué cambiar.');
  lines.push(buildOperatorCancelHint());
  return lines.join('\n');
}

/**
 * formatOperatorSummary: Resumen legible antes de confirmar.
 *
 * @param {object} session
 * @returns {string}
 */
export function formatOperatorSummary(session) {
  ensureOperatorDraft(session);
  const d = session.operatorDraft;
  const kind = session.operatorKind;
  const lines = [
    '*Resumen del borrador*',
    `Cliente: ${d.firstName || '—'} ${d.lastName || '—'}`,
    `Email: ${d.email || '—'}`,
    `WhatsApp: ${d.phone || '—'}`,
    `Comuna: ${d.comuna || '—'}`,
    `Fecha: ${d.date || '—'}`
  ];

  if (kind === 'barriles') {
    lines.push(`Dirección: ${d.address || '—'}`);
  } else {
    lines.push(`Formato: ${d.eventoFormato || '—'}`);
    lines.push(`Invitados: ${d.guests || '—'}`);
    if (kind === 'event_reserva') {
      lines.push(`Dirección: ${d.address || '—'}`);
      lines.push(`Hora inicio: ${d.startTime || '—'}`);
      const retiro = d.pickupNextDay
        ? `día siguiente${d.pickupTime ? ` ${d.pickupTime}` : ''}`
        : 'mismo día del evento';
      lines.push(`Retiro: ${retiro}`);
    }
  }

  const isEvent = isEventOperatorKind(kind);
  const formatKey = isEvent ? getEventFormatKey(d.eventoFormato) : 'desechable';
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  const products = Array.isArray(d.products) ? d.products : [];

  for (const p of products) {
    if (!p?.name) continue;
    const qty = Number(p.quantity) || 1;
    if (isEvent) {
      const litDigits = String(p.litrage || '').replace(/\D/g, '');
      const litrage = litDigits ? `${litDigits}L` : (formatKey === 'muro' ? '10L' : '5L');
      orderBuilder.products[`${p.name}::${litrage}`] = {
        name: p.name,
        quantity: qty,
        litrage
      };
    } else {
      orderBuilder.products[p.name] = qty;
    }
  }

  let deliveryCost = null;
  let isRM = null;

  if (d.comuna) {
    if (isEvent) {
      const catalogShip = quoteCatalogShipping({
        serviceType: 'event',
        comunaName: d.comuna,
        totalLiters: orderBuilder.getTotalLiters()
      });
      if (catalogShip) {
        isRM = catalogShip.isRM;
        if (!catalogShip.isPending) deliveryCost = catalogShip.cost;
      } else {
        const loc = findLocationByFuzzyMatch(d.comuna);
        if (loc) {
          isRM = loc.isRM;
          if (loc.isRM && loc.deliveryCost?.evento != null) {
            deliveryCost = loc.deliveryCost.evento;
          }
        }
      }
    } else {
      const loc = findLocationByFuzzyMatch(d.comuna);
      const catalogShip = quoteBarrilesDirectShipping({
        comunaName: loc?.name || d.comuna,
        region: loc?.region,
        regionCode: loc?.regionCode,
        isRM: loc?.isRM,
        totalLiters: orderBuilder.getTotalLiters()
      });
      if (catalogShip && !catalogShip.isPending) {
        deliveryCost = catalogShip.cost;
        isRM = catalogShip.isRM;
      } else if (loc?.deliveryCost?.desechable != null) {
        deliveryCost = Number(loc.deliveryCost.desechable);
        isRM = loc.isRM;
      }
    }
  }

  const quote = orderBuilder.calculateQuote(deliveryCost);

  const prodLines = products.map((p) => {
    const qty = Number(p.quantity) || 1;
    let litLabel = '';
    if (isEvent) {
      const litDigits = String(p.litrage || '').replace(/\D/g, '');
      litLabel = ` ${litDigits ? `${litDigits}L` : (formatKey === 'muro' ? '10L' : '5L')}`;
    }
    const normName = normalizeString(p.name);
    const detail = quote.details?.find((dt) => {
      const matchName = normalizeString(dt.name) === normName;
      if (!isEvent) return matchName;
      const dtLit = String(dt.litrage || '').toUpperCase();
      const pLit = litLabel.trim().toUpperCase();
      return matchName && dtLit === pLit;
    });

    const itemLabel = `• ${qty}x ${p.name}${litLabel}`;
    if (detail && detail.lineTotal != null) {
      return `${itemLabel}: ${formatPrice(detail.lineTotal)}`;
    }
    return itemLabel;
  });

  lines.push('', '*Productos:*', prodLines.length ? prodLines.join('\n') : '_(vacío)_');

  if (products.length > 0 && quote.subtotal > 0) {
    lines.push('');
    if (isEvent) {
      lines.push(`Subtotal cócteles: ${formatPrice(quote.subtotal)}`);
      const litersLine = formatEventLitersSummaryLine(quote, { guests: d.guests });
      if (litersLine) {
        lines.push(litersLine);
      }
      if (quote.installation > 0) {
        lines.push(`Instalación Muro: ${formatPrice(quote.installation)}`);
      } else {
        lines.push(`Instalación Dispensador: ${formatPrice(0)}`);
      }

      if (deliveryCost != null) {
        lines.push(`${EVENT_SHIPPING_LINE_LABEL} (${d.comuna || 'RM'}): ${formatPrice(deliveryCost)}`);
        lines.push(`*TOTAL: ${formatPrice(quote.total)}*`);
      } else if (isRM === false) {
        lines.push(`${EVENT_SHIPPING_LINE_LABEL}: _por confirmar_ (fuera de RM)`);
        lines.push(`*TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*`);
        lines.push(`_(+ traslados por confirmar)_`);
      } else {
        lines.push(`${EVENT_SHIPPING_LINE_LABEL}: _por confirmar al agendar_`);
        lines.push(`*TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*`);
      }
    } else {
      // barriles
      lines.push(`Subtotal: ${formatPrice(quote.subtotal)}`);
      if (deliveryCost != null && deliveryCost > 0) {
        lines.push(`Despacho (${d.comuna || 'RM'}): ${formatPrice(deliveryCost)}`);
        lines.push(`*TOTAL: ${formatPrice(quote.total)}*`);
      } else if (isRM === false) {
        lines.push(`Despacho: _por confirmar_ (Blue Express)`);
        lines.push(`*TOTAL: ${formatPrice(quote.subtotal)}*`);
        lines.push(`_(+ despacho a confirmar)_`);
      } else {
        lines.push(`Despacho: _por confirmar_`);
        lines.push(`*TOTAL: ${formatPrice(quote.subtotal)}*`);
      }
    }

    if (quote.missingPrices?.length > 0) {
      lines.push('');
      lines.push('⚠️ Sin precio en catálogo:');
      for (const m of quote.missingPrices) {
        lines.push(`- ${m.name} (${m.litrage})`);
      }
    }
  }

  lines.push(
    '',
    kind === 'event_reserva'
      ? '¿Confirmo la *reserva* en la web? Escribe *OK* o dime qué cambiar.'
      : '¿Lo creo en la web? Escribe *OK* o dime qué cambiar.'
  );
  lines.push(buildOperatorCancelHint());
  return lines.join('\n');
}

/**
 * ingestOperatorMessage: Procesa un bloque de datos (local + IA opcional).
 * opts.stage: 'data' → solo campos de contacto/evento, sin productos.
 *             'products' → solo cócteles y formato.
 *             undefined → todos los campos (compatibilidad original).
 *
 * @param {object} session
 * @param {string} messageText
 * @param {{ stage?: 'data'|'products', useAi?: boolean }|boolean} [opts=true]
 * @returns {Promise<{ missing: string[], doubts: string[], complete: boolean }>}
 */
export async function ingestOperatorMessage(session, messageText, opts = true) {
  // Compat: antes era ingestOperatorMessage(session, msg, useAi=true)
  const useAi = typeof opts === 'boolean' ? opts : (opts?.useAi !== false);
  const stage = typeof opts === 'object' ? opts?.stage : undefined;

  const kind = session.operatorKind;
  const local = parseOperatorDraftLocal(messageText, kind, session);

  // Si estamos en la etapa de productos (paso 3), descartamos campos de datos personales
  // salvo que el usuario intente corregir explícitamente un dato
  if (stage === 'products') {
    const dataOnlyKeys = ['firstName', 'lastName', 'email', 'phone', 'date', 'comuna',
      'address', 'guests', 'startTime', 'pickupSameDay', 'pickupNextDay', 'pickupTime'];
    // Solo borramos si el mensaje no parece una corrección explícita de datos
    const isExplicitDataFix = /nombre|apellido|email|correo|celular|whatsapp|comuna|fecha|direcci[oó]n|invitados/i.test(messageText);
    if (!isExplicitDataFix) {
      for (const k of dataOnlyKeys) delete local.patch[k];
    }
  }

  const finalPatch = { ...local.patch };

  let aiDoubts = [];
  if (useAi && process.env.SKIP_OPERATOR_NLU !== '1') {
    try {
      const catalogNames = Object.keys(preciosData.cocteles || {});
      const ai = await extractOperatorDraftWithAI(messageText, {
        kind,
        catalogNames,
        currentDraft: session.operatorDraft
      });
      if (ai?.patch && Object.keys(ai.patch).length) {
        const aiPatch = { ...ai.patch };
        if (stage === 'products') {
          const dataOnlyKeys = ['firstName', 'lastName', 'email', 'phone', 'date', 'comuna',
            'address', 'guests', 'startTime', 'pickupSameDay', 'pickupNextDay', 'pickupTime'];
          const isExplicitDataFix = /nombre|apellido|email|correo|celular|whatsapp|comuna|fecha|direcci[oó]n|invitados/i.test(messageText);
          if (!isExplicitDataFix) {
            for (const k of dataOnlyKeys) delete aiPatch[k];
          }
        }
        for (const [k, v] of Object.entries(aiPatch)) {
          if (v !== undefined && v !== null && v !== '') {
            finalPatch[k] = v;
          }
        }
      }
      aiDoubts = Array.isArray(ai?.dudas) ? ai.dudas : [];
    } catch (err) {
      console.warn('operator NLU:', err?.message || err);
    }
  }

  applyOperatorDraftPatch(session, finalPatch);

  const allDoubts = [...new Set([...local.doubts, ...aiDoubts])];
  session.operatorDoubts = allDoubts;

  const missing = getMissingOperatorFields(session);
  return {
    missing,
    doubts: allDoubts,
    complete: missing.length === 0 && allDoubts.length === 0
  };
}

/**
 * submitOperatorQuote: POST a la API tras OK del operador.
 *
 * @param {object} session
 * @returns {Promise<object>} Resultado estilo validateAndProcess
 */
export async function submitOperatorQuote(session) {
  if (!areCotApiWritesEnabled()) {
    return {
      success: true,
      nextState: 'OPERADOR_CONFIRMAR',
      customReply: 'La API de escrituras está *apagada* (/cotapi on para activarla).\nEl borrador sigue guardado.'
    };
  }

  syncOperatorDraftToSession(session);

  const kind = session.operatorKind;
  const result = isEventOperatorKind(kind)
    ? await submitEventQuoteFromSession(session)
    : await submitBarrilesSaleFromSession(session);

  if (!result.success) {
    return {
      success: true,
      nextState: 'OPERADOR_CONFIRMAR',
      customReply: `No pude crear el pedido en la web:\n${result.error || 'error desconocido'}\n\nRevisa el resumen o corrige los datos.`
    };
  }

  const totalStr = result.totalPrice != null ? formatPrice(result.totalPrice) : null;
  const isReserva = kind === 'event_reserva';
  const closing = [
    isReserva ? '✅ *Reserva confirmada en la web*' : '✅ *Creado en la web*',
    result.url ? `Link: ${result.url}` : null,
    totalStr ? `Total: ${totalStr}` : null,
    '',
    'Escribe */menu* para otra acción.'
  ].filter(Boolean).join('\n');

  clearOperatorDraft(session);

  return {
    success: true,
    nextState: 'OPERADOR_MENU',
    customReply: closing
  };
}

/**
 * beginOperatorApiModeAskIfNeeded: En CLI ask, pregunta real vs simulada.
 *
 * @param {object} session
 * @returns {object|null} Respuesta de flujo o null si puede seguir
 */
export function beginOperatorApiModeAskIfNeeded(session) {
  if (!shouldAskCliApiModeOnConfirm()) return null;
  beginCliApiModeAsk(session);
  return {
    success: true,
    nextState: 'OPERADOR_CONFIRMAR',
    customReply: getCliApiSubmitAskReply()
  };
}
