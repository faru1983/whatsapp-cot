import { formatPrice } from '../logic/utils.js';

// ==============================================================================
// OBJETIVO: Textos fijos que el bot envía al cliente por WhatsApp.
// Aquí NO hay lógica de negocio (eso va en flows/ y logic/).
// Solo funciones que devuelven strings formateados para copiar al chat.
// ==============================================================================

// ==============================================================================
// 1. MENSAJES DE BIENVENIDA Y FILTRO INICIAL
// ==============================================================================

/**
 * getWelcomeBarriles: Mensaje cuando el cliente elige barriles desechables.
 * Ofrece web o continuar por chat.
 *
 * @param {boolean} isSwitch - true si el cliente cambió de eventos a barriles a mitad de conversación
 * @returns {string} Texto para WhatsApp
 */
export function getWelcomeBarriles(isSwitch = false) {
  if (isSwitch) {
    return `¡Buenísimo! Te cuento: la forma más rápida de comprar nuestros barriles desechables, ver fotos y conocer todos los precios es directamente en *nuestra web*: https://cocktailsontap.cl/barriles

¿Dime si prefieres ver la página web o te cuento más *por aquí*?`;
  }

  return `👋 Gracias por tu interés en nuestros *Barriles Desechables*.

Cada barril contiene *5 litros* que rinden aprox. *25 cócteles*, lo maravilloso es que vienen listo para servir en segundos y directo a tu copa. 🍸

La forma más rápida de comprar, ver fotos y conocer todos los precios es directamente en *nuestra web*: https://cocktailsontap.cl/barriles

¿Dime si prefieres ver la página web o te cuento más *por aquí*?`;
}

/**
 * getWelcomeEventos: Mensaje cuando el cliente elige servicio para eventos.
 * Explica Dispensador vs Muro y ofrece web o chat.
 *
 * @param {boolean} isSwitch - true si cambió de barriles a eventos
 * @returns {string} Texto para WhatsApp
 */
export function getWelcomeEventos(isSwitch = false) {
  const intro = isSwitch
    ? `¡Buenísimo!`
    : `👋 Gracias por tu interés en nuestro *Servicio para Eventos*.\n\n`;

  const promoWeb = isSwitch
    ? `\n\n¿Prefieres cotizar en la página web o *seguímos por aquí*?`
    : `\n\nLa forma más rápida de cotizar y armar tu menú en tiempo real es en *nuestra web*: https://cocktailsontap.cl/eventos\n\n¿Prefieres cotizar en la página web o *seguímos por aquí*?`;

  return `${intro} Contamos con dos formatos de alto impacto visual:
1. *Dispensador Portátil* (Para todo tipo de evento). La instalación es gratuita y el pedido mínimo es de 10 litros.
2. *Muro de Coctelería* (Matrimonios y eventos grandes). La instalación cuesta $50.000 y el pedido mínimo es de 30 litros.

Ambos formatos incluyen gratis: todo el hielo necesario, decoraciones deshidratadas, vaso/copas en prestamos y accesorios de bar.${promoWeb}`;
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
 *
 * @param {boolean} isSwitch - Mensaje más corto si viene de otro flujo
 * @returns {string} Texto para WhatsApp
 */
export function getCatalogDesechables(isSwitch = false) {
  const intro = isSwitch ? '¡Buenísimo! 🤩' : '¡Excelente elección! 🤩';
  return `${intro} Te cuento por qué nuestros barriles desechables son los favoritos:

✅ Rinden aprox. *25 tragos* (5 Litros).
❄️ Conservan su sabor fresco hasta por *3 semanas* refrigerados (¡puedes servirte un trago y volver a guardarlo!).
💰 El precio parte desde los *$31.990* (cada trago te queda a solo $1.280 aprox. 🤯).

¿Te muestro los barriles disponibles y sus precios?`;
}

/**
 * getQuotationTemplate: Arma el mensaje de cotización final para barriles desechables.
 * Usa el resultado de OrderBuilder.calculateQuote().
 *
 * @param {object} clientData - { date, location, ... }
 * @param {object} quote - { subtotal, total, details }
 * @param {number|null} deliveryCost - Despacho RM o null
 * @param {object|null} locationData - Datos de comuna (isRM, name, etc.)
 * @returns {string} Cotización formateada para WhatsApp
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

  text += `\n¿Todo está *correcto* o deseas hacer alguna modificación?`;
  return text;
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
 *
 * @param {object} sessionData - Datos del evento (formato, invitados, fecha, ubicación)
 * @param {object} quote - Resultado de calculateQuote (subtotal, installation, total, details, ...)
 * @param {number|null} deliveryCost - Logística RM o null
 * @param {boolean} isRM - true si la comuna está en Región Metropolitana
 * @returns {string} Cotización formateada para WhatsApp
 */
export function getEventQuotationTemplate(sessionData, quote, deliveryCost, isRM) {
  const { eventoFormato, guests, date, location, userName } = sessionData;

  let text = `✅ *COTIZACIÓN DE EVENTO*\n\n`;
  if (userName) text += `👤 *Cliente:* ${userName}\n`;
  text += `🎉 *Formato:* ${eventoFormato || 'No informado'}\n`;
  if (guests) text += `👥 *Invitados:* ${guests}\n`;
  if (date) text += `📅 *Fecha:* ${date}\n`;
  if (location) text += `📍 *Ubicación:* ${location}\n`;
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

  // Tres casos de logística: RM con precio, región, o por confirmar
  if (deliveryCost != null) {
    text += `  Despacho/Logística (${location || 'RM'}): ${formatPrice(deliveryCost)}\n`;
    text += `  -----------------------\n`;
    text += `  *TOTAL: ${formatPrice(quote.total)}*\n`;
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

  text += `\n¿Tu pedido *está bien* así para avanzar o necesitas *modificar* algo?`;
  return text;
}
