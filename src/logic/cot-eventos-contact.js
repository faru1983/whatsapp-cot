// ==============================================================================
// OBJETIVO: Helpers compartidos del tramo contacto → confirmación → API (Eventos).
// Los usan EVENTOS_DATOS_CONTACTO y EVENTOS_CONFIRMAR_ENVIO.
// ==============================================================================
import { withAssistantFooter } from './flow-rails.js';
import {
  ensureContactBucket,
  applyContactFromMessage,
  parseEmailFromText,
  parsePersonNames,
  isPrimarilyDateMessage
} from './cot-contact.js';
import {
  applyEventDataFromMessage,
  extractGuestsFromMessage,
  getEventFormatKey
} from './eventos-helpers.js';
import {
  submitEventQuoteFromSession,
  toIsoDateFromBotText,
  exampleConcreteDateHint,
  normalizeBotDateText
} from './cot-event-quote.js';
import { canSubmitCotApiWrite, isCotApiMockMode } from './cot-api.js';
import { formatPrice, preciosData, parseDate, findLocationByFuzzyMatch } from './utils.js';
import { buildAdminEventosOrderBody, getEventQuoteCreatedReply } from '../views/templates.js';

/**
 * getMissingEventosContactFields: Campos que faltan para la API de eventos.
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingEventosContactFields(session) {
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
  if (!session.location) missing.push('comuna');
  if (!toIsoDateFromBotText(session.date)) missing.push('fecha');
  if (!session.guests) missing.push('invitados');

  return missing;
}

/**
 * capitalizeMonthHint: Deja el mes con mayúscula inicial para el copy.
 *
 * @param {string} dateText
 * @returns {string|null}
 */
function capitalizeMonthHint(dateText) {
  const m = String(dateText || '').match(
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i
  );
  if (!m) return null;
  const month = m[1].toLowerCase();
  return month.charAt(0).toUpperCase() + month.slice(1);
}

/**
 * monthNumberHint: Número del mes (01–12) para el ejemplo dd/mm.
 *
 * @param {string} monthName
 * @returns {string}
 */
function monthNumberHint(monthName) {
  const months = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];
  const idx = months.indexOf(String(monthName || '').toLowerCase());
  if (idx < 0) return '09';
  return String(idx + 1).padStart(2, '0');
}

/**
 * askForMissingEventosContact: Pregunta corta según lo que falte para la API.
 * Estilo canónico: *pregunta completa?* + _(ej: …)_ en la línea siguiente.
 *
 * @param {string[]} missing
 * @param {object} [session]
 * @returns {string}
 */
export function askForMissingEventosContact(missing, session = {}) {
  if (!missing.length) {
    return 'Perfecto, revisemos el resumen antes de crear tu cotización…';
  }

  if (missing.length === 1) {
    const field = missing[0];
    const firstName = String(session.contact?.firstName || '').trim();

    if (field === 'fecha') {
      const hasPartialDate = Boolean(session.date) && !toIsoDateFromBotText(session.date);
      const monthOnly = capitalizeMonthHint(session.date);
      if (hasPartialDate && monthOnly) {
        const mm = monthNumberHint(monthOnly);
        return `Me indicaste que el evento es en *${monthOnly}*.

*¿Me confirmas el día tentativo?*
_(ej: 15 de ${monthOnly.toLowerCase()} o 15/${mm}/2026)_

_Es necesario para generar la cotización formal._`;
      }
      if (hasPartialDate) {
        return `Anoté *${session.date}*, pero necesito el *día concreto* para generar la cotización formal.

*¿Me confirmas una fecha tentativa?*
_(ej: 15 de mayo o 15/05/2026)_`;
      }
      return `Para generar la cotización formal:

*¿Me confirmas la fecha del evento?*
_(ej: 15 de mayo o 15/05/2026)_`;
    }

    if (field === 'comuna') {
      return `Para generar la cotización formal:

*¿Me confirmas la comuna del evento?*
_(ej: Providencia o Las Condes)_`;
    }

    if (field === 'invitados') {
      return `Para generar la cotización formal:

*¿Cuántos invitados serán aproximadamente?*
_(ej: 50)_`;
    }

    if (field === 'nombre') {
      return `Para enviarte la cotización formal:

*¿Me confirmas tu nombre?*
_(ej: Ana)_`;
    }

    if (field === 'apellido') {
      if (firstName) {
        return `Gracias *${firstName}*. Para completar la cotización formal:

*¿Me confirmas tu apellido?*
_(ej: Pérez)_`;
      }
      return `Para completar la cotización formal:

*¿Me confirmas tu apellido?*
_(ej: Pérez)_`;
    }

    if (field === 'email') {
      return `Listo${firstName ? `, *${firstName}*` : ''}. Para enviarte la copia de la cotización formal:

*¿Me confirmas tu email?*
_(ej: ana@email.com)_`;
    }

    return `Para generar la cotización formal:

*¿Me compartes este dato: ${field}?*`;
  }

  const contactBits = missing.filter((m) => ['nombre', 'apellido', 'email'].includes(m));
  if (contactBits.length) {
    return `Para enviarte la *copia formal* de tu cotización:

*¿Me compartes tu nombre y correo?*
_(ej: Ana Pérez, ana@email.com)_`;
  }

  const eventBits = missing.filter((m) => !['nombre', 'apellido', 'email'].includes(m));
  if (eventBits.length >= 1) {
    return askForMissingEventosContact([eventBits[0]], session);
  }

  return `*¿Me compartes lo que falta: ${missing.join(', ')}?*`;
}

/**
 * applyEventosContactDataFromMessage: Aplica datos de evento + contacto del mensaje.
 * Usar en CONFIRMAR_ENVIO (correcciones libres). En DATOS_CONTACTO preferir
 * applyEventosContactPhaseFromMessage para no mezclar comuna → nombre.
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {boolean} true si cambió algún dato
 */
export function applyEventosContactDataFromMessage(messageText, session) {
  ensureContactBucket(session);
  const before = JSON.stringify({
    missing: getMissingEventosContactFields(session),
    contact: { ...session.contact },
    date: session.date,
    location: session.location,
    guests: session.guests,
    celebrationType: session.celebrationType
  });

  applyEventDataFromMessage(messageText, session);
  if (!session.guests) {
    const g = extractGuestsFromMessage(messageText);
    if (g) session.guests = g;
  }
  applyContactFromMessage(messageText, session);

  const after = JSON.stringify({
    missing: getMissingEventosContactFields(session),
    contact: { ...session.contact },
    date: session.date,
    location: session.location,
    guests: session.guests,
    celebrationType: session.celebrationType
  });

  return before !== after;
}

/**
 * applyEventosContactPhaseFromMessage: Aplica SOLO el dato de la fase actual.
 * Evita que "Providencia" se guarde como nombre o que una fecha pise invitados.
 *
 * @param {string} messageText
 * @param {object} session
 * @param {string} phase - fecha | comuna | invitados | nombre | email
 * @returns {boolean} true si cambió el dato de esa fase
 */
export function applyEventosContactPhaseFromMessage(messageText, session, phase) {
  ensureContactBucket(session);
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return false;

  if (phase === 'fecha') {
    const before = session.date;
    const dateSearch = parseDate(trimmed);
    if (!dateSearch) return false;
    session.date = normalizeBotDateText(dateSearch) || dateSearch;
    return session.date !== before;
  }

  if (phase === 'comuna') {
    const before = session.location;
    const locationSearch = findLocationByFuzzyMatch(trimmed);
    if (locationSearch) {
      session.location = locationSearch.name;
      session.isRM = locationSearch.isRM;
      session.region = locationSearch.region;
      return session.location !== before;
    }
    // Fallback: "en Talca" / comuna fuera de catálogo
    const locationMatch = trimmed.match(
      /\b(?:en|comuna(?:\s+de)?)\s+((?:(?:el|la|los|las|lo)\s+)?[A-Za-záéíóúÁÉÍÓÚñÑ0-9]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ0-9]+){0,3})\b/i
    );
    if (locationMatch) {
      const captured = locationMatch[1].trim();
      if (
        captured.length >= 3
        && !/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)$/i.test(captured)
      ) {
        session.location = captured;
        session.isRM = false;
        return session.location !== before;
      }
    }
    // Frase corta sin email/fecha → asumir comuna (fase dedicada)
    if (
      !parseEmailFromText(trimmed)
      && !isPrimarilyDateMessage(trimmed)
      && /^[A-Za-záéíóúÁÉÍÓÚñÑ0-9\s.]{3,40}$/.test(trimmed)
    ) {
      session.location = trimmed.replace(/^(en|comuna)\s+/i, '').trim();
      session.isRM = Boolean(findLocationByFuzzyMatch(session.location)?.isRM);
      return session.location !== before;
    }
    return false;
  }

  if (phase === 'invitados') {
    const before = session.guests;
    let guests = extractGuestsFromMessage(trimmed);
    if (!(guests > 0)) {
      const m = trimmed.match(/^\s*(\d{1,4})\s*$/);
      if (m) {
        const n = Number(m[1]);
        if (n > 0 && n <= 5000) guests = n;
      }
    }
    if (!(guests > 0)) return false;
    session.guests = guests;
    return Number(session.guests) !== Number(before);
  }

  if (phase === 'nombre') {
    const before = `${session.contact?.firstName || ''}|${session.contact?.lastName || ''}`;
    const names = parsePersonNames(trimmed);
    if (!names.firstName) return false;

    if (names.lastName) {
      // Nombre + apellido en un mensaje
      session.contact.firstName = names.firstName;
      session.contact.lastName = names.lastName;
    } else if (!String(session.contact.firstName || '').trim()) {
      // Primera palabra → nombre
      session.contact.firstName = names.firstName;
    } else if (!String(session.contact.lastName || '').trim()) {
      // Segunda respuesta → apellido
      session.contact.lastName = names.firstName;
    } else {
      // Ya había nombre completo: reemplazar con el nuevo parse
      session.contact.firstName = names.firstName;
      if (names.lastName) session.contact.lastName = names.lastName;
    }

    const after = `${session.contact?.firstName || ''}|${session.contact?.lastName || ''}`;
    return after !== before;
  }

  if (phase === 'email') {
    const before = session.contact?.email;
    const email = parseEmailFromText(trimmed);
    if (!email) return false;
    session.contact.email = email;
    return session.contact.email !== before;
  }

  return false;
}

/**
 * legacyCloseEventosWithoutApi: Cierre antiguo si no hay API configurada.
 *
 * @param {object} session
 * @returns {object}
 */
export function legacyCloseEventosWithoutApi(session) {
  const quote = session.orderBuilder?.quote;
  const totalStr = quote?.total != null ? formatPrice(quote.total) : 'Revisar chat';
  const formatKey = getEventFormatKey(session.eventoFormato);

  let adminProducts = '';
  for (const entry of Object.values(session.orderBuilder?.products || {})) {
    const price = preciosData.cocteles[entry.name]?.[formatKey]?.[entry.litrage] || 0;
    adminProducts += `- ${entry.quantity}x ${entry.name} (${entry.litrage}): ${formatPrice(price * entry.quantity)}\n`;
  }

  const alert = {
    type: 'SUCCESS',
    title: 'EVENTOS',
    labelKey: 'nuevoPedido',
    body: buildAdminEventosOrderBody({
      eventoFormato: session.eventoFormato,
      celebrationType: session.celebrationType,
      guests: session.guests,
      location: session.location,
      date: session.date,
      productsText: adminProducts,
      totalStr
    }) + `\n\nContacto: ${session.contact?.firstName || ''} ${session.contact?.lastName || ''}\nEmail: ${session.contact?.email || '—'}`
  };

  return {
    success: true,
    nextState: 'CERRADO',
    mute: true,
    notifyAdmin: alert,
    customReply: `✅ Tu cotización quedó registrada.\n\nEn unos minutos uno de nuestros ejecutivos revisará la disponibilidad y te enviará los datos de transferencia. 🥂`
  };
}

/**
 * submitEventosQuoteConfirmed: Crea la cotización web (o legacy) tras confirmación.
 *
 * Idempotencia de sesión: si ya hay session.cotQuote.url, reenviamos el mismo link
 * sin volver a POSTear. Limitación: si la API creó el quote pero la respuesta se
 * perdió antes de guardar cotQuote, un reintento podría duplicar (haría falta
 * Idempotency-Key en la web; fuera de alcance).
 *
 * @param {object} session
 * @returns {Promise<object>}
 */
export async function submitEventosQuoteConfirmed(session) {
  if (session.cotQuote?.url) {
    const email = String(session.contact?.email || '').trim();
    const totalStr = session.cotQuote.totalPrice != null
      ? formatPrice(session.cotQuote.totalPrice)
      : null;
    const closingReply = getEventQuoteCreatedReply({
      url: session.cotQuote.url,
      totalStr,
      email
    });

    return {
      success: true,
      nextState: 'CERRADO',
      mute: true,
      customReply: closingReply
    };
  }

  // Mock (test:local) permite el cierre con link falso aunque no haya keys
  if (!canSubmitCotApiWrite()) {
    console.warn('COT API no configurada: cierre eventos sin crear quote web.');
    return legacyCloseEventosWithoutApi(session);
  }

  if (isCotApiMockMode()) {
    console.log('[TEST] Creando cotización eventos en modo SIMULADO (sin API real)');
  }

  const result = await submitEventQuoteFromSession(session);
  if (!result.success) {
    console.error('No se pudo crear cotización web:', result.error);
    return {
      success: true,
      nextState: 'EVENTOS_CONFIRMAR_ENVIO',
      customReply: withAssistantFooter(
        `No pude crear la cotización web todavía.\n` +
        `¿Revisamos los datos o prefieres escribir *HUMANO*?`
      ),
      flowProgress: true
    };
  }

  return {
    success: true,
    nextState: 'CERRADO',
    mute: true,
    notifyAdmin: {
      type: 'SUCCESS',
      title: 'EVENTOS (WEB)',
      labelKey: 'nuevoPedido',
      body: result.adminBody
    },
    customReply: result.closingReply
  };
}

/**
 * wantsToChangeEventosOrder: ¿El mensaje pide cambiar cócteles o el menú?
 * No dispara sobre preguntas logísticas ("¿el pedido llega rápido?").
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsToChangeEventosOrder(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return false;

  if (/\?/.test(text)
    || /^(cu[aá]ndo|c[oó]mo|donde|d[oó]nde|por\s*qu[eé]|porque)\b/i.test(text)
    || /\b(llega|llegan|demora|tarda|despacho|env[ií]o|cu[aá]nto\s+demora)\b/i.test(text)) {
    return false;
  }

  return /\b(c[oó]ctel(?:es)?|sabor(?:es)?|men[uú]|agregar|quitar|eliminar|modificar\s+(el\s+)?men[uú]|cambiar\s+(el\s+)?men[uú]|cambiar\s+(los\s+)?c[oó]cteles|litros?)(?=\s|$|[.,!?¿?])/i.test(
    text
  );
}

// ==============================================================================
// CHECKOUT FORMAL (fases uno a uno — espejo de Barriles, sin dirección)
// Orden: fecha → comuna → nombre → email → confirm (resumen cotización)
// ==============================================================================

/**
 * Fases del contacto Eventos.
 * Invitados casi siempre vienen de EVENTOS_RECOGIDA_DATOS; si faltan, se piden aquí
 * (red de seguridad) entre comuna y nombre.
 */
export const EVENTOS_CONTACT_PHASES = ['fecha', 'comuna', 'invitados', 'nombre', 'email'];

/**
 * resolveEventosContactPhase: Qué dato falta ahora para la cotización formal.
 *
 * @param {object} session
 * @returns {'fecha'|'comuna'|'invitados'|'nombre'|'email'|'confirm'}
 */
export function resolveEventosContactPhase(session) {
  ensureContactBucket(session);
  const c = session.contact || {};

  if (!toIsoDateFromBotText(session.date)) return 'fecha';
  if (!session.location) return 'comuna';
  // Red de seguridad: invitados deberían venir del intro
  if (!(Number(session.guests) > 0)) return 'invitados';
  if (!String(c.firstName || '').trim() || !String(c.lastName || '').trim()) return 'nombre';
  if (!String(c.email || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
    return 'email';
  }
  return 'confirm';
}

/**
 * askEventosContactPhase: Pregunta corta de la fase actual.
 *
 * @param {string} phase
 * @param {object} [session]
 * @returns {string}
 */
export function askEventosContactPhase(phase, session = {}) {
  const exampleDay = exampleConcreteDateHint();
  const firstName = String(session.contact?.firstName || '').trim();

  if (phase === 'fecha') {
    const hasPartialDate = Boolean(session.date) && !toIsoDateFromBotText(session.date);
    const monthOnly = capitalizeMonthHint(session.date);
    if (hasPartialDate && monthOnly) {
      const mm = monthNumberHint(monthOnly);
      return `Me indicaste que el evento es en *${monthOnly}*.

*¿Me confirmas el día tentativo?*
_(ej: 15 de ${monthOnly.toLowerCase()} o 15/${mm}/2026)_`;
    }
    if (hasPartialDate) {
      return `Anoté *${session.date}*, pero necesito el *día concreto*.

*¿Me confirmas una fecha tentativa?*
_(ej: ${exampleDay} o 15/05/2026)_`;
    }
    return `*¿Me confirmas la fecha del evento?*
_(ej: ${exampleDay} o 15/05/2026)_`;
  }

  if (phase === 'comuna') {
    return `*¿En qué comuna será el evento?*
_(ej: Providencia o Las Condes)_`;
  }

  if (phase === 'invitados') {
    return `*¿Cuántos invitados serán aproximadamente?*
_(ej: 50)_`;
  }

  if (phase === 'nombre') {
    return `*¿Me confirmas tu nombre y apellido?*
_(ej: Ana Pérez)_`;
  }

  if (phase === 'email') {
    return `*¿A qué correo enviamos la copia formal de tu cotización?*
_(ej: ana@email.com)_`;
  }

  if (firstName) {
    return `Gracias *${firstName}*. Revisemos el resumen…`;
  }
  return 'Revisemos el resumen de tu cotización…';
}

/**
 * buildEventosContactIntro: Aviso de cotización formal + primera pregunta.
 *
 * @param {object} session
 * @returns {string}
 */
export function buildEventosContactIntro(session) {
  const phase = resolveEventosContactPhase(session);
  session.eventosContactPhase = phase;
  if (phase === 'confirm') {
    return 'Perfecto, ya tenemos lo necesario para armar tu cotización formal 🙂';
  }
  return `Perfecto 🥂

Para armar tu *cotización formal* y enviarte una *copia al correo*, te pediré unos datos.

${askEventosContactPhase(phase, session)}`;
}

/**
 * looksLikeEventosContactCorrectionIntent: ¿Dice que se equivocó / quiere cambiar un dato?
 * Misma familia que Barriles: perdón, era el…, me equivoqué, mejor…, etc.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeEventosContactCorrectionIntent(text) {
  return /\b(me\s+equivoq|equivocad[oa]|perd[oó]n|disculp[ae]?|mejor\b|cambia(r|mos)?|correg(ir|e|imos)?|no\s+era|en\s+realidad|era\s+(el|la|para)|es\s+(el|la|para)\b|quise\s+decir|actualiz(a|ar)|otro\s+d[ií]a|otra\s+fecha|otra\s+comuna)\b/i.test(
    String(text || '')
  );
}

/**
 * tryApplyEventosContactPriorCorrection: Corrige un dato ya pedido sin confundir la fase actual.
 *
 * @param {string} messageText
 * @param {object} session
 * @param {string} currentPhase
 * @returns {{ field: string, ack: string }|null}
 */
export function tryApplyEventosContactPriorCorrection(messageText, session, currentPhase) {
  const phase = String(currentPhase || '');
  const phaseIdx = EVENTOS_CONTACT_PHASES.indexOf(phase);
  if (phaseIdx <= 0) return null;

  ensureContactBucket(session);
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return null;

  const hasCorrIntent = looksLikeEventosContactCorrectionIntent(trimmed);

  if (phaseIdx > EVENTOS_CONTACT_PHASES.indexOf('fecha')) {
    const rawDate = parseDate(trimmed);
    const looksDate = Boolean(rawDate)
      && (
        hasCorrIntent
        || isPrimarilyDateMessage(trimmed)
        || /^(para\s+(el|la)|el|la)\s+/i.test(trimmed)
        || /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(trimmed)
      );
    if (looksDate && rawDate) {
      const normalized = normalizeBotDateText(rawDate) || rawDate;
      // Solo aceptar si quedó fecha concreta (no mes suelto)
      if (!toIsoDateFromBotText(normalized) && !toIsoDateFromBotText(rawDate)) {
        return null;
      }
      session.date = normalized;
      return { field: 'fecha', ack: `Listo, corregí la fecha a *${normalized}* ✅` };
    }
  }

  if (phaseIdx > EVENTOS_CONTACT_PHASES.indexOf('comuna')) {
    const locationSearch = findLocationByFuzzyMatch(trimmed);
    const hasEmail = Boolean(parseEmailFromText(trimmed));
    const looksComunaMsg = Boolean(locationSearch)
      && !hasEmail
      && (
        hasCorrIntent
        || /^(en\s+)?[A-Za-záéíóúÁÉÍÓÚñÑ\s]{3,40}$/.test(trimmed)
      );
    if (looksComunaMsg && locationSearch) {
      session.location = locationSearch.name;
      session.isRM = locationSearch.isRM;
      session.region = locationSearch.region;
      return { field: 'comuna', ack: `Listo, corregí la comuna a *${locationSearch.name}* ✅` };
    }
  }

  if (phaseIdx > EVENTOS_CONTACT_PHASES.indexOf('email')) {
    const email = parseEmailFromText(trimmed);
    if (email && (hasCorrIntent || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))) {
      session.contact.email = email;
      return { field: 'email', ack: `Listo, corregí el correo a *${email}* ✅` };
    }
  }

  if (phaseIdx > EVENTOS_CONTACT_PHASES.indexOf('nombre')) {
    if (!isPrimarilyDateMessage(trimmed) && !findLocationByFuzzyMatch(trimmed)) {
      const before = `${session.contact?.firstName || ''}|${session.contact?.lastName || ''}`;
      applyContactFromMessage(trimmed, session);
      const c = session.contact || {};
      const after = `${c.firstName || ''}|${c.lastName || ''}`;
      if (
        after !== before
        && String(c.firstName || '').trim()
        && String(c.lastName || '').trim()
        && (hasCorrIntent || /^\s*[A-Za-záéíóúÁÉÍÓÚñÑ]+(\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)+\s*$/.test(trimmed))
      ) {
        return {
          field: 'nombre',
          ack: `Listo, corregí el nombre a *${c.firstName} ${c.lastName}* ✅`
        };
      }
    }
  }

  return null;
}
