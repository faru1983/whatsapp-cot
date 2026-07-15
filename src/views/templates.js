import { formatPrice } from '../logic/utils.js';

// ==============================================================================
// OBJETIVO: Textos compartidos (cotización, dudas, alertas admin, pitches eventos).
// Los textos por estado viven en flows/*/states/. Aquí solo lo reutilizable.
// ==============================================================================

// ==============================================================================
// 1. DESPEDIDAS Y ACLARACIONES COMPARTIDAS
// ==============================================================================

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
    text += `${icon} ${detail.quantity}x ${detail.name}: ${formatPrice(detail.lineTotal)}\n`;
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

  // Pregunta en segundo mensaje para que el cliente lea bien los montos primero
  return [
    text,
    `¿Te parece bien esta cotización? Escribe *ok* para confirmarla, o dime qué cambiar.`
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

  // Cada línea: cantidad x cóctel de litraje = subtotal
  for (const detail of quote.details) {
    if (detail.isExtra) {
      text += `✨ ${detail.quantity}x ${detail.name}: ${formatPrice(detail.lineTotal)}\n`;
    } else {
      text += `🍹 ${detail.quantity}x ${detail.name} de ${detail.litrage}: ${formatPrice(detail.price)} x ${detail.quantity} = ${formatPrice(detail.lineTotal)}\n`;
    }
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

  // Pregunta en segundo mensaje: guiamos con *ok*; siguen valiendo está bien / modificar / etc.
  return [
    text,
    `Si el pedido está bien, escribe *ok* para avanzar con la reserva.
_(Si necesitas cambiar algo, escribe *modificar*.)_`
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
 * getEventFormatPitch: Texto de venta del formato elegido (lo incluido).
 * Se envía al elegir Dispensador/Muro, justo antes de la carta de cócteles.
 * Ya no pide un segundo "ok": el siguiente paso es armar el menú.
 *
 * @param {'dispensador'|'muro'} formatKey - Formato elegido
 * @returns {string} Pitch de lo incluido en el servicio
 */
export function getEventFormatPitch(formatKey) {
  const isMuro = formatKey === 'muro';

  if (isMuro) {
    return `¡Excelente elección! 🍸

Nuestro *Muro de Coctelería* es una opción premium que convierte la barra en un verdadero punto de atracción para tus invitados. Su diseño elegante, iluminación LED y sistema de dispensación permiten servir cócteles de forma rápida, práctica y con una presentación espectacular.

💫 Ideal si buscas sorprender a tus invitados y convertir la barra en parte de la decoración de tu evento.

✨ Todo esto está incluido, sin costo adicional:

🧊 Hielo abundante para todo el evento.
🍊 Garnish (frutas deshidratadas) para decorar tus cócteles.
🥂 Vasos/Copas (plásticas premium) en prestamo para todos los invitados.
🧰 Accesorios de bar como hieleras, palas, pinzas y todo lo necesario para servir.

⏰ Sin límite de tiempo: instalamos el muro antes de tu evento y lo retiramos al día siguiente, sin costos ocultos.`;
  }

  return `¡Excelente elección! 🍸

Nuestro *Dispensador Portátil* es ideal para eventos. Funciona sin electricidad, mantiene los cócteles fríos con hielo gracias a su tecnología térmica y se adapta fácilmente a espacios pequeños o grandes.

✨ Todo esto está incluido, sin costo adicional:

🧊 Hielo abundante para todo el evento.
🍊 Garnish (frutas deshidratadas) para decorar tus cócteles.
🥂 Vasos/Copas (plásticas premium) en prestamo para todos los invitados.
🧰 Accesorios de bar como hieleras, palas, pinzas y todo lo necesario para servir.

⏰ Sin límite de tiempo: instalamos el dispensador antes de tu evento y lo retiramos al día siguiente, sin costos ocultos.`;
}

/**
 * getEventLitersSuggestion: Explica cuántos litros pedir según invitados.
 * Texto sugerente (no solo números) para que el cliente entienda el pedido.
 *
 * @param {number} guests - Cantidad de invitados
 * @param {'dispensador'|'muro'} formatKey - Formato (define mínimo)
 * @returns {string}
 */
export function getEventLitersSuggestion(guests, formatKey) {
  const n = Number(guests) || 0;
  // 3 tragos (tranquilo) o 5 (fiesta) × 0.2 L por trago, redondeado a múltiplos de 5L
  const tranquilo = Math.ceil((n * 3 * 0.2) / 5) * 5;
  const fiesta = Math.ceil((n * 5 * 0.2) / 5) * 5;
  const minLiters = formatKey === 'muro' ? 30 : 10;
  const litrajes = formatKey === 'muro' ? '10L, 20L y 30L' : '5L y 10L';

  return `Para orientarte con *${n || 'tus'} invitados*, una buena referencia de consumo es:

🍹 *${tranquilo}L* si el evento es más tranquilo (aprox. 3 tragos por persona)
🎉 *${fiesta}L* si quieren fiesta (aprox. 5 tragos por persona)

El pedido mínimo de este formato es *${minLiters}L* y los barriles vienen en *${litrajes}*. Puedes combinar sabores hasta llegar a esa cantidad (o más, si quieres).`;
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
    `¿Todo bien con estos datos?\n\nEscribe *OK* para continuar, o corrige lo que necesites _(ej: "son 80 invitados" / "es en Providencia")_`
  ];
}

/**
 * getEventFormatRecommendation: Mensaje al salir de confirmación de datos.
 * Recomienda formato según invitados; la pregunta va en segunda burbuja.
 *
 * @param {number} guests - Invitados
 * @param {string} instalacionMuroStr - Precio muro ya formateado (ej. $50.000)
 * @returns {string[]} [recomendación, pregunta]
 */
export function getEventFormatRecommendation(guests, instalacionMuroStr) {
  const recomendacion = guests < 100 ? '*Dispensador Portátil*' : '*Muro de Coctelería*';
  return [
    `Para *${guests} invitados* te recomendamos nuestro ${recomendacion}.

Por supuesto, puedes elegir el que prefieras:

1. *Dispensador Portátil* — instalación gratis, pedido mín. 10L
2. *Muro de Coctelería* — instalación ${instalacionMuroStr}, pedido mín. 30L`,
    `¿Cuál prefieres: *Dispensador* o *Muro*?`
  ];
}
