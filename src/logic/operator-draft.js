// ==============================================================================
// OBJETIVO: Borrador de cotización/venta para el modo operador.
// Checklist de campos, merge en cualquier orden, faltantes, dudas y resumen.
// Convierte el borrador a la forma que esperan buildEventQuotePayload / barriles.
// ==============================================================================
import {
  parseEmailFromText,
  parsePersonNames,
  isPrimarilyDateMessage
} from './cot-contact.js';
import { parseDate, findLocationByFuzzyMatch, normalizeString, formatPrice } from './utils.js';
import { getCoctelesNamesCatalogCompact } from './utils.js';
import { matchCocktailNamesInText } from './eventos-helpers.js';
import { getEventFormatKey, getAllowedLitrages } from './eventos-helpers.js';
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
 * buildOperatorDataRequestCopy: Mensaje tras elegir 1 o 2 en el menú.
 *
 * @param {OperatorKind} kind
 * @returns {string}
 */
export function buildOperatorDataRequestCopy(kind) {
  const fields = getOperatorChecklist(kind)
    .map((key) => getOperatorFieldLabel(kind, key))
    .join(', ');
  const tipo = kind === 'event'
    ? 'cotización de evento'
    : kind === 'event_reserva'
      ? 'reserva de evento confirmada'
      : 'venta de barriles desechables';
  const extraHint = kind === 'event_reserva'
    ? 'Si no indicas retiro, queda el *mismo día* del evento. Al *OK* se confirma la reserva en la web (calendario y correo).'
    : 'Cuando esté completo te muestro el resumen para confirmar.';
  return [
    `Ok, envíame los datos para la *${tipo}* (en cualquier orden):`,
    '',
    fields,
    '',
    extraHint,
    buildOperatorCancelHint()
  ].join('\n');
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
 *
 * @param {string} text
 * @returns {string|null} E.164 +569... o null
 */
function parseChilePhoneFromText(text) {
  const digits = String(text || '').replace(/\D/g, '');
  if (/^569\d{8}$/.test(digits)) return `+${digits}`;
  if (/^9\d{8}$/.test(digits)) return `+56${digits}`;
  return null;
}

/**
 * parseStartTimeFromText: Hora de inicio (HH:MM 24h).
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseStartTimeFromText(text) {
  const raw = String(text || '');
  const m = raw.match(/(?:hora(?:\s+de\s+inicio)?|inicio|empieza|a\s+las)\s*[:\-]?\s*(\d{1,2})(?:[:\.](\d{2}))?\s*(am|pm)?/i)
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
 *
 * @param {string} text
 * @returns {'Dispensador Portátil'|'Muro de Coctelería'|null}
 */
function parseFormatFromText(text) {
  const n = normalizeString(text);
  if (/\bmuro\b/.test(n)) return 'Muro de Coctelería';
  if (/\bdispensador\b|\bportatil\b|\bportátil\b/.test(n)) return 'Dispensador Portátil';
  return null;
}

/**
 * parseGuestsFromText: Número de invitados.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseGuestsFromText(text) {
  const m = String(text || '').match(/(?:invitados?|personas?|pax)\s*[:\-]?\s*(\d{1,4})/i)
    || String(text || '').match(/\b(\d{1,4})\s*(?:invitados?|personas?|pax)\b/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
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
  const catalogNames = getCoctelesNamesCatalogCompact()
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

  const formatKey = getEventFormatKey(formato);
  const defaultLiters = formatKey === 'muro' ? '10L' : '5L';
  const allowed = getAllowedLitrages(formatKey);

  const items = [];
  const doubts = [];

  let matched = false;

  const namesInText = matchCocktailNamesInText(text, catalogNames);
  if (namesInText.length > 0) {
    matched = true;
    for (const name of namesInText) {
      const qtyMatch = text.match(new RegExp(`(\\d+)\\s*(?:x\\s*)?${name}`, 'i'))
        || text.match(new RegExp(`${name}[^\\d]*(\\d+)`, 'i'));
      const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      const litMatch = text.match(new RegExp(`${name}[^\\d]*(\\d+)\\s*l`, 'i'))
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
      d.products = d.products || [];
      d.products.push(...value);
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
    const litrage = isEventOperatorKind(kind) ? (item.litrage || '10L') : '5L';
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
  if (email) patch.email = email;

  const phone = parseChilePhoneFromText(text);
  if (phone) patch.phone = phone;

  if (isPrimarilyDateMessage(text) || parseDate(text)) {
    const dateStr = parseDate(text) || text.trim();
    if (dateStr) patch.date = dateStr;
  }

  const location = findLocationByFuzzyMatch(text);
  if (location) patch.comuna = location;

  const names = parsePersonNames(text);
  if (names?.firstName) patch.firstName = names.firstName;
  if (names?.lastName) patch.lastName = names.lastName;

  const addrMatch = text.match(/(?:direcci[oó]n|despacho|entrega)\s*[:\-]?\s*(.+)/i);
  if (addrMatch?.[1]?.trim().length >= 5) {
    patch.address = addrMatch[1].trim();
  }

  const formato = parseFormatFromText(text);
  if (formato) patch.eventoFormato = formato;

  const guests = parseGuestsFromText(text);
  if (guests) patch.guests = guests;

  const pickup = parsePickupFromText(text);
  if (pickup.pickupSameDay) patch.pickupSameDay = true;
  if (pickup.pickupNextDay) patch.pickupNextDay = true;
  if (pickup.pickupTime) patch.pickupTime = pickup.pickupTime;

  const startTime = parseStartTimeFromText(text);
  if (startTime) patch.startTime = startTime;

  const { items, doubts: prodDoubts } = parseProductsFromTextLocal(
    text,
    kind,
    patch.eventoFormato || session.operatorDraft?.eventoFormato
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
 * getMissingOperatorFields: Lista de claves que aún faltan.
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
    session.orderBuilder.type = 'evento';
    session.orderBuilder.products = {};
    for (const item of d.products || []) {
      const litrage = item.litrage || '10L';
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

  const prodLines = (d.products || []).map((p) => {
    if (isEventOperatorKind(kind)) {
      return `• ${p.quantity || 1}x ${p.name} ${p.litrage || ''}`.trim();
    }
    return `• ${p.quantity || 1}x ${p.name}`;
  });
  lines.push('', '*Productos:*', prodLines.length ? prodLines.join('\n') : '_(vacío)_');
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
 *
 * @param {object} session
 * @param {string} messageText
 * @param {boolean} [useAi=true]
 * @returns {Promise<{ missing: string[], doubts: string[], complete: boolean }>}
 */
export async function ingestOperatorMessage(session, messageText, useAi = true) {
  const kind = session.operatorKind;
  const local = parseOperatorDraftLocal(messageText, kind, session);
  applyOperatorDraftPatch(session, local.patch);

  let aiDoubts = [];
  if (useAi && process.env.SKIP_OPERATOR_NLU !== '1') {
    try {
      const catalogNames = getCoctelesNamesCatalogCompact()
        .split('\n')
        .map((l) => l.replace(/^[-•*]\s*/, '').trim())
        .filter(Boolean);
      const ai = await extractOperatorDraftWithAI(messageText, {
        kind,
        catalogNames,
        currentDraft: session.operatorDraft
      });
      if (ai?.patch) applyOperatorDraftPatch(session, ai.patch);
      aiDoubts = Array.isArray(ai?.dudas) ? ai.dudas : [];
    } catch (err) {
      console.warn('operator NLU:', err?.message || err);
    }
  }

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
