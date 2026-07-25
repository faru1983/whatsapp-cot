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
  resolveDoubtsProgrammatically,
  interceptBotOptionsAnswer,
  parseEventElimination,
  isEventMenuCorrection
} from '../../../logic/utils.js';
import { wantsAdvanceProductsOrder, isOnlyAdvanceProductsOrder, asksPriceOrCatalog } from '../../../logic/interruptions.js';
import { extractEventProductsWithAI } from '../../../core/llm.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import {
  getEventFormatKey,
  getMinLitersForFormat,
  getAllowedLitrages,
  ensureEventOrderBuilder,
  formatEventCartSummary,
  getEventPriceListImage,
  asksEventCartPriceQuestion,
  parseLitrageOnlyMessage,
  parseCocktailNamesWithoutLitrage,
  validateEventProductLines
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';

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
    return withAssistantFooter(`Si está bien, escribe *ok* para el resumen.
_(Si quieres cambiar, dime qué agregar o quitar.)_`);
  }
  return withAssistantFooter(ASK_COCKTAILS);
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
    const cartHasItems = !cartEmpty;
    const wantsPriceList = /precio|precios|cu[aá]nto|cuanto|valor|cat[aá]logo|lista|menu|men[uú]/i.test(messageText);

    // Duda de precio con carrito (no re-parsear cócteles ni error de litraje)
    if (cartHasItems && (asksEventCartPriceQuestion(messageText)
        || (asksPriceOrCatalog(messageText) && !hasDrinkSelection(messageText)))) {
      const orderBuilder = new OrderBuilder(formatKey, preciosData);
      orderBuilder.products = session.orderBuilder.products;
      const quote = orderBuilder.calculateQuote();
      const totalLiters = orderBuilder.getTotalLiters();
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: `Los precios de la carta son por *cóctel y litraje* en ${session.eventoFormato} (*${allowedLitrages.join(', ')}*).

Tu pedido actual:
${formatEventCartSummary(session.orderBuilder.products, formatKey)}

*Subtotal:* ${formatPrice(quote.subtotal)} | *Litros:* ${totalLiters}L

Si en la imagen viste otro valor, suele ser otro tamaño de barril o formato. ¿Quieres cambiar algo o seguimos con *ok*? 🍸`
      };
    }

    // Respuesta solo litraje tras pedir sabores (ej. "10L" después de "Monito aperol")
    const litrageOnly = parseLitrageOnlyMessage(messageText);
    const pendingNames = Array.isArray(session.pendingEventCocktails) ? session.pendingEventCocktails : [];
    if (litrageOnly && pendingNames.length > 0) {
      if (!allowedLitrages.includes(litrageOnly)) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Para ${session.eventoFormato} los tamaños válidos son: *${allowedLitrages.join(', ')}*.\n\n¿Me indicas de nuevo con un litraje compatible? (ej: *Mojito 10L*)`
        };
      }
      const pendingItems = pendingNames.map((name) => ({ name, quantity: 1, litrage: litrageOnly }));
      const { parsedProducts, invalidLitrages } = validateEventProductLines(
        messageText, pendingItems, formatKey, allowedLitrages, formatKey === 'muro' ? '10L' : '5L', catalogNames
      );
      if (parsedProducts.length > 0) {
        session.pendingEventCocktails = null;
        applyProductsToCart(session, parsedProducts, false);
        const orderBuilder = new OrderBuilder(formatKey, preciosData);
        orderBuilder.products = session.orderBuilder.products;
        const quote = orderBuilder.calculateQuote();
        const totalLiters = orderBuilder.getTotalLiters();
        let reply = `🍹 Listo, anoté con *${litrageOnly}*:\n\n`;
        reply += formatEventCartSummary(session.orderBuilder.products, formatKey);
        reply += `\n*Subtotal:* ${formatPrice(quote.subtotal)} | *Litros:* ${totalLiters}L (mín. ${minLiters}L)\n`;
        reply += totalLiters >= minLiters ? `\n${ASK_OK_AFTER_CART} 🍸` : `\nAún faltan litros para el mínimo (*${minLiters}L*). ¿Qué más agregamos? 🍸`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }
      if (invalidLitrages.length > 0) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Ese litraje no está disponible para ${session.eventoFormato}. Válidos: *${allowedLitrages.join(', ')}*.`
        };
      }
    }

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

    // Rama: agregar / confirmar con NLU de eventos (o parser programático de sabores)
    let extractedList = [];
    let dudas = [];
    let quiere_avanzar = false;
    const defaultLitrage = formatKey === 'muro' ? '10L' : '5L';

    const programmaticNames = parseCocktailNamesWithoutLitrage(messageText, catalogNames);
    const interceptedOption = interceptBotOptionsAnswer(messageText, lastBotMessage);

    if (programmaticNames.length > 0 && !litrageOnly && !interceptedOption) {
      extractedList = programmaticNames.map((name) => ({ name, quantity: 1, litrage: defaultLitrage }));
    } else if (interceptedOption) {
      extractedList.push({ ...interceptedOption, litrage: defaultLitrage });
    } else {
      const result = await extractEventProductsWithAI(messageText, catalogNames, formatKey, lastBotMessage);
      extractedList = result.productos;
      dudas = result.dudas;
      quiere_avanzar = result.quiere_avanzar;
    }

    const cartHasItemsAfter = Object.keys(session.orderBuilder.products).length > 0;
    const wantsAdvance = quiere_avanzar || wantsAdvanceProductsOrder(messageText);
    const hasExtracted = Array.isArray(extractedList) && extractedList.length > 0;
    const tempBuilder = new OrderBuilder(formatKey, preciosData);
    tempBuilder.products = session.orderBuilder.products;
    const currentLiters = tempBuilder.getTotalLiters();

    // Quiere avanzar pero no hay carrito ni productos en este mensaje → pedir sabores
    if (wantsAdvance && !cartHasItemsAfter && !hasExtracted) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: `Aún no hay cócteles en el pedido 😊
Dime sabor y litros (ej. *10L de mojito*), o escribe *lista* para ver precios.`
      };
    }

    // Avanzar solo con lo que ya está en el carrito (sin productos nuevos en este mensaje)
    if (wantsAdvance && cartHasItemsAfter && !hasExtracted) {
      if (currentLiters < minLiters) {
        const reply = `Tu pedido suma *${currentLiters}L* y el mínimo para ${session.eventoFormato} es *${minLiters}L*.\n\n${formatEventCartSummary(session.orderBuilder.products, formatKey)}\n¿Qué cóctel o litraje agregamos para llegar al mínimo? 🍸`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }
      return { success: true, nextState: 'EVENTOS_COTIZACION' };
    }

    // Intentar resolver dudas sin preguntar (ej. "piscola alto" → una sola opción clara)
    if (dudas?.length > 0) {
      const { resolved, remaining } = resolveDoubtsProgrammatically(dudas, lastBotMessage);
      if (resolved.length > 0) {
        for (const item of resolved) {
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

    const { parsedProducts, invalidLitrages } = validateEventProductLines(
      messageText, extractedList, formatKey, allowedLitrages, defaultLitrage, catalogNames
    );

    const isCorrection = isEventMenuCorrection(messageText);

    if (dudas?.length > 0) {
      applyProductsToCart(session, parsedProducts, isCorrection);
      const duda = dudas[0];
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones) };
    }

    if (parsedProducts.length > 0) {
      session.pendingEventCocktails = null;
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

    // Solo litrajes inválidos (sin productos válidos) → guardar pendientes y guiar
    if (invalidLitrages.length > 0) {
      const pending = [...new Set(invalidLitrages.map((i) => i.name))];
      session.pendingEventCocktails = pending;

      let reply = `Para *${session.eventoFormato}* los barriles son: *${allowedLitrages.join(', ')}*`;
      if (formatKey === 'muro') reply += ` (no hay 5L)`;
      reply += `.\n\nAnoté: *${pending.join('*, *')}*.`;
      reply += `\n¿Con qué litraje los quieres? Puedes decir *10L* para todos, o por ejemplo: _"Mojito 10L y Aperol Spritz 10L"_`;
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    return { success: false };
  }
});
