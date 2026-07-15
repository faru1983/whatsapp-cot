// ==============================================================================
// OBJETIVO: Paso BARRILES_RECOGIDA_PRODUCTOS — NLU + carrito de cócteles 5L.
// Textos, prompt IA y lógica de productos en un solo archivo.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { img } from '../../../logic/media.js';
import {
  preciosData,
  formatPrice,
  parseElimination,
  findClosestCatalogMatch,
  resolveDoubtsProgrammatically,
  isOnlyBrowsing,
  wantsInstagramOrSocial
} from '../../../logic/utils.js';
import { wantsAdvanceProductsOrder, isOnlyAdvanceProductsOrder } from '../../../logic/interruptions.js';
import { extractProductsWithAI } from '../../../core/llm.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import { getDoubtClarificationTemplate, getBrowseOnlyGoodbye } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: CATÁLOGO (FALLBACK)]
El cliente debe indicar sabor y cantidad de Barriles Desechables (5L).
1. Duda breve (ingredientes, despacho RM / encomienda regiones). NUNCA inventes costos.
2. Solo formato 5L. Si solo mira / no quiere ahora: despídete y NO preguntes más.
3. Si no: cierra pidiendo sabor/cantidad (ej. "1 mojito y 1 sangría"). Si ya tiene pedido, puede escribir *seguimos*.`;

/**
 * formatCartLines: Lista de ítems + subtotal (sin saludo).
 *
 * @param {object} products - Mapa nombre → cantidad
 * @returns {string}
 */
function formatCartLines(products) {
  const orderBuilder = new OrderBuilder('desechable', preciosData);
  orderBuilder.products = products;
  const quote = orderBuilder.calculateQuote();

  let lines = '';
  for (const [name, qty] of Object.entries(products)) {
    const price = preciosData.cocteles[name]?.desechable?.['5L'] || 0;
    lines += `- ${qty}x ${name}: ${formatPrice(price * qty)}\n`;
  }
  lines += `\n*Subtotal de cócteles:* ${formatPrice(quote.subtotal)}`;
  return lines;
}

/**
 * buildCartConfirmReply: Resumen de cócteles + pregunta (*seguimos* solo aquí, con carrito lleno).
 *
 * @param {object} products - Mapa nombre → cantidad
 * @returns {string}
 */
function buildCartConfirmReply(products) {
  return `🍹 Te confirmo los cócteles seleccionados:

${formatCartLines(products)}

¿Agregas otro sabor o *seguimos* con estos? 🍸`;
}

/**
 * hasDeliveryData: ¿Ya tenemos fecha y comuna? (se piden en la entrada del flujo).
 *
 * @param {object} session
 * @returns {boolean}
 */
function hasDeliveryData(session) {
  const cd = session.orderBuilder?.clientData;
  return Boolean(cd?.date && cd?.location);
}

/**
 * nextStateAfterProducts: Si ya hay despacho → cotización; si no → pedir datos.
 *
 * @param {object} session
 * @returns {'BARRILES_REVISION_COTIZACION'|'BARRILES_RECOGIDA_DATOS'}
 */
function nextStateAfterProducts(session) {
  return hasDeliveryData(session)
    ? 'BARRILES_REVISION_COTIZACION'
    : 'BARRILES_RECOGIDA_DATOS';
}

export const BARRILES_RECOGIDA_PRODUCTOS = defineState({
  id: 'BARRILES_RECOGIDA_PRODUCTOS',
  // Al entrar: solo pedimos sabor/cantidad. *seguimos* se ofrece cuando ya hay carrito.
  promptQuestion: () => `Dime *qué sabor* y *cuántos* barriles (ej. *1 mojito y 1 sangría*).`,
  shortQuestion: `¿Agregas otro, quitas alguno, o *seguimos*?`,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
      session.orderBuilder = {
        type: 'desechable',
        products: {},
        extras: {},
        clientData: { name: null, date: null, location: null }
      };
    }

    const cartCount = Object.keys(session.orderBuilder.products).length;

    // "seguimos"/"listo" puro: NO llamar NLU (la IA a veces relee el carrito del
    // mensaje anterior y lo vuelve a sumar → 2+2=4). Vacío → pedir sabores; con ítems → datos.
    if (isOnlyAdvanceProductsOrder(messageText)) {
      if (cartCount === 0) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
          customReply: `Aún no tienes cócteles en el pedido 😊
Dime un sabor y cantidad (ej. *1 mojito*), o escribe *lista* para ver la carta de precios.`
        };
      }
      return { success: true, nextState: nextStateAfterProducts(session) };
    }

    // "lista" / precios con carrito vacío → reenviar la carta (sin empujar *seguimos* aún)
    const wantsFullCatalog = /\b(si|sí|claro|ok|okay|dale|mu[eé]strame|precio|precios|valor|valores|por favor|porfa|todos|todas|todo|lista|cat[áa]logo|menu|opciones|cuales|cu[aá]les|ver)\b/i.test(messageText);
    if (wantsFullCatalog && cartCount === 0) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReplies: [
          img('barril_desechable_precios.webp'),
          `¿Qué sabor y cuántos? (ej. *2 mojitos y 1 aperol*)`
        ]
      };
    }

    const eliminationMatch = parseElimination(messageText, session.orderBuilder.products, Object.keys(preciosData.cocteles || {}));
    if (eliminationMatch) {
      const { name, newQty } = eliminationMatch;
      if (newQty > 0) session.orderBuilder.products[name] = newQty;
      else delete session.orderBuilder.products[name];

      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: `✅ Eliminado. Ahora tu pedido incluye:

${formatCartLines(session.orderBuilder.products)}

¿Agregas otro, quitas alguno, o *seguimos*? 🍸`
      };
    }

    const catalogNames = Object.keys(preciosData.cocteles || {});
    let lastBotMessage = '';
    if (session.history?.turns?.length > 0) {
      const botTurns = session.history.turns.filter((t) => t.role === 'model');
      if (botTurns.length > 0) lastBotMessage = botTurns[botTurns.length - 1].text;
    }

    let { productos: extractedList, dudas, quiere_avanzar } = await extractProductsWithAI(messageText, catalogNames, lastBotMessage);
    const wantsAdvance = quiere_avanzar || wantsAdvanceProductsOrder(messageText);

    // "seguimos" solo (o NLU dice avanzar) con carrito ya lleno → siguiente paso
    if (wantsAdvance && Object.keys(session.orderBuilder.products).length > 0 && (!extractedList || extractedList.length === 0)) {
      return { success: true, nextState: nextStateAfterProducts(session) };
    }

    if (dudas?.length > 0) {
      const { resolved, remaining } = resolveDoubtsProgrammatically(dudas);
      if (resolved.length > 0) {
        for (const item of resolved) {
          if (!extractedList.find((p) => p.name === item.name)) extractedList.push(item);
        }
      }
      dudas = remaining;
    }

    if (dudas?.length > 0) dudas = dudas.filter((d) => d?.opciones?.length > 1);
    if (dudas?.length > 0) {
      const todasLasOpcionesDudosas = dudas.flatMap((d) => d.opciones);
      extractedList = extractedList.filter((p) => !todasLasOpcionesDudosas.includes(p.name));
    }

    const parsedProducts = {};
    for (const item of extractedList) {
      if (!item.name || !item.quantity) continue;
      const matchedName = findClosestCatalogMatch(item.name, catalogNames);
      if (matchedName) parsedProducts[matchedName] = (parsedProducts[matchedName] || 0) + item.quantity;
    }

    if (dudas?.length > 0) {
      const duda = dudas[0];
      if (Object.keys(parsedProducts).length > 0) {
        for (const [pName, pQty] of Object.entries(parsedProducts)) {
          session.orderBuilder.products[pName] = (session.orderBuilder.products[pName] || 0) + pQty;
        }
      }
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones)
      };
    }

    if (Object.keys(parsedProducts).length > 0) {
      // La IA a veces relee el carrito del mensaje anterior al decir "seguimos"/avanzar.
      // Si lo extraído es un eco exacto del carrito, no sumamos otra vez.
      const isCartEcho = Object.keys(parsedProducts).length === Object.keys(session.orderBuilder.products).length
        && Object.entries(parsedProducts).every(([name, qty]) => session.orderBuilder.products[name] === qty);

      if (wantsAdvance && isCartEcho) {
        return { success: true, nextState: nextStateAfterProducts(session) };
      }

      for (const [pName, pQty] of Object.entries(parsedProducts)) {
        session.orderBuilder.products[pName] = (session.orderBuilder.products[pName] || 0) + pQty;
      }

      // "2 mojitos y 1 aperol seguimos" → agrega al carrito y avanza (no re-pregunta vacío)
      if (wantsAdvance) {
        return { success: true, nextState: nextStateAfterProducts(session) };
      }

      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: buildCartConfirmReply(session.orderBuilder.products)
      };
    }

    if ((isOnlyBrowsing(messageText) || wantsInstagramOrSocial(messageText))
        && Object.keys(session.orderBuilder.products).length === 0) {
      return { success: true, nextState: 'CERRADO', customReply: getBrowseOnlyGoodbye(), mute: true };
    }

    return { success: false };
  }
});
