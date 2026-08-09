// ==============================================================================
// OBJETIVO: Helpers del checkout de pedido Barriles → confirmación → API.
// Los usan BARRILES_RECOGIDA_DATOS, BARRILES_CONFIRMAR_COMPRA (y contacto legacy).
// ==============================================================================
import { withAssistantFooter } from './flow-rails.js';
import {
  ensureContactBucket,
  applyContactFromMessage,
  applyAddressFromMessage,
  getMissingPersonContactFields,
  getMissingDeliveryAddress,
  parseEmailFromText,
  getEmailTypoSuggestion,
  looksLikeStreetAddress,
  isPrimarilyDateMessage
} from './cot-contact.js';
import {
  toIsoDateFromBotText,
  normalizeBotDateText,
  exampleConcreteDateHint,
  evaluateDeliveryLeadTime
} from './cot-event-quote.js';
import { submitBarrilesSaleFromSession } from './cot-barriles-sale.js';
import { canSubmitCotApiWrite, isCotApiMockMode } from './cot-api.js';
import { formatPrice, preciosData, parseDate, findLocationByFuzzyMatch } from './utils.js';
import { buildAdminBarrilesOrderBody, getBarrilesSaleCreatedReply } from '../views/templates.js';

export {
  ensureContactBucket,
  applyContactFromMessage,
  applyAddressFromMessage,
  parseEmailFromText,
  getEmailTypoSuggestion,
  looksLikeStreetAddress,
  getMissingDeliveryAddress,
  evaluateDeliveryLeadTime
};

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

// ==============================================================================
// CHECKOUT PEDIDO (comuna → fecha → nombre → email → dirección → confirmar)
// ==============================================================================

/** Fases ordenadas del pedido Barriles (una pregunta a la vez). */
export const BARRILES_PEDIDO_PHASES = ['comuna', 'fecha', 'nombre', 'email', 'direccion'];

/**
 * resolveBarrilesPedidoPhase: Qué dato falta ahora en el checkout de pedido.
 *
 * @param {object} session
 * @returns {'comuna'|'fecha'|'nombre'|'email'|'direccion'|'confirm'}
 */
export function resolveBarrilesPedidoPhase(session) {
  ensureClientDataBucket(session);
  ensureContactBucket(session);
  const cd = session.orderBuilder.clientData;
  const c = session.contact || {};

  if (!cd.location) return 'comuna';
  if (!toIsoDateFromBotText(cd.date)) return 'fecha';
  if (!String(c.firstName || '').trim() || !String(c.lastName || '').trim()) return 'nombre';
  if (!String(c.email || '').trim()) return 'email';
  if (getMissingDeliveryAddress(session)) return 'direccion';
  return 'confirm';
}

/**
 * formatBarrilesShippingNote: Texto de despacho según comuna (RM con precio / región por confirmar).
 *
 * @param {object} locationData - Resultado de findLocationByFuzzyMatch
 * @returns {string}
 */
export function formatBarrilesShippingNote(locationData) {
  const name = String(locationData?.name || '').trim() || 'esa comuna';
  if (locationData?.isRM) {
    const cost = locationData?.deliveryCost?.desechable;
    if (cost != null && Number(cost) > 0) {
      return `📍 *${name}* (Región Metropolitana)\nDespacho: *${formatPrice(Number(cost))}*.`;
    }
    return `📍 *${name}* (Región Metropolitana)\nDespacho: valor por confirmar.`;
  }
  return `📍 *${name}* (otras regiones)\nDespacho por *Blue Express* u otra encomienda: valor *por confirmar*.`;
}

/**
 * askBarrilesPedidoPhase: Pregunta corta de la fase actual (tono pedido, no cotización).
 *
 * @param {string} phase
 * @param {object} [session]
 * @returns {string}
 */
export function askBarrilesPedidoPhase(phase, session = {}) {
  const exampleDay = exampleConcreteDateHint();
  const comuna = getDeliveryLocationText(session);

  if (phase === 'comuna') {
    return `*¿A qué comuna enviamos tu pedido?*
_(ej: Providencia o Valparaíso)_`;
  }
  if (phase === 'fecha') {
    return `*¿Para qué fecha quieres la entrega?*
_(ej: ${exampleDay} — mínimo 2 días de anticipación)_`;
  }
  if (phase === 'nombre') {
    return `*¿Me confirmas tu nombre y apellido?*
_(ej: Ana Pérez)_`;
  }
  if (phase === 'email') {
    return `*¿A qué correo enviamos la confirmación de tu pedido?*
_(ej: ana@email.com)_`;
  }
  if (phase === 'direccion') {
    return `*Escríbeme la dirección de entrega${comuna ? ` en *${comuna}*` : ''}.*
_(ej: Los Alerces 123, Depto 456)_`;
  }
  return 'Revisemos los datos de tu pedido…';
}

/**
 * looksLikeBarrilesPedidoCorrectionIntent: ¿El cliente dice que se equivocó / quiere cambiar un dato?
 * Cubre variantes: "me equivoqué", "mejor…", "cambia la fecha", "en realidad es…".
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeBarrilesPedidoCorrectionIntent(text) {
  return /\b(me\s+equivoc|equivocad[oa]|mejor\b|cambia(r|mos)?|correg(ir|e|imos)?|no\s+era|en\s+realidad|era\s+para|es\s+para\b|quise\s+decir|actualiz(a|ar)|otro\s+d[ií]a|otra\s+fecha|otra\s+comuna)\b/i.test(
    String(text || '')
  );
}

/**
 * tryApplyBarrilesPedidoPriorCorrection: Si el mensaje corrige un dato YA pedido
 * (paso anterior), lo actualiza y deja al cliente en la fase actual.
 * Ej.: en fase nombre, "me equivoqué, es para el 13 de agosto" → actualiza fecha
 * y vuelve a pedir nombre (no trata el mensaje como apellido).
 *
 * @param {string} messageText
 * @param {object} session
 * @param {string} currentPhase - Fase en la que estamos ahora
 * @returns {{ field: string, ack: string }|null}
 */
export function tryApplyBarrilesPedidoPriorCorrection(messageText, session, currentPhase) {
  const phase = String(currentPhase || '');
  const phaseIdx = BARRILES_PEDIDO_PHASES.indexOf(phase);
  // Sin fase previa corregible (aún en comuna) o fase desconocida
  if (phaseIdx <= 0) return null;

  ensureClientDataBucket(session);
  ensureContactBucket(session);
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return null;

  const hasCorrIntent = looksLikeBarrilesPedidoCorrectionIntent(trimmed);
  const cd = session.orderBuilder.clientData;

  // --- Fecha (ya la pedimos si phaseIdx > índice de 'fecha') ---
  if (phaseIdx > BARRILES_PEDIDO_PHASES.indexOf('fecha')) {
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
      const lead = evaluateDeliveryLeadTime(normalized, 2);
      if (!lead.ok) {
        const why = lead.reason === 'past' ? 'Esa fecha ya pasó.' : 'No pude leer bien la fecha.';
        return {
          field: 'fecha',
          ack: `${why} Mantengo *${cd.date || 'la fecha anterior'}*.`
        };
      }
      cd.date = normalized;
      session.date = normalized;
      session.barrilesDateNeedsAvailabilityConfirm = Boolean(lead.tooSoon);
      const aviso = lead.tooSoon
        ? `Listo, corregí la entrega a *${normalized}*. Como es con poca anticipación, debemos *confirmar disponibilidad* 🙏`
        : `Listo, corregí la entrega a *${normalized}* ✅`;
      return { field: 'fecha', ack: aviso };
    }
  }

  // --- Comuna (ya pedida si no estamos en comuna) ---
  if (phaseIdx > BARRILES_PEDIDO_PHASES.indexOf('comuna')) {
    const locationSearch = findLocationByFuzzyMatch(trimmed);
    // Evitar pisar: un email o dirección larga no es cambio de comuna
    const hasEmail = Boolean(parseEmailFromText(trimmed));
    const looksAddr = looksLikeStreetAddress(trimmed) && /\d/.test(trimmed);
    const looksComunaMsg = Boolean(locationSearch)
      && !hasEmail
      && !looksAddr
      && (
        hasCorrIntent
        || /^(en\s+)?[A-Za-záéíóúÁÉÍÓÚñÑ\s]{3,40}$/.test(trimmed)
      );
    // Si fuzzy encontró comuna oficial (Las Condes, Providencia…), es corrección.
    // Nombres de persona ("Ana Pérez") no matchean el catálogo de comunas.
    if (looksComunaMsg && locationSearch) {
      cd.location = locationSearch.name;
      cd.locationData = locationSearch;
      session.location = locationSearch.name;
      const note = formatBarrilesShippingNote(locationSearch);
      return { field: 'comuna', ack: `Listo, corregí la comuna.\n${note}` };
    }
  }

  // --- Email (si ya pasamos esa fase) ---
  if (phaseIdx > BARRILES_PEDIDO_PHASES.indexOf('email')) {
    const email = parseEmailFromText(trimmed);
    if (email && (hasCorrIntent || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))) {
      session.contact.email = email;
      return { field: 'email', ack: `Listo, corregí el correo a *${email}* ✅` };
    }
  }

  // --- Nombre (si ya pasamos esa fase y el mensaje parece persona, no fecha/comuna) ---
  if (phaseIdx > BARRILES_PEDIDO_PHASES.indexOf('nombre')) {
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

/**
 * buildBarrilesPedidoIntro: Aviso de pedido + primera pregunta (comuna o la que falte).
 *
 * @param {object} session
 * @returns {string}
 */
export function buildBarrilesPedidoIntro(session) {
  const phase = resolveBarrilesPedidoPhase(session);
  session.barrilesPedidoPhase = phase;
  if (phase === 'confirm') {
    return 'Perfecto, ya tenemos lo necesario para armar tu pedido 🙂';
  }
  return `Perfecto, armemos tu *pedido* 🍹

Te iré pidiendo los datos uno por uno.

${askBarrilesPedidoPhase(phase, session)}`;
}
