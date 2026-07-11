// ==============================================================================
// OBJETIVO: Acciones reutilizables que un estado puede disparar por nombre.
// Validar = interpretar el mensaje. Actuar = armar la respuesta / mute / media.
// Lo usa compile-state.js y los pasos de menú.
// ==============================================================================
import { img } from '../media.js';
import {
  findMentionedCocktail,
  formatDesechablePriceReply
} from '../interruptions.js';
import { getBrowseOnlyGoodbye } from '../../views/templates.js';

// ==============================================================================
// 1. CIERRES SUAVES (mute + despedida)
// ==============================================================================

/**
 * closeBrowseOnly: Despedida de mirón + mute + CERRADO.
 *
 * @returns {{ success: true, nextState: string, customReply: string, mute: true }}
 */
export function closeBrowseOnly() {
  return {
    success: true,
    nextState: 'CERRADO',
    customReply: getBrowseOnlyGoodbye(),
    mute: true
  };
}

/**
 * closeWebBarriles: Manda a la web de barriles y silencia el chat.
 *
 * @returns {object}
 */
export function closeWebBarriles() {
  return {
    success: true,
    nextState: 'CERRADO',
    customReply: `Perfecto 😊
En la *web* encuentras sabores, fotos y precios, y puedes comprar cuando quieras:
https://cocktailsontap.cl/barriles
¡Gracias por tu interés!`,
    mute: true
  };
}

/**
 * closeWebEventos: Manda a la web de eventos y silencia.
 *
 * @returns {object}
 */
export function closeWebEventos() {
  return {
    success: true,
    nextState: 'CERRADO',
    customReply: `¡Listo! Cotiza aquí: https://cocktailsontap.cl/eventos
Si surge una duda, escríbeme. 🥂`,
    mute: true
  };
}

// ==============================================================================
// 2. CARTA / PRECIOS BARRILES
// ==============================================================================

/** Pregunta corta de canal (keywords en negrita). */
export const BARRILES_CHANNEL_SHORT_Q = `¿Prefieres la *web* o te ayudo por *aquí*?
(Si solo miras, escribe *después*.)`;

/**
 * sendBarrilesCatalog: Foto de la carta + pregunta de sabor/cantidad.
 * Inicializa orderBuilder desechable si hace falta.
 *
 * @param {object} _ctx
 * @param {object} session
 * @returns {object}
 */
export function sendBarrilesCatalog(_ctx, session) {
  if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { name: null, date: null, location: null }
    };
  }
  return {
    success: true,
    nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
    customReplies: [
      img('barril_desechable_precios.webp', 'Aquí va la lista de sabores y precios 👆'),
      `Cuando la revises, dime *qué sabor* y *cuántos* barriles quieres.
Ejemplo: *1 mojito y 1 sangría*`
    ]
  };
}

/**
 * replyDesechablePriceOrCatalog: Precio de un cóctel o foto de la carta,
 * sin fingir que eligió WhatsApp (seguimos en filtro de canal).
 *
 * @param {{ messageText: string }} ctx
 * @returns {object}
 */
export function replyDesechablePriceOrCatalog(ctx) {
  const cocktail = findMentionedCocktail(ctx.messageText);
  const priceLine = cocktail ? formatDesechablePriceReply(cocktail) : null;
  if (priceLine) {
    return {
      success: true,
      nextState: 'BARRILES_FILTRO_CANAL',
      customReply: `${priceLine}\n\n${BARRILES_CHANNEL_SHORT_Q}`
    };
  }
  return {
    success: true,
    nextState: 'BARRILES_FILTRO_CANAL',
    customReplies: [img('barril_desechable_precios.webp'), BARRILES_CHANNEL_SHORT_Q]
  };
}

/**
 * routerPriceHint: Orientar a Barriles vs Eventos cuando piden precios sin elegir.
 *
 * @returns {object}
 */
export function routerPriceHint() {
  return {
    success: true,
    nextState: 'ESPERANDO_INTENCION',
    customReply: `Claro 🙂 Para darte *precios* exactos necesito saber el producto:

• *Barriles Desechables* — desde *$31.990* (5L ≈ 25 cócteles)
• *Servicio para Eventos* — según formato e invitados

¿Cuál te interesa? Escribe *Barriles Desechables* o *Servicio para Eventos*.`
  };
}

// ==============================================================================
// 3. REGISTRO
// ==============================================================================

export const ACTIONS = {
  closeBrowseOnly,
  closeWebBarriles,
  closeWebEventos,
  sendBarrilesCatalog,
  replyDesechablePriceOrCatalog,
  routerPriceHint
};
