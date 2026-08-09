import {
  formatPrice,
  preciosData,
  groupCocktailLinesByName,
  formatEventCocktailLitersLine,
  formatBarrelPartsLabel,
  getMocktailFamilyOptions,
  getAllMocktailNames,
  findLocationByFuzzyMatch
} from '../logic/utils.js';
import { OrderBuilder } from '../logic/order-builder.js';
import { formatMenuBlock, MENU_WRITE_CTA } from '../logic/flow-rails.js';
import { eventFormatFromPrice } from '../logic/eventos-intro.js';

// ==============================================================================
// OBJETIVO: Textos compartidos (cotización, dudas, alertas admin, pitches eventos).
// Los textos por estado viven en flows/*/states/. Aquí solo lo reutilizable.
// ==============================================================================

// ==============================================================================
// 1. DESPEDIDAS Y ACLARACIONES COMPARTIDAS
// ==============================================================================

export { HANDOFF_CLIENT_REPLY, ASSISTANT_FOOTER, withAssistantFooter } from '../logic/flow-rails.js';

/**
 * getBrowseOnlyGoodbye: Despedida cuando el cliente solo está mirando opciones.
 *
 * @returns {string}
 */
export function getBrowseOnlyGoodbye() {
  return `Sin problema 😊
Cuando quieras cotizar o ver precios, escríbeme de nuevo.
¡Que estés muy bien!`;
}

// ==============================================================================
// 2. CATÁLOGO Y COTIZACIÓN
// ==============================================================================

/**
 * getQuotationTemplate: Arma el mensaje de cotización final para barriles desechables.
 * Usa el resultado de OrderBuilder.calculateQuote().
 * Devuelve dos bloques: la cotización completa, y la pregunta de confirmación.
 *
 * @param {object} clientData - { date, location, ... }
 * @param {object} quote - { subtotal, total, details }
 * @param {number|null} deliveryCost - Despacho RM o null
 * @param {object|null} locationData - Datos de comuna (isRM, name, etc.)
 * @returns {string[]} [cotización, pregunta de confirmación]
 */
export function getQuotationTemplate(clientData, quote, deliveryCost, locationData) {
  let text = `✅ *COTIZACIÓN FINAL*\n\n`;
  text += `📅 *Fecha:* ${clientData.date}\n`;
  text += `📍 *Ubicación:* ${clientData.location}\n\n`;

  // Listar cada línea del pedido (cócteles y extras)
  text += `📋 *Tu Pedido:*\n`;
  for (const detail of quote.details) {
    const icon = detail.isExtra ? '✨' : '🍹';
    const itemLabel = detail.isExtra
      ? `${detail.quantity}x ${detail.name}`
      : `${detail.quantity}x ${detail.name} ${detail.litrage || '5L'}`;
    text += `${icon} ${itemLabel}: ${formatPrice(detail.lineTotal)}\n`;
  }

  text += `\n💰 *Resumen de Pago:*\n`;
  text += `  Subtotal: ${formatPrice(quote.subtotal)}\n`;

  // Tres casos de despacho: RM con precio, región encomienda, o por confirmar
  if (deliveryCost) {
    text += `  Despacho (${clientData.location}): ${formatPrice(deliveryCost)}\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.total)}*\n`;
  } else if (locationData && !locationData.isRM) {
    text += `  Despacho (${locationData.name}): Por pagar (Encomienda)\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.subtotal)}*\n`;
  } else {
    text += `  Despacho: Por confirmar\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.subtotal)}*\n`;
  }

  if (quote.totalLiters > 0) {
    text += `\n_Estás solicitando *${quote.totalLiters}L* que equivalen a *${quote.totalDrinks} tragos aprox.*_\n`;
  }

  // Pregunta en segundo mensaje para que el cliente lea bien los montos primero
  return [
    text,
    `¿Te parece bien esta cotización?

1️⃣ *Generar compra*
2️⃣ *Modificar*`
  ];
}

/**
 * getDoubtClarificationTemplate: Cuando el cliente dice algo ambiguo (ej. "piscola").
 * Listamos las opciones del catálogo para que elija una.
 *
 * @param {string} mencionado - Palabra ambigua que dijo el cliente
 * @param {string[]} opciones - Nombres exactos del catálogo
 * @returns {string} Pregunta de aclaración
 */
export function getDoubtClarificationTemplate(mencionado, opciones) {
  let text = `Tengo una pequeña duda sobre "${mencionado}". 🤔\n\n¿Cuál de estas opciones prefieres?\n`;
  opciones.forEach((opcion) => {
    text += `- ${opcion}\n`;
  });
  text += `\n*(Dime el nombre de la que quieres para poder agregarla)* 🍹`;
  return text;
}

/**
 * getFlavorListReply: Lista sabores de una familia (Mojito, Piscola, …) sin mutar el carrito.
 *
 * @param {string} family - Ej. "Mojito"
 * @param {string[]} opciones - Nombres exactos del catálogo
 * @param {{ withLitersHint?: boolean }} [opts]
 * @returns {string}
 */
export function getFlavorListReply(family, opciones, opts = {}) {
  const withLiters = opts.withLitersHint !== false;
  let text = `De *${family}* tenemos estos sabores:\n\n`;
  for (const opcion of opciones || []) {
    text += `- ${opcion}\n`;
  }
  if (withLiters) {
    const example = (opciones && opciones[0]) || family;
    text += `\n*¿Cuál quieres y en qué litros?*
_(ej: 10L ${example})_ 🍹`;
  } else {
    text += `\n*(Dime el nombre de la que quieres para poder agregarla)* 🍹`;
  }
  return text;
}

/**
 * getNonAlcoholicSuggestionReply: Respuesta cuando el cliente pide una opción *sin alcohol*.
 * Si el mensaje/carrito ya apunta a un sabor con alcohol (ej. Mojito), sugiere primero las
 * versiones Mocktail de esa misma familia (Mojito Mocktail, Mojito Maracuyá Mocktail, …);
 * si no hay ninguna relación clara, muestra toda la carta Mocktails. Nunca agrega nada al
 * carrito por su cuenta: solo sugiere y deja que el cliente confirme el nombre exacto.
 *
 * @param {string[]} referenceNames - Cócteles ya en el carrito o mencionados en el mensaje
 * @param {string[]} [catalogNames] - Por defecto, todo el catálogo de datos.json
 * @param {{ withLitersHint?: boolean }} [opts] - `withLitersHint` = true en Eventos (litraje)
 * @returns {string}
 */
export function getNonAlcoholicSuggestionReply(referenceNames, catalogNames, opts = {}) {
  const withLiters = opts.withLitersHint === true;

  const found = new Set();
  for (const ref of referenceNames || []) {
    for (const opcion of getMocktailFamilyOptions(ref, catalogNames)) found.add(opcion);
  }

  const opciones = found.size > 0 ? [...found] : getAllMocktailNames(catalogNames);
  const intro = found.size > 0
    ? `¡Claro! 🍹 Tenemos ${opciones.length > 1 ? 'estas versiones' : 'esta versión'} *sin alcohol*:`
    : `¡Claro! 🍹 Estas son nuestras opciones *sin alcohol (Mocktails)*:`;

  let text = `${intro}\n\n`;
  for (const opcion of opciones) text += `- ${opcion}\n`;

  if (withLiters) {
    const example = opciones[0] || 'Mojito Mocktail';
    text += `\n*¿Cuál quieres y en qué litros?*\n_(ej: 10L ${example})_ 🍹`;
  } else {
    text += `\n*(Dime el nombre de la que quieres para poder agregarla)* 🍹`;
  }
  return text;
}

/**
 * getEventQuotationTemplate: Arma el mensaje de cotización final para eventos.
 * Usa el resultado de OrderBuilder.calculateQuote() con tipo dispensador/muro.
 * Devuelve dos bloques: la cotización completa, y la pregunta de confirmación.
 *
 * @param {object} sessionData - Datos del evento (formato, celebración, invitados, fecha, ubicación)
 * @param {object} quote - Resultado de calculateQuote (subtotal, installation, total, details, ...)
 * @param {number|null} deliveryCost - Logística RM o null
 * @param {boolean} isRM - true si la comuna está en Región Metropolitana
 * @returns {string[]} [cotización, pregunta de confirmación]
 */
export function getEventQuotationTemplate(sessionData, quote, deliveryCost, isRM) {
  const { eventoFormato, celebrationType, guests, date, location } = sessionData;

  let text = `✅ *COTIZACIÓN DE EVENTO*\n\n`;
  // Celebración / fecha / comuna pueden faltar: se muestran como pendientes (no bloquean el flujo)
  text += `🥂 *Celebración:* ${celebrationType || 'No informada'}\n`;
  text += `🎉 *Formato:* ${eventoFormato || 'No informado'}\n`;
  text += `👥 *Invitados:* ${guests || 'No informado'}\n`;
  text += `📅 *Fecha:* ${date || 'Por confirmar'}\n`;
  text += `📍 *Ubicación:* ${location || 'Por confirmar'}\n`;
  text += `\n📋 *Tu Pedido:*\n`;

  // Pedido en litros (cliente); barriles solo como desglose entre paréntesis
  const cocktailGroups = groupCocktailLinesByName(quote.details || []);
  for (const group of cocktailGroups) {
    text += `🍹 ${formatEventCocktailLitersLine(group, { prefix: '', showUnitMath: true })}\n`;
  }
  for (const detail of quote.details || []) {
    if (!detail.isExtra) continue;
    text += `✨ ${detail.quantity}x ${detail.name}: ${formatPrice(detail.lineTotal)}\n`;
  }

  // Resumen de litros y tragos (útil para comparar con invitados)
  if (quote.totalLiters > 0) {
    text += `\n📊 *Consumo estimado:* ${quote.totalLiters}L ≈ ${quote.totalDrinks} tragos`;
    if (guests) {
      const perGuest = (quote.totalDrinks / guests).toFixed(1);
      text += ` (≈ ${perGuest} por invitado)`;
    }
    text += `\n`;
  }

  text += `\n💰 *Resumen de Pago:*\n`;
  text += `  Subtotal cócteles: ${formatPrice(quote.subtotal)}\n`;

  // Instalación: gratis en dispensador, con costo en muro
  if (quote.installation > 0) {
    text += `  Instalación Muro: ${formatPrice(quote.installation)}\n`;
  } else {
    text += `  Instalación Dispensador: ${formatPrice(0)}\n`;
  }

  // Logística: con comuna RM → precio; sin comuna o fuera de RM → pendiente (no inventamos)
  if (deliveryCost != null) {
    text += `  Despacho/Logística (${location}): ${formatPrice(deliveryCost)}\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.total)}*\n`;
  } else if (!location) {
    text += `  Despacho/Logística: *Pendiente* (falta comuna)\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*\n`;
    text += `  _+ logística por confirmar al agendar_\n`;
  } else if (isRM === false) {
    text += `  Despacho/Logística: Por confirmar (fuera de RM)\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*\n`;
    text += `  + Costo Envío/Logística (Por Confirmar)\n`;
  } else {
    text += `  Despacho/Logística: Por confirmar\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*\n`;
  }

  // Si faltó algún litraje en el catálogo, avisamos sin inventar precio
  if (quote.missingPrices?.length > 0) {
    text += `\n⚠️ No encontré precio para:\n`;
    for (const m of quote.missingPrices) {
      text += `- ${m.name} (${m.litrage})\n`;
    }
    text += `Ese ítem no se sumó al total.\n`;
  }

  // Pregunta en segundo mensaje: menú 1️⃣/2️⃣ (también acepta ok / modificar por keyword)
  return [
    text,
    `¿Te parece bien la cotización?

1️⃣ *Continuar*
2️⃣ *Modificar*`
  ];
}

// ==============================================================================
// 4. ALERTAS A ADMINISTRADORES (mismo formato en SOS y cotizaciones)
// ==============================================================================
// Cabecera (tipo + cliente) la arma index.js con el número real de WhatsApp.
// Aquí solo va el *cuerpo*: resumen, pedido y total (o motivo del SOS).
// Estructura final que recibe el admin:
//   {emoji} *TIPO* — {título}
//   👤 Cliente: +569... (NombrePerfil)
//
//   {cuerpo}
// ==============================================================================

/**
 * buildAdminBarrilesOrderBody: Cuerpo de alerta cuando se confirma cotización de barriles.
 * Incluye ubicación, fecha, cócteles, extras y total (la orden no se pierde).
 *
 * @param {object} data
 * @param {string} data.location - Comuna/región del cliente
 * @param {string} data.date - Fecha del pedido
 * @param {string} data.productsText - Líneas de cócteles ya formateadas
 * @param {string} [data.extrasText] - Bloque de extras (puede ir vacío)
 * @param {string} data.totalStr - Total ya formateado con formatPrice
 * @returns {string} Cuerpo del mensaje (sin cabecera de cliente)
 */
export function buildAdminBarrilesOrderBody({ location, date, productsText, extrasText = '', totalStr }) {
  let body = `📋 *Resumen:*\n`;
  body += `- Ubicación: ${location || 'No informada'}\n`;
  body += `- Fecha: ${date || 'No informada'}\n\n`;
  body += `🍹 *Pedido:*\n`;
  body += `${(productsText || '').trim() || '- (ver chat)'}\n`;
  if (extrasText && extrasText.trim()) {
    body += `\n✨ *Extras:*\n${extrasText.trim()}\n`;
  }
  body += `\n💰 *Total a facturar:* ${totalStr || 'Revisar chat'}`;
  return body;
}

/**
 * buildAdminEventosOrderBody: Cuerpo de alerta cuando se confirma cotización de eventos.
 * Incluye datos del evento, menú con litraje y total.
 * El nombre del cliente WhatsApp va en la cabecera (index.js); aquí no pedimos ni inventamos nombre.
 *
 * @param {object} data
 * @param {string} [data.eventoFormato] - Dispensador o Muro
 * @param {string} [data.celebrationType] - Qué celebra (matrimonio, cumpleaños, etc.)
 * @param {string|number} [data.guests] - Cantidad de invitados
 * @param {string} [data.location] - Ubicación
 * @param {string} [data.date] - Fecha del evento
 * @param {string} data.productsText - Líneas del menú ya formateadas
 * @param {string} data.totalStr - Total ya formateado
 * @returns {string} Cuerpo del mensaje (sin cabecera de cliente)
 */
export function buildAdminEventosOrderBody({
  eventoFormato,
  celebrationType,
  guests,
  location,
  date,
  productsText,
  totalStr
}) {
  let body = `📋 *Resumen:*\n`;
  body += `- Celebración: ${celebrationType || 'No informada'}\n`;
  body += `- Formato: ${eventoFormato || 'No informado'}\n`;
  body += `- Invitados: ${guests || 'No informado'}\n`;
  body += `- Ubicación: ${location || 'No informada'}\n`;
  body += `- Fecha: ${date || 'No informada'}\n\n`;
  body += `🍹 *Pedido:*\n`;
  body += `${(productsText || '').trim() || '- (ver chat)'}\n`;
  body += `\n💰 *Total a facturar:* ${totalStr || 'Revisar chat'}`;
  return body;
}

/**
 * buildAdminSosBody: Cuerpo de alerta SOS (pide humano, anti-loop o indecisión).
 *
 * @param {object} data
 * @param {string} data.reason - Por qué se dispara el SOS (texto corto)
 * @param {string} [data.stateId] - Estado actual de la máquina (paso del flujo)
 * @param {string} [data.lastMessage] - Último mensaje del cliente
 * @returns {string} Cuerpo del mensaje (sin cabecera de cliente)
 */
export function buildAdminSosBody({ reason, stateId, lastMessage }) {
  let body = `📌 *Motivo:* ${reason || 'Asistencia requerida'}\n`;
  if (stateId) {
    body += `📍 *Paso:* ${stateId}\n`;
  }
  if (lastMessage != null && String(lastMessage).trim() !== '') {
    // Truncamos para no spamear al admin con pegados enormes / abuso off-topic
    const MAX_LAST_MSG = 200;
    let snippet = String(lastMessage).trim().replace(/\s+/g, ' ');
    if (snippet.length > MAX_LAST_MSG) {
      snippet = `${snippet.slice(0, MAX_LAST_MSG)}…`;
    }
    body += `💬 *Último mensaje:* "${snippet}"`;
  }
  return body.trim();
}

/**
 * composeAdminAlertMessage: Une cabecera estándar + cuerpo.
 * La usa index.js para que TODAS las alertas (SOS y cotización) se vean igual.
 *
 * @param {object} opts
 * @param {'SUCCESS'|'SOS'} opts.type - Tipo de alerta
 * @param {string} opts.title - Subtítulo (ej. "BARRILES DESECHABLES", "ANTI-LOOP")
 * @param {string} opts.clientLabel - Identificación ya formateada: "+569... (Nombre)"
 * @param {string} opts.body - Cuerpo (pedido o motivo SOS)
 * @returns {string} Mensaje completo listo para enviar al admin
 */
export function composeAdminAlertMessage({ type, title, clientLabel, body }) {
  // Cabecera según tipo: cotización confirmada vs pedido de ayuda
  const headline = type === 'SUCCESS'
    ? `✅ *COTIZACIÓN CONFIRMADA* — ${title || 'PEDIDO'}`
    : `⚠️ *SOS — ASISTENCIA*${title ? ` — ${title}` : ''}`;

  return `${headline}\n👤 Cliente: ${clientLabel || 'Desconocido'}\n\n${(body || '').trim()}`;
}

// ==============================================================================
// 5. PITCH DE FORMATOS DE EVENTO (Dispensador / Muro)
// ==============================================================================

/**
 * getEventFormatPitch: Caption corto al elegir Dispensador/Muro (compat / tests).
 * El intro nuevo usa buildFormatPhaseBText; este pitch mantiene la promesa “incluido”.
 *
 * @param {'dispensador'|'muro'} formatKey - Formato elegido
 * @returns {string} Pitch de lo incluido en el servicio
 */
export function getEventFormatPitch(formatKey) {
  const isMuro = formatKey === 'muro';
  const nombre = isMuro ? 'Muro de Coctelería' : 'Dispensador Portátil';
  const install = isMuro
    ? `se instala con un costo de instalación y pagas por los cócteles que elijas`
    : `se instala *gratis* y solo pagas por los cócteles que elijas`;

  return `¡Genial! 🍸 Nuestro *${nombre}* ${install}.

✨ Además, todo esto está incluido sin costo adicional:
🧊 Hielo · 🍊 Garnish · 🥂 Vasos/copas · 🧰 Accesorios de bar

⏰ Instalamos horas antes del evento y retiramos como máximo al día siguiente.`;
}

/**
 * getEventLitersSuggestion: Explica cuántos litros pedir según invitados.
 * Rendimientos del formato (datos.json) en lista clara + referencia 3/5 por persona.
 * El mínimo ya se dijo en fase A; aquí solo se recuerda.
 *
 * @param {number} guests - Cantidad de invitados
 * @param {'dispensador'|'muro'} formatKey - Formato (define mínimo y litrajes)
 * @returns {string}
 */
export function getEventLitersSuggestion(guests, formatKey) {
  const n = Number(guests) || 0;
  const rendimientos = preciosData.rendimientos_barriles || {};
  // 5 cócteles por litro (= 200ml). Si el litraje está en la tabla, usamos ese valor.
  const cocktailsForLiters = (liters) => {
    const fromTable = rendimientos[`${liters}L`];
    if (fromTable != null) return fromTable;
    return liters * 5;
  };

  // 3 tragos (tranquilo) o 5 (fiesta) × 0.2 L por trago, redondeado a múltiplos de 5L
  const tranquilo = Math.ceil((n * 3 * 0.2) / 5) * 5;
  const fiesta = Math.ceil((n * 5 * 0.2) / 5) * 5;
  const minLiters = formatKey === 'muro' ? 30 : 10;
  const litrajes = formatKey === 'muro' ? ['10L', '20L', '30L'] : ['5L', '10L'];
  // Una línea por barril: fácil de escanear en el móvil
  const rendLines = litrajes
    .map((l) => {
      const liters = parseInt(l, 10);
      const cocktails = rendimientos[l] ?? cocktailsForLiters(liters);
      return `- Barril *${l}* → *${cocktails}* cócteles de 200ml`;
    })
    .join('\n');

  const guestsLabel = n ? `*${n} invitados*` : '*tus invitados*';

  return `*Rendimientos aproximados:*
${rendLines}

Para orientarte con ${guestsLabel}, una buena referencia de consumo es:

🍹 *${tranquilo}L* (~${cocktailsForLiters(tranquilo)} cócteles) — evento más tranquilo (~3 por persona)
🎉 *${fiesta}L* (~${cocktailsForLiters(fiesta)} cócteles) — si quieren fiesta (~5 por persona)

Recuerda que el pedido mínimo es *${minLiters}L* y puedes combinar sabores hasta llegar a esa cantidad (o la que prefieras).`;
}

/**
 * getEventDataSummary: Resumen de lo anotado del evento + pregunta de confirmación.
 * Muestra "Por confirmar" en fecha/comuna/celebración si faltan (no bloquean).
 * Dos burbujas: resumen, y "escribe ok o corrige".
 *
 * @param {object} session - Sesión con guests, celebrationType, date, location
 * @returns {string[]} [resumen, pregunta]
 */
export function getEventDataSummary(session) {
  const lines = [
    `📋 *Resumen de tu evento:*`,
    ``,
    `🥂 Celebración: *${session.celebrationType || 'Por confirmar'}*`,
    `👥 Invitados: *${session.guests}*`,
    `📅 Fecha: *${session.date || 'Por confirmar'}*`,
    `📍 Comuna: *${session.location || 'Por confirmar'}*`
  ];

  return [
    lines.join('\n'),
    `*¿Todo bien con estos datos?*

Escribe *OK* para continuar, o corrige lo que necesites.
_(ej: son 80 invitados / es en Providencia)_`
  ];
}

/**
 * getEventosContactIntroAsk: Intro corto (compat). Preferir buildEventosContactIntro.
 *
 * @returns {string}
 */
export function getEventosContactIntroAsk() {
  return `Perfecto 🥂

Para armar tu *cotización formal* y enviarte una *copia al correo*, te pediré unos datos *uno por uno*.

*¿Me confirmas la fecha del evento?*
_(ej: 15 de mayo o 15/05/2026)_`;
}

/**
 * getBarrilesContactIntroAsk: Pedido corto de nombre + correo tras aprobar la cotización barriles.
 *
 * @returns {string}
 */
export function getBarrilesContactIntroAsk() {
  return `Perfecto 🍹

Para enviarte la *copia del pedido* a tu correo, necesito tu *nombre* y *email*.

*¿Me los compartes?*
_(ej: Ana Pérez, ana@email.com)_

_(después te pido la dirección de despacho)_`;
}

/**
 * getEventosQuoteSummary: Resumen final estilo carrito (contacto + cotización) antes de la API.
 * Espejo de getBarrilesPurchaseSummary para Eventos (Dispensador / Muro).
 *
 * @param {object} session
 * @returns {string[]} [resumen, pregunta OK / corregir]
 */
export function getEventosQuoteSummary(session) {
  const formatKey = session.eventoFormato === 'Muro de Coctelería' ? 'muro' : 'dispensador';
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  orderBuilder.products = session.orderBuilder?.products || {};
  orderBuilder.extras = session.orderBuilder?.extras || {};

  let deliveryCost = null;
  let isRM = session.isRM;
  if (session.location) {
    const loc = findLocationByFuzzyMatch(session.location);
    if (loc) {
      isRM = loc.isRM;
      if (loc.isRM && loc.deliveryCost?.evento != null) {
        deliveryCost = loc.deliveryCost.evento;
      }
    }
  }

  const quote = orderBuilder.calculateQuote(deliveryCost);
  if (session.orderBuilder) session.orderBuilder.quote = quote;

  const c = session.contact || {};
  const fullName = titleCaseWords(`${c.firstName || ''} ${c.lastName || ''}`.trim()) || '—';
  const phone = c.phone || session.clientPhoneE164 || '';
  const email = c.email || '—';

  let text = `✅ *COTIZACIÓN FORMAL*\n`;
  text += `====================\n\n`;

  text += `👤 *Datos:*\n`;
  text += phone ? `*${fullName}*, ${phone}\n` : `*${fullName}*\n`;
  text += `_${email}_\n`;
  text += `📅 ${session.date || 'Por confirmar'}\n`;
  text += `📍 ${session.location || 'Por confirmar'}\n`;

  text += `\n--------------------\n\n`;
  text += `🥂 ${session.celebrationType || 'Evento'} · ${session.eventoFormato || '—'}`;
  if (session.guests) text += ` · ${session.guests} invitados`;
  text += `\n\n`;

  text += `🍹 *Pedido*\n`;
  const cocktailGroups = groupCocktailLinesByName(quote.details || []);
  for (const group of cocktailGroups) {
    text += `- ${formatEventCocktailLitersLine(group, { prefix: '', showUnitMath: true })}\n`;
  }
  for (const detail of quote.details || []) {
    if (!detail.isExtra) continue;
    text += `- ${detail.quantity}x ${detail.name}: ${formatPrice(detail.lineTotal)}\n`;
  }

  text += `\n--------------------\n`;
  text += `Subtotal cócteles: ${formatPrice(quote.subtotal)}\n`;
  if (quote.totalLiters > 0) {
    let litersLine = `Litros: ${quote.totalLiters}L · ≈ ${quote.totalDrinks} cócteles`;
    if (session.guests) {
      const perPerson = quote.totalDrinks / session.guests;
      const perPersonStr = Number.isInteger(perPerson)
        ? String(perPerson)
        : perPerson.toFixed(1);
      litersLine += ` (≈ ${perPersonStr} por persona)`;
    }
    text += `${litersLine}\n`;
  }
  if (quote.installation > 0) {
    text += `Instalación Muro: ${formatPrice(quote.installation)}\n`;
  } else {
    text += `Instalación Dispensador: ${formatPrice(0)}\n`;
  }

  if (deliveryCost != null) {
    text += `Despacho/Logística (${session.location}): ${formatPrice(deliveryCost)}\n`;
    text += `====================\n`;
    text += `*TOTAL: ${formatPrice(quote.total)}*`;
  } else if (isRM === false) {
    text += `Despacho/Logística: _por confirmar_ (fuera de RM)\n`;
    text += `====================\n`;
    text += `*TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*\n`;
    text += `_(+ logística por confirmar)_`;
  } else {
    text += `Despacho/Logística: _por confirmar al agendar_\n`;
    text += `====================\n`;
    text += `*TOTAL: ${formatPrice(quote.subtotal + (quote.installation || 0))}*`;
  }

  if (quote.missingPrices?.length > 0) {
    text += `\n\n⚠️ Sin precio en catálogo:\n`;
    for (const m of quote.missingPrices) {
      text += `- ${m.name} (${m.litrage})\n`;
    }
  }

  return [
    text.trim(),
    `*¿Todo bien con tu cotización?*

Escribe *OK* para crearla y enviarte la copia formal, o dime qué quieres *modificar*.
_(ej: email ana@nuevo.com, es en Providencia, quita el aperol)_`
  ];
}

/**
 * getEventosEnvioSummary: Alias del resumen formal (compat CONFIRMAR_ENVIO).
 *
 * @param {object} session
 * @returns {string[]}
 */
export function getEventosEnvioSummary(session) {
  return getEventosQuoteSummary(session);
}

/**
 * titleCaseWords: Capitaliza cada palabra (para mostrar nombre en el resumen).
 *
 * @param {string} text
 * @returns {string}
 */
function titleCaseWords(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * getBarrilesPurchaseSummary: Carrito final del pedido antes de crear la compra web.
 * Datos de contacto/entrega + productos + costos (subtotal, despacho, total).
 *
 * @param {object} session
 * @returns {string[]} [resumen carrito, pregunta OK / modificar]
 */
export function getBarrilesPurchaseSummary(session) {
  const c = session.contact || {};
  const cd = session.orderBuilder?.clientData || {};
  const products = session.orderBuilder?.products || {};
  const extras = session.orderBuilder?.extras || {};
  const fullName = titleCaseWords(`${c.firstName || ''} ${c.lastName || ''}`.trim()) || '—';
  const phone = c.phone || session.clientPhoneE164 || '';
  const locData = cd.locationData;
  const comuna = cd.location || session.location || '—';
  const fecha = cd.date || session.date || '—';

  // Recalculamos totales con OrderBuilder (misma fuente que la cotización)
  const orderBuilder = new OrderBuilder('desechable', preciosData);
  orderBuilder.products = products;
  orderBuilder.extras = extras;
  const deliveryCost = locData?.isRM && locData?.deliveryCost?.desechable != null
    ? Number(locData.deliveryCost.desechable)
    : null;
  const quote = orderBuilder.calculateQuote(deliveryCost);
  if (session.orderBuilder) session.orderBuilder.quote = quote;

  const email = c.email || '—';
  const address = String(c.address || '').trim() || '—';
  const whoLine = phone ? `*${fullName}*, ${phone}` : `*${fullName}*`;
  const addressLine = address !== '—' ? `${address}, ${comuna}` : comuna;

  let text = `🛒 *Resumen de tu pedido*\n`;
  text += `====================\n\n`;

  text += `👤 *Datos:*\n`;
  text += `${whoLine}\n`;
  text += `_${email}_\n`;
  text += `Entrega: *${fecha}*\n`;
  text += `${addressLine}\n`;

  text += `\n--------------------\n\n`;

  text += `🍹 *Producto*\n`;
  if (quote.details?.length) {
    for (const detail of quote.details) {
      const itemLabel = detail.isExtra
        ? `${detail.quantity}x ${detail.name}`
        : `${detail.quantity}x ${detail.name} ${detail.litrage || '5L'}`;
      text += `- ${itemLabel}: *${formatPrice(detail.lineTotal)}*\n`;
    }
  } else {
    text += `- _(sin cócteles en el carrito)_\n`;
  }

  if (quote.totalLiters > 0) {
    text += `\n_≈ ${quote.totalLiters}L · ${quote.totalDrinks} tragos de 200ml_\n`;
  }

  // Totales como parte del pedido (sin título "Costos")
  text += `\n--------------------\n`;
  text += `Subtotal: ${formatPrice(quote.subtotal)}\n`;
  if (deliveryCost != null && deliveryCost > 0) {
    text += `Despacho: ${formatPrice(deliveryCost)}\n`;
    text += `====================\n`;
    text += `*TOTAL: ${formatPrice(quote.total)}*`;
  } else if (locData && !locData.isRM) {
    text += `Despacho: _por confirmar_ (Blue Express)\n`;
    text += `====================\n`;
    text += `*TOTAL: ${formatPrice(quote.subtotal)}*\n`;
    text += `_(+ despacho a confirmar)_`;
  } else {
    text += `Despacho: _por confirmar_\n`;
    text += `====================\n`;
    text += `*TOTAL: ${formatPrice(quote.subtotal)}*`;
  }

  if (session.barrilesDateNeedsAvailabilityConfirm) {
    text += `\n\n⚠️ _Fecha con poca anticipación: confirmaremos disponibilidad._`;
  }

  return [
    text.trim(),
    `*¿Todo bien con tu pedido?*

Escribe *OK* para generarlo, o dime qué quieres *modificar*.
_(ej: cambia la fecha, agrega 1 sangría, la comuna es Providencia)_`
  ];
}

/**
 * getEventFormatRecommendation: Caption de elección Dispensador/Muro (sin invitados).
 * Compat: firma antigua (guests, instalacion) ignorada; el copy ya no usa N invitados.
 *
 * @param {number} [_guests]
 * @param {string} [instalacionMuroStr] - Precio muro ya formateado (opcional)
 * @returns {string}
 */
export function getEventFormatRecommendation(_guests, instalacionMuroStr) {
  const instalacion = instalacionMuroStr
    || formatPrice(preciosData.instalacion_muro || 50000);
  const desdeDisp = formatPrice(eventFormatFromPrice('dispensador'));
  const desdeMuro = formatPrice(eventFormatFromPrice('muro'));
  return `En *Servicio para Eventos* puedes elegir el formato que mejor calza con tu celebración:

1️⃣ *Dispensador Portátil* — ideal para eventos de *cualquier tamaño*. Instalación gratis, pedido mín. 10L, desde *${desdeDisp}*

2️⃣ *Muro de Coctelería* — ideal para eventos *grandes o masivos*. Instalación ${instalacion}, pedido mín. 30L, desde *${desdeMuro}*

${MENU_WRITE_CTA}

${formatMenuBlock(['Dispensador', 'Muro'])}`;
}

// ==============================================================================
// 3. CIERRE TRAS CREAR COTIZACIÓN / COMPRA EN LA WEB
// ==============================================================================

/**
 * joinClosingLines: Une líneas del cierre preservando saltos en blanco.
 * Ojo: NO usar .filter(Boolean) — borra '' y deja el mensaje pegado.
 *
 * @param {Array<string|null|undefined>} lines
 * @returns {string}
 */
function joinClosingLines(lines) {
  return lines.filter((line) => line != null).join('\n');
}

/**
 * getEventQuoteCreatedReply: Mensaje al cliente cuando la cotización web ya existe.
 * Corto, con emojis y aire entre bloques (fácil de escanear en WhatsApp).
 *
 * @param {{ url: string, totalStr?: string|null, email?: string|null }} opts
 * @returns {string}
 */
export function getEventQuoteCreatedReply({ url, totalStr = null, email = null } = {}) {
  const mailLine = email
    ? `📧 Copia enviada a *${email}*`
    : '📧 También te enviamos una copia a tu correo';

  return joinClosingLines([
    '✅ *¡Cotización lista!*',
    '',
    totalStr ? `💰 Total referencial: *${totalStr}*` : null,
    totalStr ? '' : null,
    '🔗 Tu link:',
    String(url || '').trim(),
    '',
    mailLine,
    '',
    '👉 En ese link puedes:',
    '• Revisar y modificar',
    '• Confirmar la reserva',
    '• Ver cómo pagar',
    '',
    '¿Dudas? Escríbenos por aquí 🥂'
  ]);
}

/**
 * getBarrilesSaleCreatedReply: Mensaje al cliente cuando la compra web ya existe.
 * Misma estructura aireada que la cotización de eventos.
 *
 * @param {{ url: string, totalStr?: string|null, email?: string|null }} opts
 * @returns {string}
 */
export function getBarrilesSaleCreatedReply({ url, totalStr = null, email = null } = {}) {
  const mailLine = email
    ? `📧 Copia enviada a *${email}*`
    : '📧 También te enviamos una copia a tu correo';

  return joinClosingLines([
    '✅ *¡Compra lista!*',
    '',
    totalStr ? `💰 Total: *${totalStr}*` : null,
    totalStr ? '' : null,
    '🔗 Tu link:',
    String(url || '').trim(),
    '',
    mailLine,
    '',
    '👉 En esa página puedes:',
    '• Revisar el detalle',
    '• Ver cómo pagar',
    '',
    'Con el pago confirmado, tu pedido queda agendado 🍹',
    '',
    '¿Dudas? Escríbenos por aquí'
  ]);
}
