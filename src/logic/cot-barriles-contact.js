// ==============================================================================
// OBJETIVO: Helpers compartidos del tramo contacto → confirmación → API (Barriles).
// Los usan BARRILES_DATOS_CONTACTO y BARRILES_CONFIRMAR_COMPRA.
// ==============================================================================
import { withAssistantFooter } from './flow-rails.js';
import {
  ensureContactBucket,
  applyContactFromMessage,
  applyAddressFromMessage,
  getMissingPersonContactFields,
  getMissingDeliveryAddress
} from './cot-contact.js';
import { toIsoDateFromBotText, normalizeBotDateText, exampleConcreteDateHint } from './cot-event-quote.js';
import { submitBarrilesSaleFromSession } from './cot-barriles-sale.js';
import { canSubmitCotApiWrite, isCotApiMockMode } from './cot-api.js';
import { formatPrice, preciosData, parseDate, findLocationByFuzzyMatch } from './utils.js';
import { buildAdminBarrilesOrderBody, getBarrilesSaleCreatedReply } from '../views/templates.js';

/**
 * ensureClientDataBucket: Asegura orderBuilder.clientData (fecha/comuna en Barriles).
 *
 * @param {object} session
 */
export function ensureClientDataBucket(session) {
  if (!session.orderBuilder || typeof session.orderBuilder !== 'object') {
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { name: null, date: null, location: null }
    };
  }
  if (!session.orderBuilder.clientData || typeof session.orderBuilder.clientData !== 'object') {
    session.orderBuilder.clientData = { name: null, date: null, location: null };
  }
}

/**
 * getDeliveryDateText: Fecha de entrega desde clientData (o session.date por compat).
 *
 * @param {object} session
 * @returns {string}
 */
export function getDeliveryDateText(session) {
  return String(session.orderBuilder?.clientData?.date || session.date || '').trim();
}

/**
 * getDeliveryLocationText: Comuna desde clientData (o session.location por compat).
 *
 * @param {object} session
 * @returns {string}
 */
export function getDeliveryLocationText(session) {
  return String(session.orderBuilder?.clientData?.location || session.location || '').trim();
}

/**
 * getMissingBarrilesFields: Campos que faltan para POST /direct-sales.
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getMissingBarrilesFields(session) {
  ensureContactBucket(session);
  ensureClientDataBucket(session);
  const missing = getMissingPersonContactFields(session);

  if (!getDeliveryLocationText(session)) missing.push('comuna');
  if (!toIsoDateFromBotText(getDeliveryDateText(session))) missing.push('fecha');
  if (getMissingDeliveryAddress(session)) missing.push('direccion');

  return missing;
}

/**
 * capitalizeMonthHint: Mes con mayúscula inicial para el copy.
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
 * monthNumberHint: Número del mes (01–12) para ejemplo dd/mm.
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
 * askForMissingBarriles: Pregunta corta según lo que falte para generar la compra.
 * Estilo canónico: *pregunta completa?* + _(ej: …)_ en la línea siguiente.
 *
 * @param {string[]} missing
 * @param {object} [session]
 * @returns {string}
 */
export function askForMissingBarriles(missing, session = {}) {
  if (!missing.length) {
    return 'Perfecto, revisemos el resumen antes de crear tu compra…';
  }

  if (missing.length === 1) {
    const field = missing[0];
    const firstName = String(session.contact?.firstName || '').trim();
    const dateText = getDeliveryDateText(session);

    if (field === 'fecha') {
      const hasPartialDate = Boolean(dateText) && !toIsoDateFromBotText(dateText);
      const monthOnly = capitalizeMonthHint(dateText);
      const exampleDay = exampleConcreteDateHint();
      if (hasPartialDate && monthOnly) {
        const mm = monthNumberHint(monthOnly);
        return `Me indicaste entrega en *${monthOnly}*.

*¿Me confirmas el día tentativo?*
_(ej: 15 de ${monthOnly.toLowerCase()} o 15/${mm}/2026)_

_Es necesario para generar la compra._`;
      }
      if (hasPartialDate) {
        return `Anoté *${dateText}*, pero necesito el *día concreto* para generar la compra.

*¿Me confirmas una fecha tentativa?*
_(ej: ${exampleDay} o 15/05/2026)_`;
      }
      return `Para generar la compra:

*¿Me confirmas la fecha de entrega?*
_(ej: ${exampleDay} o 15/05/2026)_`;
    }

    if (field === 'comuna') {
      return `Para generar la compra:

*¿Me confirmas la comuna de entrega?*
_(ej: Providencia o Las Condes)_`;
    }

    if (field === 'direccion') {
      const comuna = getDeliveryLocationText(session);
      if (comuna) {
        return `Para el despacho en *${comuna}*:

*¿Me confirmas la dirección completa?*
_(ej: Los Alerces 123, Depto 456)_`;
      }
      return `Para generar la compra:

*¿Me confirmas la dirección completa de despacho?*
_(ej: Los Alerces 123, Depto 456)_`;
    }

    if (field === 'nombre') {
      return `Para generar tu compra online:

*¿Me confirmas tu nombre?*
_(ej: Ana)_`;
    }

    if (field === 'apellido') {
      if (firstName) {
        return `Gracias *${firstName}*. Para completar la compra:

*¿Me confirmas tu apellido?*
_(ej: Pérez)_`;
      }
      return `Para completar la compra:

*¿Me confirmas tu apellido?*
_(ej: Pérez)_`;
    }

    if (field === 'email') {
      return `Listo${firstName ? `, *${firstName}*` : ''}. Para enviarte la copia del pedido:

*¿Me confirmas tu email?*
_(ej: ana@email.com)_`;
    }

    return `Para generar la compra:

*¿Me compartes este dato: ${field}?*`;
  }

  const contactBits = missing.filter((m) => ['nombre', 'apellido', 'email'].includes(m));
  if (contactBits.length) {
    return `Para enviarte la *copia del pedido*:

*¿Me compartes tu nombre y correo?*
_(ej: Ana Pérez, ana@email.com)_`;
  }

  const deliveryBits = missing.filter((m) => ['fecha', 'comuna'].includes(m));
  if (deliveryBits.length >= 1) {
    return askForMissingBarriles([deliveryBits[0]], session);
  }

  if (missing.includes('direccion')) {
    return askForMissingBarriles(['direccion'], session);
  }

  return `*¿Me compartes lo que falta: ${missing.join(', ')}?*`;
}

/**
 * applyDeliveryDataFromMessage: Actualiza fecha/comuna en orderBuilder.clientData.
 *
 * @param {string} messageText
 * @param {object} session
 */
export function applyDeliveryDataFromMessage(messageText, session) {
  ensureClientDataBucket(session);
  const cd = session.orderBuilder.clientData;

  const parsedDate = parseDate(messageText);
  if (parsedDate) {
    const normalized = normalizeBotDateText(parsedDate) || parsedDate;
    cd.date = normalized;
    session.date = normalized;
  }

  const locationSearch = findLocationByFuzzyMatch(messageText);
  if (locationSearch) {
    cd.location = locationSearch.name;
    cd.locationData = locationSearch;
    session.location = locationSearch.name;
  }
}

/**
 * snapshotBarrilesData: Copia ligera para detectar cambios tras un mensaje.
 *
 * @param {object} session
 * @returns {string}
 */
function snapshotBarrilesData(session) {
  const c = session.contact || {};
  return JSON.stringify({
    missing: getMissingBarrilesFields(session),
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    address: c.address,
    date: getDeliveryDateText(session),
    location: getDeliveryLocationText(session)
  });
}

/**
 * applyBarrilesDataFromMessage: Aplica fecha/comuna/contacto/dirección del mensaje.
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {boolean} true si cambió algún dato
 */
export function applyBarrilesDataFromMessage(messageText, session) {
  ensureContactBucket(session);
  ensureClientDataBucket(session);
  const before = snapshotBarrilesData(session);

  applyDeliveryDataFromMessage(messageText, session);
  applyContactFromMessage(messageText, session);
  applyAddressFromMessage(messageText, session);

  return snapshotBarrilesData(session) !== before;
}

/**
 * legacyCloseBarrilesWithoutApi: Cierre antiguo (alerta admin) si no hay API configurada.
 *
 * @param {object} session
 * @returns {object}
 */
export function legacyCloseBarrilesWithoutApi(session) {
  const clientData = session.orderBuilder?.clientData || {};
  const location = clientData.location || session.location;
  const date = clientData.date || session.date;
  const total = session.orderBuilder?.quote?.total;
  const totalStr = total != null ? formatPrice(total) : 'Revisar chat';

  let adminProducts = '';
  for (const [pName, qty] of Object.entries(session.orderBuilder?.products || {})) {
    const price = preciosData.cocteles[pName]?.desechable?.['5L'] || 0;
    adminProducts += `- ${qty}x ${pName} 5L: ${formatPrice(price * qty)}\n`;
  }

  let adminExtras = '';
  for (const [eName, qty] of Object.entries(session.orderBuilder?.extras || {})) {
    const price = preciosData.extras?.[eName] || 0;
    adminExtras += `- ${qty}x ${eName}: ${formatPrice(price * qty)}\n`;
  }

  const alert = {
    type: 'SUCCESS',
    title: 'BARRILES DESECHABLES',
    labelKey: 'nuevoPedido',
    body: buildAdminBarrilesOrderBody({
      location,
      date,
      productsText: adminProducts,
      extrasText: adminExtras,
      totalStr
    }) + `\n\nContacto: ${session.contact?.firstName || ''} ${session.contact?.lastName || ''}\nEmail: ${session.contact?.email || '—'}\nDirección: ${session.contact?.address || '—'}`
  };

  return {
    success: true,
    nextState: 'CERRADO',
    mute: true,
    notifyAdmin: alert,
    customReply: `✅ Tu pedido quedó registrado.\n\nEn unos minutos alguien de nuestro equipo aprobará tu cotización y te enviará los datos de transferencia.\n\nUna vez confirmado el pago, tu pedido queda agendado. 🍹`
  };
}

/**
 * submitBarrilesSaleConfirmed: Crea la venta web (o legacy) tras confirmación del cliente.
 *
 * Idempotencia de sesión: si ya hay session.cotSale.url de un submit exitoso en
 * este chat, reenviamos el mismo link sin volver a POSTear.
 * Limitación conocida: si la API creó la venta pero la respuesta de red se perdió
 * antes de guardar cotSale, un reintento aún podría duplicar (haría falta
 * Idempotency-Key en la web; fuera de alcance de este bot).
 *
 * @param {object} session
 * @returns {Promise<object>} Resultado de validateAndProcess
 */
export async function submitBarrilesSaleConfirmed(session) {
  // Ya creamos la venta en esta sesión → no duplicar el POST
  if (session.cotSale?.url) {
    const email = String(session.contact?.email || '').trim();
    const totalStr = session.cotSale.totalPrice != null
      ? formatPrice(session.cotSale.totalPrice)
      : null;
    const closingReply = getBarrilesSaleCreatedReply({
      url: session.cotSale.url,
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

  if (!canSubmitCotApiWrite()) {
    console.warn('COT API no configurada: cierre barriles sin crear venta web.');
    return legacyCloseBarrilesWithoutApi(session);
  }

  if (isCotApiMockMode()) {
    console.log('[TEST] Creando venta barriles en modo SIMULADO (sin API real)');
  }

  const result = await submitBarrilesSaleFromSession(session);
  if (!result.success) {
    console.error('No se pudo crear venta web barriles:', result.error);
    return {
      success: true,
      nextState: 'BARRILES_CONFIRMAR_COMPRA',
      customReply: withAssistantFooter(
        `No pude generar la compra web todavía (${result.error}).\n` +
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
      title: 'BARRILES (WEB)',
      labelKey: 'nuevoPedido',
      body: result.adminBody
    },
    customReply: result.closingReply
  };
}

/**
 * wantsToChangeBarrilesOrder: ¿El mensaje pide cambiar cócteles o el pedido?
 * No dispara sobre preguntas logísticas ("¿el pedido llega rápido?").
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsToChangeBarrilesOrder(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return false;

  // Preguntas / dudas logísticas → FAQ, no router de modificación
  if (/\?/.test(text)
    || /^(cu[aá]ndo|c[oó]mo|donde|d[oó]nde|por\s*qu[eé]|porque)\b/i.test(text)
    || /\b(llega|llegan|demora|tarda|despacho|env[ií]o|cu[aá]nto\s+demora)\b/i.test(text)) {
    return false;
  }

  return /\b(c[oó]ctel(?:es)?|sabor(?:es)?|agregar|quitar|eliminar|modificar\s+(el\s+)?pedido|cambiar\s+(el\s+)?pedido|cambiar\s+(los\s+)?c[oó]cteles|agregar\s+barriles?|quitar\s+barriles?)\b/i.test(
    text
  );
}
