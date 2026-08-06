// ==============================================================================
// OBJETIVO: Helpers compartidos del tramo contacto → confirmación → API (Eventos).
// Los usan EVENTOS_DATOS_CONTACTO y EVENTOS_CONFIRMAR_ENVIO.
// ==============================================================================
import { withAssistantFooter } from './flow-rails.js';
import { ensureContactBucket, applyContactFromMessage } from './cot-contact.js';
import {
  applyEventDataFromMessage,
  extractGuestsFromMessage,
  getEventFormatKey
} from './eventos-helpers.js';
import { submitEventQuoteFromSession, toIsoDateFromBotText } from './cot-event-quote.js';
import { isCotApiConfigured } from './cot-api.js';
import { formatPrice, preciosData } from './utils.js';
import { buildAdminEventosOrderBody } from '../views/templates.js';

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
    return `Para enviarte la cotización formal:

*¿Me compartes ${contactBits.join(', ')}?*
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
    const closingReply = [
      '✅ *Cotización creada*',
      '',
      totalStr ? `Total referencial: *${totalStr}*` : null,
      'Aquí tienes tu cotización:',
      session.cotQuote.url,
      '',
      email
        ? `También te enviamos una *copia a tu correo* (*${email}*).`
        : 'También te enviamos una *copia a tu correo*.',
      '',
      'Puedes *revisarla* e incluso *modificarla* en ese link. Cuando estés segura/seguro, *confírmala* desde ahí: en la misma página verás las instrucciones de pago para agendar la reserva.',
      '',
      'Cualquier duda, escríbenos por este chat y te ayudamos. 🥂'
    ].filter(Boolean).join('\n');

    return {
      success: true,
      nextState: 'CERRADO',
      mute: true,
      customReply: closingReply
    };
  }

  if (!isCotApiConfigured()) {
    console.warn('COT API no configurada: cierre eventos sin crear quote web.');
    return legacyCloseEventosWithoutApi(session);
  }

  const result = await submitEventQuoteFromSession(session);
  if (!result.success) {
    console.error('No se pudo crear cotización web:', result.error);
    return {
      success: true,
      nextState: 'EVENTOS_CONFIRMAR_ENVIO',
      customReply: withAssistantFooter(
        `No pude crear la cotización web todavía (${result.error}).\n` +
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
