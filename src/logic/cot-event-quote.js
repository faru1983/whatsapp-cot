// ==============================================================================
// OBJETIVO: Armar el payload de evento para /api/v1/quotes desde la sesión del bot.
// Convierte carrito, formato, fechas en español y contacto al DTO de la web.
// ==============================================================================
import { mapEventCartToApiItems, resolveComunaForApi } from './cot-catalog.js';
import { createEventQuoteViaApi } from './cot-api.js';
import { formatPrice } from './utils.js';
import { getEventQuoteCreatedReply } from '../views/templates.js';

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};

const MONTH_NAMES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

const WEEKDAY_INDEX = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6
};

/**
 * jidToE164: Extrae teléfono E.164 desde el JID de WhatsApp (sessionId).
 * Ej: "56912345678@s.whatsapp.net" → "+56912345678"
 *
 * @param {string} sessionId
 * @returns {string} E.164 o cadena vacía si no se puede
 */
export function jidToE164(sessionId) {
  const raw = String(sessionId || '').split('@')[0] || '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // Chile móvil típico: 569XXXXXXXX
  if (/^569\d{8}$/.test(digits)) return `+${digits}`;
  if (/^9\d{8}$/.test(digits)) return `+56${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return '';
}

/**
 * todayPartsChile: Año/mes/día actuales en zona Chile.
 *
 * @returns {{ year: number, month: number, day: number }}
 */
export function todayPartsChile() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * formatDayMonthEs: "3 de agosto" (sin cero a la izquierda).
 *
 * @param {number} year
 * @param {number} month - 1–12
 * @param {number} day
 * @returns {string}
 */
export function formatDayMonthEs(year, month, day) {
  const name = MONTH_NAMES_ES[month - 1] || 'enero';
  return `${Number(day)} de ${name}`;
}

/**
 * exampleConcreteDateHint: Fecha de ejemplo cercana (hoy Chile + 3 días).
 * Sirve en copy de Barriles para evitar "este sábado" (relativo).
 *
 * @returns {string} Ej. "5 de agosto"
 */
export function exampleConcreteDateHint() {
  const today = todayPartsChile();
  const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
  base.setUTCDate(base.getUTCDate() + 3);
  return formatDayMonthEs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

/**
 * resolveRelativeDateParts: Resuelve hoy/mañana/este sábado → partes de fecha Chile.
 *
 * @param {string} dateText
 * @returns {{ year: number, month: number, day: number }|null}
 */
function resolveRelativeDateParts(dateText) {
  const text = String(dateText || '').trim().toLowerCase();
  if (!text) return null;

  const today = todayPartsChile();
  const base = new Date(Date.UTC(today.year, today.month - 1, today.day));

  if (/\bhoy\b/.test(text) && !/\bpasado\b/.test(text)) {
    return { ...today };
  }
  if (/\bpasado\s+ma[ñn]ana\b/.test(text)) {
    base.setUTCDate(base.getUTCDate() + 2);
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
  }
  if (/\bma[ñn]ana\b/.test(text)) {
    base.setUTCDate(base.getUTCDate() + 1);
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
  }

  const wdMatch = text.match(
    /\b(?:para\s+)?(?:este|el|la)?\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/
  );
  if (wdMatch) {
    const target = WEEKDAY_INDEX[wdMatch[1].toLowerCase()];
    if (target == null) return null;
    const current = base.getUTCDay();
    let delta = (target - current + 7) % 7;
    // "este sábado" el mismo sábado → hoy; si no, el próximo de esa semana
    base.setUTCDate(base.getUTCDate() + delta);
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
  }

  return null;
}

/**
 * formatDdMmYyyy: Fecha canónica chileña para sesión, resumen y API.
 * Ej.: 8, 8, 2026 → "08/08/2026"
 *
 * @param {number} year
 * @param {number} month - 1–12
 * @param {number} day
 * @returns {string}
 */
export function formatDdMmYyyy(year, month, day) {
  const dd = String(Number(day)).padStart(2, '0');
  const mm = String(Number(month)).padStart(2, '0');
  return `${dd}/${mm}/${Number(year)}`;
}

/**
 * isoToDdMmYyyy: "2026-08-08" → "08/08/2026"
 *
 * @param {string} iso
 * @returns {string|null}
 */
function isoToDdMmYyyy(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * normalizeBotDateText: Canoniza fechas concretas a DD/MM/YYYY al guardarlas.
 * Así "8 de agosto" / "mañana" / "este sábado" quedan listas para el resumen
 * y para toIsoDateFromBotText → API, sin volver a adivinar el año después.
 * Solo mes o frases vagas ("diciembre", "próximo año") se dejan igual.
 *
 * @param {string|null|undefined} dateText
 * @returns {string|null}
 */
export function normalizeBotDateText(dateText) {
  const text = String(dateText || '').trim();
  if (!text) return null;

  const iso = toIsoDateFromBotText(text);
  if (iso) {
    return isoToDdMmYyyy(iso);
  }

  return text;
}

/**
 * toIsoDateFromBotText: Convierte texto de fecha del bot a YYYY-MM-DD.
 * Acepta "15 de mayo", "15 diciembre", "15/05/2026", "2026-05-15",
 * y relativas ("hoy", "mañana", "este sábado").
 * Si solo hay mes (sin día), null.
 *
 * Año: si no lo dicen, usa el año actual en Chile. Si ese día/mes ya pasó
 * este año, asume el próximo (ej. "15 enero" en agosto → año siguiente).
 *
 * @param {string|null|undefined} dateText
 * @returns {string|null}
 */
export function toIsoDateFromBotText(dateText) {
  const text = String(dateText || '').trim();
  if (!text) return null;

  // Ya ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // Relativas: hoy / mañana / este sábado
  const rel = resolveRelativeDateParts(text);
  if (rel) {
    return buildIso(rel.year, rel.month, rel.day);
  }

  // dd/mm/yyyy o dd-mm-yyyy (también con espacios: "16 /9 /2026")
  const slash = text.match(/^(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?$/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : todayPartsChile().year;
    if (year < 100) year += 2000;
    // Sin año explícito: si la fecha ya pasó este año → próximo
    if (!slash[3]) {
      const today = todayPartsChile();
      if (month < today.month || (month === today.month && day < today.day)) {
        year += 1;
      }
    }
    return buildIso(year, month, day);
  }

  // "15 de mayo" / "15 diciembre" / "el 3 de diciembre 2027"
  // El "de" entre día y mes es opcional (muy común en chat: "15 diciembre")
  const monthsAlt = Object.keys(MONTHS).join('|');
  const human = text.match(
    new RegExp(
      `(?:el\\s+)?(\\d{1,2})\\s+(?:de\\s+)?(${monthsAlt})(?:\\s+(?:de\\s+)?(\\d{4}))?`,
      'i'
    )
  );
  if (human) {
    const day = Number(human[1]);
    const month = MONTHS[human[2].toLowerCase()];
    let year = human[3] ? Number(human[3]) : todayPartsChile().year;
    const today = todayPartsChile();
    // Si el mes/día ya pasó este año y no dieron año, asumimos el próximo
    if (!human[3] && (month < today.month || (month === today.month && day < today.day))) {
      year += 1;
    }
    return buildIso(year, month, day);
  }

  return null;
}

/**
 * buildIso: Valida y formatea YYYY-MM-DD.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string|null}
 */
function buildIso(year, month, day) {
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * mapCelebrationToEventType: Temática del bot → event_types de Supabase.
 *
 * @param {string|null|undefined} celebrationType
 * @returns {{ type: string, otherType: string }}
 */
export function mapCelebrationToEventType(celebrationType) {
  const raw = String(celebrationType || '').trim();
  const lower = raw.toLowerCase();

  if (/matrimonio|boda|casamiento/.test(lower)) {
    return { type: 'Matrimonio', otherType: '' };
  }
  if (/cumplea|cumple/.test(lower)) {
    return { type: 'Cumpleaños', otherType: '' };
  }
  if (/bautizo/.test(lower)) {
    return { type: 'Bautizo', otherType: '' };
  }
  if (!raw) {
    return { type: '', otherType: '' };
  }
  return { type: 'Otro', otherType: raw };
}

/**
 * dispenserFromSession: "portatil" | "muro" según el formato elegido.
 *
 * @param {object} session
 * @returns {'portatil'|'muro'}
 */
export function dispenserFromSession(session) {
  // Misma regla que getEventFormatKey (evitamos import circular con eventos-helpers)
  const isMuro = session?.eventoFormato === 'Muro de Coctelería';
  return isMuro ? 'muro' : 'portatil';
}

/**
 * buildEventQuotePayload: Arma el body para POST /api/v1/quotes.
 * Resuelve productId/size desde el catálogo API (con caché).
 *
 * @param {object} session
 * @returns {Promise<{ ok: true, payload: object, catalogSource?: string }|{ ok: false, error: string }>}
 */
export async function buildEventQuotePayload(session) {
  const contact = session.contact || {};
  const firstName = String(contact.firstName || '').trim();
  const lastName = String(contact.lastName || '').trim();
  const email = String(contact.email || '').trim().toLowerCase();
  const phone = String(contact.phone || session.clientPhoneE164 || '').trim();
  const comunaRaw = String(session.location || contact.comuna || '').trim();
  const isoDate = toIsoDateFromBotText(session.date || contact.eventDate);

  if (!firstName || firstName.length < 2) {
    return { ok: false, error: 'Falta el nombre del cliente.' };
  }
  if (!lastName || lastName.length < 2) {
    return { ok: false, error: 'Falta el apellido del cliente.' };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Falta un email válido.' };
  }
  if (!comunaRaw) {
    return { ok: false, error: 'Falta la comuna del evento.' };
  }
  if (!isoDate) {
    return { ok: false, error: 'Falta la fecha del evento (usa formato día y mes, ej. 15 de mayo).' };
  }

  // Catálogo vivo (GET /api/v1/catalog) → UUIDs y etiquetas size exactas
  const { items, errors, catalogSource } = await mapEventCartToApiItems(
    session.orderBuilder?.products || {}
  );
  if (errors.length) {
    return { ok: false, error: errors.join(' ') };
  }
  if (!items.length) {
    return { ok: false, error: 'El carrito de cócteles está vacío o no se pudo mapear.' };
  }

  // Comuna oficial del catálogo web; si no existe → "Otra" + otherComuna
  const comunaResolved = await resolveComunaForApi(comunaRaw);
  if (!comunaResolved.matched) {
    console.warn(
      `COT quote: comuna "${comunaRaw}" no está en catálogo → ${comunaResolved.comuna}`
      + (comunaResolved.otherComuna ? ` (otherComuna=${comunaResolved.otherComuna})` : '')
    );
  }

  const eventType = mapCelebrationToEventType(session.celebrationType);

  const payload = {
    source: 'whatsapp',
    client: {
      firstName,
      lastName,
      email,
      phone,
      comuna: comunaResolved.comuna,
      otherComuna: comunaResolved.otherComuna,
      address: String(contact.address || '').trim(),
      comments: String(contact.comments || '').trim()
    },
    event: {
      type: eventType.type,
      otherType: eventType.otherType,
      date: isoDate,
      startTime: String(contact.startTime || '').trim()
    },
    consumption: {
      guests: Number(session.guests) || 0,
      drinksPerPerson: 3
    },
    dispenser: dispenserFromSession(session),
    items
  };

  return {
    ok: true,
    payload,
    catalogSource,
    comunaMatched: Boolean(comunaResolved.matched),
    comunaRaw
  };
}

/**
 * submitEventQuoteFromSession: Valida sesión → llama API → formatea mensaje de cierre.
 *
 * @param {object} session
 * @returns {Promise<{ success: boolean, url?: string, totalPrice?: number, closingReply?: string, error?: string, adminBody?: string }>}
 */
export async function submitEventQuoteFromSession(session) {
  const built = await buildEventQuotePayload(session);
  if (!built.ok) {
    return { success: false, error: built.error };
  }

  // Útil en producción: saber si el mapeo vino de API viva, caché o fallback
  console.log(
    `COT quote: creando draft (catalogSource=${built.catalogSource || '?'},`
    + ` items=${built.payload.items.length}, comuna=${built.payload.client.comuna})`
  );

  const apiResult = await createEventQuoteViaApi(built.payload);
  if (!apiResult.success) {
    return { success: false, error: apiResult.error };
  }

  const totalStr = apiResult.totalPrice != null
    ? formatPrice(apiResult.totalPrice)
    : null;

  const clientEmail = built.payload.client.email;
  const closingReply = getEventQuoteCreatedReply({
    url: apiResult.url,
    totalStr,
    email: clientEmail
  });

  const adminBody = [
    `Cliente: ${built.payload.client.firstName} ${built.payload.client.lastName}`,
    `Email: ${built.payload.client.email}`,
    `WhatsApp: ${built.payload.client.phone || '—'}`,
    `Evento: ${session.celebrationType || '—'} | ${session.guests || '?'} inv. | ${built.payload.event.date}`,
    `Comuna: ${built.payload.client.comuna}`,
    !built.comunaMatched
      ? `⚠️ Comuna no matcheó catálogo web → enviada como "${built.payload.client.comuna}"`
        + (built.payload.client.otherComuna ? ` (otherComuna=${built.payload.client.otherComuna})` : '')
        + (built.comunaRaw ? ` | texto cliente: ${built.comunaRaw}` : '')
      : null,
    `Formato: ${session.eventoFormato || built.payload.dispenser}`,
    `URL: ${apiResult.url}`,
    totalStr ? `Total API: ${totalStr}` : null
  ].filter(Boolean).join('\n');

  session.cotQuote = {
    token: apiResult.token,
    quoteId: apiResult.quoteId,
    url: apiResult.url,
    totalPrice: apiResult.totalPrice,
    status: apiResult.status
  };

  return {
    success: true,
    url: apiResult.url,
    totalPrice: apiResult.totalPrice,
    closingReply,
    adminBody
  };
}
