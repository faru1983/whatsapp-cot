// ==============================================================================
// OBJETIVO: Paso EVENTOS_ELECCION_MENU — NLU + carrito estructurado.
// Extraemos productos con IA, guardamos en orderBuilder y avanzamos cuando
// el carrito cumple el mínimo de litros del formato elegido.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getDoubtClarificationTemplate } from '../../../views/templates.js';
import {
  hasDrinkSelection,
  formatPrice,
  preciosData,
  findClosestCatalogMatch,
  resolveDoubtsProgrammatically,
  parseEventElimination,
  isEventMenuCorrection,
  fixEventLitrageShorthand
} from '../../../logic/utils.js';
import { wantsAdvanceProductsOrder, isOnlyAdvanceProductsOrder } from '../../../logic/interruptions.js';
import { extractEventProductsWithAI } from '../../../core/llm.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import {
  getEventFormatKey,
  getMinLitersForFormat,
  getAllowedLitrages,
  ensureEventOrderBuilder,
  formatEventCartSummary,
  getEventPriceListImage
} from '../../../logic/eventos-helpers.js';

const ASK_COCKTAILS = `¿Qué cócteles te gustaría incluir en tu evento? (ej: "Mojito 10L y 1 Aperol 5L")`;
const ASK_OK_AFTER_CART = `Si está bien así, escribe *ok* para ver el resumen de tu cotización.
_(Si quieres cambiar, dime qué agregar o quitar)_`;

const AI_PROMPT = `[SISTEMA - ESTADO: PREGUNTAS SOBRE EL MENÚ O LOGÍSTICA DE EVENTOS]
El cliente está revisando la recomendación para su evento pero tiene dudas en lugar de elegir los cócteles.
1. Responde su duda de forma breve y amigable.
2. REGLA DE LOGÍSTICA: La instalación y logística de eventos la coordina el equipo, y para el Dispensador es gratis, y para el Muro cuesta $50.000. NUNCA inventes tarifas de envío adicionales.
3. NUNCA cotices ni calcules precios finales todavía.
4. Si aún no eligió cócteles: pide sabor + litraje. Solo si ya tiene pedido, sugiere escribir *ok* para el resumen.`;

/**
 * shortQuestionForSession: Sin carrito → pedir cócteles; con carrito → guiar con *ok*.
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  const hasCart = session.orderBuilder?.products
    && Object.keys(session.orderBuilder.products).length > 0;
  if (hasCart) {
    return `Si está bien, escribe *ok* para el resumen.
    _(Si quieres cambiar, dime qué agregar o quitar.)_`;
  }
  return ASK_COCKTAILS;
}

/**
 * applyProductsToCart: Suma productos al carrito, o reemplaza líneas del mismo
 * cóctel si el cliente está corrigiendo ("me equivoqué, son 10L no 10x").
 *
 * @param {object} session - Sesión del cliente
 * @param {Array<{name: string, quantity: number, litrage: string}>} products
 * @param {boolean} replaceSameName - true = borrar otras líneas de ese nombre primero
 */
function applyProductsToCart(session, products, replaceSameName) {
  if (replaceSameName) {
    const namesToReplace = new Set(products.map((p) => p.name));
    for (const key of Object.keys(session.orderBuilder.products)) {
      const entry = session.orderBuilder.products[key];
      if (entry?.name && namesToReplace.has(entry.name)) {
        delete session.orderBuilder.products[key];
      }
    }
  }
  for (const p of products) {
    const key = OrderBuilder.productLineKey(p.name, p.litrage);
    const prev = replaceSameName ? null : session.orderBuilder.products[key];
    session.orderBuilder.products[key] = {
      name: p.name,
      litrage: p.litrage,
      quantity: (prev?.quantity || 0) + p.quantity
    };
  }
}

export const EVENTOS_ELECCION_MENU = defineState({
  id: 'EVENTOS_ELECCION_MENU',
  promptQuestion: () => ASK_COCKTAILS,
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const formatKey = getEventFormatKey(session.eventoFormato);
    const minLiters = getMinLitersForFormat(formatKey);
    const allowedLitrages = getAllowedLitrages(formatKey);
    ensureEventOrderBuilder(session, formatKey);

    const catalogNames = Object.keys(preciosData.cocteles || {});
    const cartEmpty = Object.keys(session.orderBuilder.products).length === 0;
    const wantsPriceList = /precio|precios|cu[aá]nto|cuanto|valor|cat[aá]logo|lista|menu|men[uú]/i.test(messageText);

    // Pide lista/precios sin nombrar cócteles → imagen de la carta del formato actual
    if (wantsPriceList && !hasDrinkSelection(messageText) && cartEmpty) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          getEventPriceListImage(formatKey),
          ASK_COCKTAILS
        ]
      };
    }

    // Rama: eliminar productos ("quita el mojito 10L")
    const eliminationMatch = parseEventElimination(messageText, session.orderBuilder.products);
    if (eliminationMatch) {
      const { key, newQty, name, litrage } = eliminationMatch;
      if (newQty > 0) {
        session.orderBuilder.products[key].quantity = newQty;
      } else {
        delete session.orderBuilder.products[key];
      }

      const orderBuilder = new OrderBuilder(formatKey, preciosData);
      orderBuilder.products = session.orderBuilder.products;
      const quote = orderBuilder.calculateQuote();
      const totalLiters = orderBuilder.getTotalLiters();

      let reply = `✅ Eliminado ${name} (${litrage}). Ahora tu pedido incluye:\n\n`;
      reply += formatEventCartSummary(session.orderBuilder.products, formatKey) || '_Vacío_\n';
      reply += `\n*Subtotal:* ${formatPrice(quote.subtotal)} | *Litros:* ${totalLiters}L (mín. ${minLiters}L)\n\n`;
      if (Object.keys(session.orderBuilder.products).length === 0) {
        reply += ASK_COCKTAILS;
      } else if (totalLiters >= minLiters) {
        reply += `¿Quieres eliminar otro o agregar más? Si está listo, escribe *ok*. 🍸`;
      } else {
        reply += `Aún faltan litros para el mínimo (*${minLiters}L*). ¿Qué más agregamos? 🍸`;
      }
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    // "seguimos" puro con carrito: avanzar sin NLU (evita que la IA re-sume el pedido)
    if (isOnlyAdvanceProductsOrder(messageText)) {
      const cartHasItems = Object.keys(session.orderBuilder.products).length > 0;
      if (!cartHasItems) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Aún no hay cócteles en el pedido 😊
Dime sabor y litros (ej. *10L de mojito*), o escribe *lista* para ver precios.`
        };
      }
      const earlyBuilder = new OrderBuilder(formatKey, preciosData);
      earlyBuilder.products = session.orderBuilder.products;
      const earlyLiters = earlyBuilder.getTotalLiters();
      if (earlyLiters < minLiters) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Tu pedido suma *${earlyLiters}L* y el mínimo para ${session.eventoFormato} es *${minLiters}L*.\n\n${formatEventCartSummary(session.orderBuilder.products, formatKey)}\n¿Qué cóctel o litraje agregamos para llegar al mínimo? 🍸`
        };
      }
      return { success: true, nextState: 'EVENTOS_COTIZACION' };
    }

    // Último mensaje del bot da contexto a la IA (ej. si el cliente elige una marca)
    let lastBotMessage = '';
    if (session.history?.turns?.length > 0) {
      const botTurns = session.history.turns.filter(t => t.role === 'model');
      if (botTurns.length > 0) lastBotMessage = botTurns[botTurns.length - 1].text;
    }

    // Rama: agregar / confirmar con NLU de eventos
    let { productos: extractedList, dudas, quiere_avanzar } = await extractEventProductsWithAI(
      messageText,
      catalogNames,
      formatKey,
      lastBotMessage
    );

    const cartHasItems = Object.keys(session.orderBuilder.products).length > 0;
    const wantsAdvance = quiere_avanzar || wantsAdvanceProductsOrder(messageText);
    const hasExtracted = Array.isArray(extractedList) && extractedList.length > 0;
    const tempBuilder = new OrderBuilder(formatKey, preciosData);
    tempBuilder.products = session.orderBuilder.products;
    const currentLiters = tempBuilder.getTotalLiters();

    // Quiere avanzar pero no hay carrito ni productos en este mensaje → pedir sabores
    if (wantsAdvance && !cartHasItems && !hasExtracted) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: `Aún no hay cócteles en el pedido 😊
Dime sabor y litros (ej. *10L de mojito*), o escribe *lista* para ver precios.`
      };
    }

    // Avanzar solo con lo que ya está en el carrito (sin productos nuevos en este mensaje)
    if (wantsAdvance && cartHasItems && !hasExtracted) {
      if (currentLiters < minLiters) {
        const reply = `Tu pedido suma *${currentLiters}L* y el mínimo para ${session.eventoFormato} es *${minLiters}L*.\n\n${formatEventCartSummary(session.orderBuilder.products, formatKey)}\n¿Qué cóctel o litraje agregamos para llegar al mínimo? 🍸`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }
      return { success: true, nextState: 'EVENTOS_COTIZACION' };
    }

    // Intentar resolver dudas sin preguntar (ej. "piscola alto" → una sola opción clara)
    if (dudas?.length > 0) {
      const { resolved, remaining } = resolveDoubtsProgrammatically(dudas);
      if (resolved.length > 0) {
        for (const item of resolved) {
          const defaultLitrage = formatKey === 'muro' ? '10L' : '5L';
          if (!extractedList.find(p => p.name === item.name)) {
            extractedList.push({ name: item.name, quantity: item.quantity || 1, litrage: defaultLitrage });
          }
        }
      }
      dudas = remaining;
    }

    // Solo mantener dudas con 2+ opciones; una sola opción no es duda real
    if (dudas?.length > 0) dudas = dudas.filter(d => d?.opciones?.length > 1);
    if (dudas?.length > 0) {
      const todasLasOpcionesDudosas = dudas.flatMap(d => d.opciones);
      extractedList = extractedList.filter(p => !todasLasOpcionesDudosas.includes(p.name));
    }

    // Mapear nombres de la IA al catálogo oficial y validar litraje
    const defaultLitrage = formatKey === 'muro' ? '10L' : '5L';
    const parsedProducts = [];
    const invalidLitrages = [];
    for (const item of extractedList) {
      if (!item.name || !item.quantity) continue;
      const matchedName = findClosestCatalogMatch(item.name, catalogNames);
      if (!matchedName) continue;

      const fixed = fixEventLitrageShorthand(
        messageText,
        { name: matchedName, quantity: item.quantity, litrage: item.litrage || defaultLitrage },
        allowedLitrages,
        defaultLitrage
      );
      const litrage = fixed.litrage;
      const quantity = fixed.quantity;

      if (!allowedLitrages.includes(litrage)) {
        invalidLitrages.push({ name: matchedName, litrage });
        continue;
      }

      const price = preciosData.cocteles[matchedName]?.[formatKey]?.[litrage];
      if (price == null) {
        invalidLitrages.push({ name: matchedName, litrage });
        continue;
      }

      parsedProducts.push({ name: matchedName, quantity, litrage });
    }

    const isCorrection = isEventMenuCorrection(messageText);

    if (dudas?.length > 0) {
      applyProductsToCart(session, parsedProducts, isCorrection);
      const duda = dudas[0];
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones) };
    }

    if (parsedProducts.length > 0) {
      applyProductsToCart(session, parsedProducts, isCorrection);

      const orderBuilder = new OrderBuilder(formatKey, preciosData);
      orderBuilder.products = session.orderBuilder.products;
      const quote = orderBuilder.calculateQuote();
      const totalLiters = orderBuilder.getTotalLiters();

      // "10L mojito seguimos" → si cumple mínimo, cotiza; si no, pide más litros
      if (wantsAdvance && totalLiters >= minLiters && invalidLitrages.length === 0) {
        return { success: true, nextState: 'EVENTOS_COTIZACION' };
      }

      let reply = isCorrection
        ? `✅ Corregido. Tu pedido quedó así:\n\n`
        : `🍹 Te confirmo los cócteles seleccionados:\n\n`;
      reply += formatEventCartSummary(session.orderBuilder.products, formatKey);
      reply += `\n*Subtotal:* ${formatPrice(quote.subtotal)} | *Litros:* ${totalLiters}L (mín. ${minLiters}L)\n`;

      if (invalidLitrages.length > 0) {
        reply += `\n⚠️ No pude agregar:\n`;
        for (const inv of invalidLitrages) {
          reply += `- ${inv.name} (${inv.litrage}): litraje no disponible en ${session.eventoFormato}. Válidos: ${allowedLitrages.join(', ')}.\n`;
        }
      }

      if (totalLiters >= minLiters) {
        reply += `\n${ASK_OK_AFTER_CART} 🍸`;
      } else {
        reply += `\nAún faltan litros para el mínimo (*${minLiters}L*). ¿Qué más agregamos? 🍸`;
      }

      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    // Solo litrajes inválidos (sin productos válidos)
    if (invalidLitrages.length > 0) {
      let reply = `Ese litraje no está disponible para ${session.eventoFormato}.\n`;
      reply += `Los barriles compatibles son: *${allowedLitrages.join(', ')}*.\n\n`;
      reply += `¿Me indiques de nuevo el cóctel con un litraje válido? (ej: "Mojito 10L")`;
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    return { success: false };
  }
});
