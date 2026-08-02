// ==============================================================================
// OBJETIVO: Parsers compartidos de contacto (nombre, apellido, email, teléfono).
// Los usan EVENTOS_DATOS_CONTACTO y BARRILES_DATOS_CONTACTO antes de llamar la API.
// ==============================================================================
import { jidToE164 } from './cot-event-quote.js';
import { parseDate, findLocationByFuzzyMatch, normalizeString } from './utils.js';

const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

/** Palabras que nunca son nombre/apellido (preposiciones, meses, etc.). */
const NAME_STOPWORDS = new Set([
  'de', 'del', 'el', 'la', 'los', 'las', 'en', 'para', 'por', 'con', 'mi', 'tu',
  'su', 'y', 'o', 'un', 'una', 'nombre', 'apellido', 'email', 'correo',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'
]);

/**
 * ensureContactBucket: Inicializa session.contact si no existe.
 * Rellena el teléfono desde el JID de WhatsApp cuando falta.
 *
 * @param {object} session
 */
export function ensureContactBucket(session) {
  if (!session.contact || typeof session.contact !== 'object') {
    session.contact = {};
  }
  if (!session.contact.phone && session.clientPhoneE164) {
    session.contact.phone = session.clientPhoneE164;
  }
  if (!session.contact.phone && session.sessionId) {
    session.contact.phone = jidToE164(session.sessionId);
  }
}

/**
 * parseEmailFromText: Extrae el primer email del mensaje.
 * Rechaza dominios con typos comunes (gmial, hotmial…) para no guardar un correo
 * que nunca llegará; el estado pedirá corrección.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseEmailFromText(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i);
  if (!match) return null;
  const email = match[0].toLowerCase();
  const domain = email.split('@')[1] || '';
  // Tipográficos frecuentes: no aceptar silenciosamente
  if (EMAIL_DOMAIN_TYPOS[domain]) return null;
  // Dominio debe tener al menos un punto y TLD de 2+ letras
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(domain)) return null;
  return email;
}

/**
 * Dominios mal escritos frecuentes → sugerencia correcta.
 * Si el cliente escribe ana@gmial.com, no guardamos el typo.
 */
const EMAIL_DOMAIN_TYPOS = {
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.cl': 'gmail.com',
  'gmail.co': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmail.cl': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outllok.com': 'outlook.com',
  'outlook.cl': 'outlook.com',
  'yahho.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yahoo.cl': 'yahoo.com'
};

/**
 * getEmailTypoSuggestion: Si el mensaje trae un email con typo de dominio conocido,
 * devuelve { typed, suggestion } para re-preguntar. Si no hay typo, null.
 *
 * @param {string} text
 * @returns {{ typed: string, suggestion: string }|null}
 */
export function getEmailTypoSuggestion(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i);
  if (!match) return null;
  const typed = match[0].toLowerCase();
  const domain = typed.split('@')[1] || '';
  const fixedDomain = EMAIL_DOMAIN_TYPOS[domain];
  if (!fixedDomain) return null;
  const local = typed.split('@')[0];
  return { typed, suggestion: `${local}@${fixedDomain}` };
}

/**
 * isPrimarilyDateMessage: ¿El mensaje es solo (o casi solo) una fecha?
 * Evita que "15 de diciembre" pise el nombre del cliente.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isPrimarilyDateMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const dateHit = parseDate(raw);
  if (!dateHit) return false;
  const rest = raw
    .replace(dateHit, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[,\s.]+/g, ' ')
    .trim();
  return rest.length === 0;
}

/**
 * parsePersonNames: Intenta sacar nombre y apellido de un mensaje corto.
 * Ej: "Juan Pérez", "Soy Ana López", "nombre: Ana apellido: Soto"
 * Ignora fechas y stopwords ("de", meses) para no guardar "de diciembre".
 *
 * @param {string} text
 * @returns {{ firstName?: string, lastName?: string }}
 */
export function parsePersonNames(text) {
  const raw = String(text || '').trim();
  const out = {};

  const named = raw.match(/nombre\s*:?\s*([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i);
  const lasted = raw.match(/apellido\s*s?\s*:?\s*([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i);
  if (named && !NAME_STOPWORDS.has(named[1].toLowerCase())) out.firstName = named[1];
  if (lasted && !NAME_STOPWORDS.has(lasted[1].toLowerCase())) out.lastName = lasted[1];

  if (out.firstName || out.lastName) return out;

  // Quitamos emails, fechas y ruido para no contaminar el parseo de nombre
  const cleaned = raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(
      new RegExp(`\\b(?:el\\s+)?\\d{1,2}\\s+(?:de\\s+)?(?:${MONTH_NAMES})(?:\\s+(?:de\\s+)?\\d{4})?\\b`, 'gi'),
      ' '
    )
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/^(me\s+llamo|soy|mi\s+nombre\s+es)\s+/i, '')
    .replace(/[,\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || /^\d+$/.test(cleaned)) return out;

  const parts = cleaned
    .split(/\s+/)
    .filter((p) => /^[A-Za-záéíóúÁÉÍÓÚñÑ]{2,}$/.test(p))
    .filter((p) => !NAME_STOPWORDS.has(p.toLowerCase()));

  if (parts.length >= 2) {
    out.firstName = parts[0];
    out.lastName = parts.slice(1).join(' ');
  } else if (parts.length === 1) {
    out.firstName = parts[0];
  }

  return out;
}

/**
 * applyContactFromMessage: Guarda email/nombre/apellido parseados en session.contact.
 * Si ya hay nombre y falta apellido, una sola palabra se toma como apellido
 * (sin pisar el nombre del turno anterior). No interpreta fechas como nombre.
 *
 * @param {string} messageText
 * @param {object} session
 */
export function applyContactFromMessage(messageText, session) {
  ensureContactBucket(session);

  const hadFirstBefore = String(session.contact.firstName || '').trim().length >= 2;
  const hadLastBefore = String(session.contact.lastName || '').trim().length >= 2;

  const email = parseEmailFromText(messageText);
  if (email) session.contact.email = email;

  // "15 de diciembre" / "15/12" → solo fecha: no tocar nombre/apellido
  if (isPrimarilyDateMessage(messageText) && !email) {
    return;
  }

  // Caso "solo apellido": ya teníamos nombre y el cliente responde una palabra
  const singleWord = String(messageText || '').trim();
  if (
    hadFirstBefore
    && !hadLastBefore
    && !email
    && /^[A-Za-záéíóúÁÉÍÓÚñÑ]{2,}$/.test(singleWord)
    && !NAME_STOPWORDS.has(singleWord.toLowerCase())
  ) {
    session.contact.lastName = singleWord;
    return;
  }

  const names = parsePersonNames(messageText);
  const hasNameLabel = /nombre\s*:/i.test(messageText) || /apellido\s*:/i.test(messageText);

  // Si ya teníamos nombre completo, no lo pisamos salvo email junto o etiquetas
  // (tampoco si el mensaje parece solo una dirección de calle)
  if (hadFirstBefore && hadLastBefore && !email && !hasNameLabel) {
    return;
  }

  // Dirección sola: no parsear como nombre
  if (looksLikeStreetAddress(messageText) && !email && !hasNameLabel) {
    return;
  }

  if (names.firstName && (!hadFirstBefore || email || hasNameLabel)) {
    session.contact.firstName = names.firstName;
  }
  if (names.lastName && (!hadLastBefore || email || hasNameLabel)) {
    session.contact.lastName = names.lastName;
  }
}

/**
 * getMissingPersonContactFields: Campos de persona que faltan (nombre, apellido, email).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingPersonContactFields(session) {
  ensureContactBucket(session);
  const missing = [];
  const c = session.contact;

  if (!String(c.firstName || '').trim() || String(c.firstName).trim().length < 2) {
    missing.push('nombre');
  }
  if (!String(c.lastName || '').trim() || String(c.lastName).trim().length < 2) {
    missing.push('apellido');
  }
  if (!String(c.email || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
    missing.push('email');
  }

  return missing;
}

/**
 * looksLikeStreetAddress: ¿Parece dirección de despacho (calle + número)?
 * Ej.: "Los Alerces 123, Depto 456"
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeStreetAddress(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 8 || t.length > 140) return false;
  if (parseEmailFromText(t)) return false;
  if (isPrimarilyDateMessage(t)) return false;
  if (/^\d+\s*(invitados|personas|pax|barriles?)/i.test(t)) return false;
  if (!/\d{1,5}/.test(t)) return false;
  if (!/[A-Za-záéíóúÁÉÍÓÚñÑ]{3,}/.test(t)) return false;
  // Evitar fechas "15 de diciembre" / "15/12/2026"
  if (/^\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(t)) {
    return false;
  }
  if (/^\d{1,2}[/-]\d{1,2}/.test(t)) return false;
  return true;
}

/**
 * parseAddressFromText: Extrae dirección (etiqueta "dirección:" o mensaje calle+número).
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseAddressFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const labeled = raw.match(/(?:direcci[oó]n|dir\.?)\s*:?\s*(.+)$/i);
  if (labeled) {
    const value = labeled[1].trim();
    return value.length >= 5 ? value : null;
  }

  if (looksLikeStreetAddress(raw)) return raw;
  return null;
}

/**
 * matchComunaFromAddressSegment: ¿Este trozo corto es una comuna? (no "Depto 456").
 *
 * @param {string} segment
 * @returns {object|null} Resultado de findLocationByFuzzyMatch
 */
function matchComunaFromAddressSegment(segment) {
  const s = String(segment || '').trim();
  if (!s || s.length < 3 || s.length > 45) return null;
  // Calle/depto llevan número; las comunas no
  if (/\d/.test(s)) return null;

  const cleaned = s
    .replace(/\b(rm|chile|regi[oó]n|metropolitana)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 3) return null;

  const hit = findLocationByFuzzyMatch(cleaned);
  if (!hit?.name) return null;

  const ns = normalizeString(cleaned);
  const nh = normalizeString(hit.name);
  // El segmento debe ser esencialmente el nombre de la comuna (no una frase larga)
  if (ns === nh || ns.includes(nh) || nh.includes(ns)) return hit;
  return hit;
}

/**
 * splitStreetAndComuna: Separa calle y comuna si el cliente las juntó.
 * Ej.: "Los Alerces 123, Depto 456, Providencia" → calle sin Providencia + comuna.
 *
 * @param {string} addressText
 * @param {string|null} [knownComunaName] - Comuna ya guardada en sesión (para strip redundante)
 * @returns {{ street: string, comuna: object|null }}
 */
export function splitStreetAndComuna(addressText, knownComunaName = null) {
  const raw = String(addressText || '').trim();
  if (!raw) return { street: '', comuna: null };

  // 1) Último tramo tras coma / guión: "... , Providencia"
  const parts = raw.split(/\s*[,，]\s*|\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    for (let take = 1; take <= Math.min(2, parts.length - 1); take++) {
      const candidate = parts.slice(parts.length - take).join(' ');
      const hit = matchComunaFromAddressSegment(candidate);
      if (!hit) continue;
      const street = parts.slice(0, parts.length - take).join(', ').trim();
      if (street.length >= 5) return { street, comuna: hit };
    }
  }

  // 2) Comuna ya conocida pegada al final (con o sin coma)
  if (knownComunaName) {
    const knownHit = findLocationByFuzzyMatch(knownComunaName);
    const label = knownHit?.name || knownComunaName;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const trailing = new RegExp(`(?:[,，]\\s*|\\s+)${escaped}\\s*$`, 'i');
    if (trailing.test(raw)) {
      const street = raw.replace(trailing, '').trim();
      if (street.length >= 5) {
        return { street, comuna: knownHit || matchComunaFromAddressSegment(label) };
      }
    }
  }

  // 3) Últimas 1–3 palabras sin coma: "... 123 Providencia" / "... Las Condes"
  const words = raw.split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 3 && n < words.length; n++) {
    const candidate = words.slice(-n).join(' ');
    const rest = words.slice(0, -n).join(' ');
    if (rest.length < 5 || !/\d/.test(rest)) continue;
    const hit = matchComunaFromAddressSegment(candidate);
    if (!hit) continue;
    return { street: rest.trim(), comuna: hit };
  }

  return { street: raw, comuna: null };
}

/**
 * applyAddressFromMessage: Guarda dirección de despacho en session.contact.address.
 * Si el cliente pegó la comuna en la dirección, la separa y sincroniza location.
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {boolean} true si guardó algo
 */
export function applyAddressFromMessage(messageText, session) {
  ensureContactBucket(session);
  const parsed = parseAddressFromText(messageText);
  if (!parsed) return false;

  const known = session.orderBuilder?.clientData?.location || session.location || null;
  const { street, comuna } = splitStreetAndComuna(parsed, known);
  session.contact.address = street;

  // Comuna en la dirección: confirmar o corregir la de sesión
  if (comuna?.name) {
    if (session.orderBuilder?.clientData) {
      session.orderBuilder.clientData.location = comuna.name;
      session.orderBuilder.clientData.locationData = comuna;
    }
    session.location = comuna.name;
  }

  return true;
}

/**
 * getMissingDeliveryAddress: ¿Falta dirección de despacho? (Barriles).
 *
 * @param {object} session
 * @returns {boolean}
 */
export function getMissingDeliveryAddress(session) {
  ensureContactBucket(session);
  return String(session.contact.address || '').trim().length < 5;
}
