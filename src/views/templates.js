import { formatPrice } from '../logic/utils.js';

// ==============================================================================
// OBJETIVO: Textos fijos que el bot envía por WhatsApp (cliente y alertas a admin).
// Aquí NO hay lógica de negocio (eso va en flows/ y logic/).
// Solo funciones que devuelven strings formateados para copiar al chat.
// ==============================================================================

// ==============================================================================
// 1. MENSAJES DE BIENVENIDA Y FILTRO INICIAL
// ==============================================================================

/**
 * getWelcomeBarriles: Mensaje cuando el cliente elige barriles desechables.
 * Devuelve dos bloques: pitch + link, y la pregunta web vs chat (burbujas separadas).
 *
 * @param {boolean} isSwitch - true si el cliente cambió de eventos a barriles a mitad de conversación
 * @returns {string[]} [bloque informativo, pregunta]
 */
export function getWelcomeBarriles(isSwitch = false) {
  // Pregunta final: siempre en su propio mensaje para que se lea con calma
  const question = `¿Dime si prefieres ver la página web o te cuento más *por aquí*?`;

  if (isSwitch) {
    return [
      `¡Buenísimo! Te cuento: la forma más rápida de comprar nuestros barriles desechables, ver fotos y conocer todos los precios es directamente en *nuestra web*: https://cocktailsontap.cl/barriles`,
      question
    ];
  }

  return [
    `👋 Gracias por tu interés en nuestros *Barriles Desechables*.

Cada barril contiene *5 litros* que rinden aprox. *25 cócteles*, lo maravilloso es que vienen listo para servir en segundos y directo a tu copa. 🍸

Tenemos reparto en *Santiago* y por *Blue Express* a todo Chile.

La forma más rápida de comprar, ver fotos y conocer todos los precios es directamente en *nuestra web*: https://cocktailsontap.cl/barriles`,
    question
  ];
}

/**
 * getWelcomeEventos: Mensaje cuando el cliente elige servicio para eventos.
 * Explica Dispensador vs Muro y ofrece web o chat.
 * Devuelve dos bloques: pitch + formatos, y la pregunta web vs chat.
 *
 * @param {boolean} isSwitch - true si cambió de barriles a eventos
 * @returns {string[]} [bloque informativo, pregunta]
 */
export function getWelcomeEventos(isSwitch = false) {
  // Pregunta final: siempre en su propio mensaje (mismo patrón que barriles)
  const question = `¿Prefieres cotizar en la página web o *seguimos por aquí*?`;

  const header = isSwitch
    ? `¡Buenísimo!`
    : `👋 Gracias por tu interés en nuestro *Servicio para Eventos*.`;

  const webLine = isSwitch
    ? ''
    : `\n\nLa forma más rápida de cotizar y armar tu menú en tiempo real es en *nuestra web*: https://cocktailsontap.cl/eventos`;

  return [
    `${header}

Contamos con dos formatos de alto impacto visual:
1. *Dispensador Portátil* (Para todo tipo de evento). La instalación es gratuita y el pedido mínimo es de 10 litros.
2. *Muro de Coctelería* (Matrimonios y eventos grandes). La instalación cuesta $50.000 y el pedido mínimo es de 30 litros.

Ambos formatos incluyen gratis: todo el hielo necesario, decoraciones deshidratadas, vaso/copas en préstamo y accesorios de bar.${webLine}`,
    question
  ];
}

/**
 * WELCOME_SECONDARY_FILTER: Bienvenida del filtro inicial.
 * La mayoría llega desde Instagram ya eligiendo "Desechable" o "Evento";
 * este texto es para quien saluda o escribe sin elegir camino todavía.
 * Siempre nombramos los productos oficiales (no "para la casa").
 */
export const WELCOME_SECONDARY_FILTER = `¡Hola! Somos *Cocktails on Tap* 🍸

¿Buscas *Barriles Desechables* o *Servicio para Eventos*?`;

/** Pregunta corta para re-encaminar sin repetir toda la bienvenida */
export const SHORT_INTENT_QUESTION = `¿Buscas *Barriles Desechables* o *Servicio para Eventos*?`;

/**
 * getOfferQuoteAfterCatalog: Pregunta tras mostrar la carta de barriles.
 * Tono conversacional; keywords en *negrita* para que el cliente elija con naturalidad.
 *
 * @returns {string}
 */
export function getOfferQuoteAfterCatalog() {
  return `¿Te armo una cotización por aquí? Es fácil: me dices qué cócteles de la lista te gustaron y partimos 🍸

Si por ahora solo estabas *mirando*, no hay problema.`;
}

/**
 * getBrowseOnlyGoodbye: Despedida cuando el cliente solo consultaba precios.
 * Invita a Instagram y el flujo cierra con mute.
 *
 * @returns {string}
 */
export function getBrowseOnlyGoodbye() {
  return `¡Ningún problema! Gracias por escribirnos. 🙌\n\nSi quieres conocernos un poco mejor, síguenos en Instagram: https://instagram.com/cocktailsontap.chile\nAhí verás videos e historias destacadas de nuestros cócteles.\n\nCuando quieras cotizar, nos escribes por aquí y te ayudamos con gusto. ¡Hasta pronto! 🍹`;
}

/** Respuesta cuando el cliente dice que le interesan ambas opciones */
export const MENSAJE_AMBAS = `🍸 ¡Perfecto! Te doy un resumen de ambos:

🛢️ *Barriles Desechables*
Barriles de 5 litros que rinden aproximadamente 25 cócteles, listos para servir en segundos. Disponibles en sabores clásicos como Mojito, Caipiriña, Sangría y otros. Son ideales para disfrutar en casa, celebraciones o regalar.
Puedes adquirilos en nuestra tienda virtual: https://cocktailsontap.cl/barriles

🎉 *Servicio para Eventos*
Montamos una *Estacion de Coctelería Autoservicio* con todo lo necesario para que tus invitados disfruten cócteles listos en segundos. Ideal para matrimonios, cumpleaños, empresas y celebraciones de todo tipo.
Puedes cotizar facilmente aquí: https://cocktailsontap.cl/eventos

¿Prefieres revisar la *pagina web* o quieres que te cuente más sobre nuestros *Barriles Desechables* o el *Servicio para Eventos*? 🍹`;

// ==============================================================================
// 2. CATÁLOGO Y COTIZACIÓN
// ==============================================================================

/**
 * getCatalogDesechables: Pitch de venta antes de mostrar la carta de cócteles.
 * Devuelve dos bloques: beneficios, y la pregunta de si quiere ver precios.
 *
 * @param {boolean} isSwitch - Mensaje más corto si viene de otro flujo
 * @returns {string[]} [bloque informativo, pregunta]
 */
export function getCatalogDesechables(isSwitch = false) {
  const intro = isSwitch ? '¡Buenísimo! 🤩' : '¡Excelente elección! 🤩';
  return [
    `${intro} Te cuento por qué nuestros barriles desechables son los favoritos:

✅ Rinden aprox. *25 tragos* (5 Litros).
❄️ Conservan su sabor fresco hasta por *3 semanas* refrigerados (¡puedes servirte un trago y volver a guardarlo!).
💰 El precio parte desde los *$31.990* (cada trago te queda a solo *$1.280* aprox. 🤯).`,
    `¿Quieres conocer los barriles disponibles y sus precios?`
  ];
}

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
    `¿Todo está *correcto* o deseas hacer alguna modificación?`
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

  // Pregunta en segundo mensaje para que el cliente lea bien los montos primero
  return [
    text,
    `¿Tu pedido *está bien* así para avanzar o necesitas *modificar* algo?`
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
    body += `💬 *Último mensaje:* "${lastMessage}"`;
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
 * getEventFormatPitch: Texto de venta del formato elegido + pregunta de confirmación.
 * Dos burbujas: explicación de lo incluido, y "¿continuamos? escribe ok".
 *
 * @param {'dispensador'|'muro'} formatKey - Formato elegido
 * @returns {string[]} [pitch, pregunta]
 */
export function getEventFormatPitch(formatKey) {
  const isMuro = formatKey === 'muro';

  if (isMuro) {
    return [
      `¡Excelente elección! 🍸

Nuestro *Muro de Coctelería* es una opción premium que convierte la barra en un verdadero punto de atracción para tus invitados. Su diseño elegante, iluminación LED y sistema de dispensación permiten servir cócteles de forma rápida, práctica y con una presentación espectacular.

💫 Ideal si buscas sorprender a tus invitados y convertir la barra en parte de la decoración de tu evento.

✨ Todo esto está incluido, sin costo adicional:

🧊 Hielo abundante para todo el evento.
🍊 Garnish premium con frutas deshidratadas y decoraciones.
🥂 Vasos o copas plásticas premium para todos los invitados.
🧰 Accesorios de bar como hieleras, palas, pinzas y todo lo necesario para servir.

⏰ Sin límite de tiempo: instalamos el muro antes de tu evento y lo retiramos al día siguiente, sin costos ocultos.`,
      `¿Te gustaría continuar con el *Muro de Coctelería*? 🍸

Si es así, escribe *ok* y te muestro la lista de cócteles y precios. Si prefieres el *Dispensador*, dímelo y te cuento esa opción.`
    ];
  }

  return [
    `¡Excelente elección! 🍸

Nuestro *Dispensador Portátil* es ideal para eventos. Funciona sin electricidad, mantiene los cócteles fríos con hielo gracias a su tecnología térmica y se adapta fácilmente a espacios pequeños o grandes.

✨ Todo esto está incluido, sin costo adicional:

🧊 Hielo abundante para todo el evento.
🍊 Garnish premium con frutas deshidratadas y decoraciones.
🥂 Vasos o copas plásticas premium para todos los invitados.
🧰 Accesorios de bar como hieleras, palas, pinzas y todo lo necesario para servir.

⏰ Sin límite de tiempo: instalamos el dispensador antes de tu evento y lo retiramos al día siguiente, sin costos ocultos.`,
    `¿Te gustaría continuar con el *Dispensador Portátil*? 🍸

Si es así, escribe *ok* y te muestro la lista de cócteles y precios. Si prefieres el *Muro*, dímelo y te cuento esa opción.`
  ];
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
    `¿Todo bien con estos datos?\nEscribe *ok* para continuar, o corrige lo que necesites (ej: "son 80 invitados" / "es en Providencia").`
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
