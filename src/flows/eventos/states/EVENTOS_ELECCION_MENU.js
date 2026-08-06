// ==============================================================================
// OBJETIVO: Paso EVENTOS_ELECCION_MENU — NLU + carrito estructurado.
// Extraemos productos con IA, guardamos en orderBuilder y avanzamos cuando
// el carrito cumple el mínimo de litros del formato elegido.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getDoubtClarificationTemplate, getFlavorListReply } from '../../../views/templates.js';
import {
  hasDrinkSelection,
  preciosData,
  resolveDoubtsProgrammatically,
  interceptBotOptionsAnswer,
  parseEventElimination,
  isEventMenuCorrection,
  isBareEventEliminationRequest,
  hasEventEliminationIntent,
  hasExplicitEventAddIntent,
  detectFlavorListRequest,
  asksCocktailFlavorList,
  getProductFamilyBase,
  getCatalogFamilyFlavorOptions
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
  formatEventCartTotalsLine,
  getEventPriceListImage,
  asksEventCartPriceQuestion,
  parseLitrageOnlyMessage,
  parseCocktailNamesWithoutLitrage,
  parseEventProductsProgrammatic,
  parseBareQuantityWithoutUnit,
  validateEventProductLines,
  ASK_EVENT_COCKTAILS,
  asksDeliveryOrDispatchQuestion,
  REPLY_DISPATCH_SIDEBAR,
  stripDeliveryQuestionForCart
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';
import { matchesMenuOption } from '../../../logic/keyword-intent.js';

const ASK_COCKTAILS = ASK_EVENT_COCKTAILS;
const ASK_OK_AFTER_CART = `*¿Todo bien con el pedido?*
_(ej: escribe *ok* para el resumen, o "20L Mojito" / *quita el aperol*)_`;

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
    return withAssistantFooter(ASK_OK_AFTER_CART);
  }
  return withAssistantFooter(ASK_COCKTAILS);
}

/**
 * askWhatToRemoveReply: El cliente dijo "quitar" sin decir qué.
 * Listamos el pedido en litros y pedimos el cóctel concreto.
 *
 * @param {object} session
 * @param {string} formatKey
 * @returns {string}
 */
function askWhatToRemoveReply(session, formatKey) {
  const cart = formatEventCartSummary(session.orderBuilder.products, formatKey) || '_Vacío_\n';
  return `Claro 😊

${cart}
*¿Qué quieres quitar de tu pedido?*
_(ej: quita el aperol o quita el mojito)_

_(si quieres cambiar cantidad: 20L Mojito y 10L Aperol)_`;
}

/**
 * namesAlreadyInCart: Nombres de cóctel que ya están en el carrito.
 *
 * @param {object} products - session.orderBuilder.products
 * @returns {Set<string>}
 */
function namesAlreadyInCart(products) {
  const names = new Set();
  for (const entry of Object.values(products || {})) {
    if (entry?.name) names.add(entry.name);
  }
  return names;
}

/**
 * applyProductsToCart: Suma productos al carrito, o reemplaza líneas del mismo
 * cóctel cuando el cliente corrige el total en litros ("20L Mojito" = dejar en 20L,
 * no sumar otros 20L encima). Solo suma si dice "agrega"/"también" o el cóctel es nuevo.
 *
 * @param {object} session - Sesión del cliente
 * @param {Array<{name: string, quantity: number, litrage: string}>} products
 * @param {{ forceReplace?: boolean, messageText?: string }} [opts]
 */
function applyProductsToCart(session, products, opts = {}) {
  const forceReplace = Boolean(opts.forceReplace);
  const messageText = opts.messageText || '';
  const explicitAdd = hasExplicitEventAddIntent(messageText);
  const inCart = namesAlreadyInCart(session.orderBuilder.products);

  // Por cada cóctel del mensaje: si ya estaba y no dijo "agrega", borramos sus líneas
  // (el cliente habla en litros totales; nosotros rearmamos los barriles).
  const namesInMessage = new Set(products.map((p) => p.name).filter(Boolean));
  for (const name of namesInMessage) {
    const shouldReplace = forceReplace || (!explicitAdd && inCart.has(name));
    if (!shouldReplace) continue;
    for (const key of Object.keys(session.orderBuilder.products)) {
      const entry = session.orderBuilder.products[key];
      if (entry?.name === name) delete session.orderBuilder.products[key];
    }
  }

  for (const p of products) {
    const key = OrderBuilder.productLineKey(p.name, p.litrage);
    const shouldReplace = forceReplace || (!explicitAdd && inCart.has(p.name));
    const prev = shouldReplace ? null : session.orderBuilder.products[key];
    session.orderBuilder.products[key] = {
      name: p.name,
      litrage: p.litrage,
      quantity: (prev?.quantity || 0) + p.quantity
    };
  }
}

/**
 * buildCartReply: Arma el mensaje de carrito (lista + subtotal + qué sigue).
 * Lo comparten todas las ramas que agregan cócteles, para no repetir el formato.
 *
 * @param {object} params
 * @param {object} params.session - Sesión del cliente
 * @param {string} params.formatKey - 'dispensador' | 'muro'
 * @param {number} params.minLiters - Mínimo de litros del formato
 * @param {string} params.header - Primera línea (confirmación o corrección)
 * @param {Array<{name: string, litrage: string}>} [params.invalidLitrages] - Líneas que no se pudieron agregar
 * @param {string[]} [params.allowedLitrages] - Tamaños válidos, para explicar los rechazos
 * @returns {{ reply: string, totalLiters: number }}
 */
function buildCartReply({ session, formatKey, minLiters, header, invalidLitrages = [], allowedLitrages = [] }) {
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  orderBuilder.products = session.orderBuilder.products;
  const quote = orderBuilder.calculateQuote();
  const totalLiters = orderBuilder.getTotalLiters();

  let reply = `${header}\n\n`;
  reply += formatEventCartSummary(session.orderBuilder.products, formatKey);
  reply += `\n${formatEventCartTotalsLine(quote, { minLiters })}\n`;

  if (invalidLitrages.length > 0) {
    reply += `\n⚠️ No pude agregar:\n`;
    for (const inv of invalidLitrages) {
      reply += `- ${inv.name} (${inv.litrage}): litraje no disponible en ${session.eventoFormato}. Válidos: ${allowedLitrages.join(', ')}.\n`;
    }
  }

  reply += totalLiters >= minLiters
    ? `\n${ASK_OK_AFTER_CART} 🍸`
    : `\nAún faltan litros para el mínimo (*${minLiters}L*). ¿Qué más agregamos? 🍸`;

  return { reply, totalLiters };
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
    const defaultLitrage = formatKey === 'muro' ? '10L' : '5L';

    // Respuesta al menú "¿son N barriles?" que hicimos en el turno anterior
    const pendingBarrels = session.pendingBarrelQuantity;
    if (pendingBarrels) {
      const trimmed = String(messageText || '').trim();
      session.pendingBarrelQuantity = null;

      // 1️⃣ Sí, son N barriles del tamaño por defecto
      if (matchesMenuOption(trimmed, 1)) {
        const items = pendingBarrels.names.map((name) => ({
          name,
          quantity: pendingBarrels.quantity,
          litrage: pendingBarrels.litrage
        }));
        // Mensaje sintético con la unidad explícita: así no se reinterpreta como litraje
        const { parsedProducts } = validateEventProductLines(
          `${pendingBarrels.quantity} barriles`, items, formatKey, allowedLitrages, pendingBarrels.litrage, catalogNames
        );
        if (parsedProducts.length > 0) {
          applyProductsToCart(session, parsedProducts, { messageText: `${pendingBarrels.quantity} barriles` });
          const { reply } = buildCartReply({
            session, formatKey, minLiters, header: `🍹 Listo, lo anoté así:`
          });
          return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
        }
      }

      // 2️⃣ Prefiere indicar otro tamaño → quedan pendientes esos sabores
      if (matchesMenuOption(trimmed, 2)) {
        session.pendingEventCocktails = pendingBarrels.names;
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Perfecto. Para *${pendingBarrels.names.join('*, *')}*:

*¿Qué tamaño de barril quieres?*
_(ej: ${allowedLitrages[0]} — disponibles: ${allowedLitrages.join(', ')})_`
        };
      }
      // Si contestó otra cosa, seguimos el flujo normal con ese mensaje
    }

    const cartEmpty = Object.keys(session.orderBuilder.products).length === 0;
    const cartHasItems = !cartEmpty;
    const wantsPriceList = /precio|precios|cu[aá]nto|cuanto|valor|cat[aá]logo|lista|menu|men[uú]/i.test(messageText);

    // Duda de precio con carrito (no re-parsear cócteles ni error de litraje)
    if (cartHasItems && (asksEventCartPriceQuestion(messageText)
        || (asksPriceOrCatalog(messageText) && !hasDrinkSelection(messageText)))) {
      const orderBuilder = new OrderBuilder(formatKey, preciosData);
      orderBuilder.products = session.orderBuilder.products;
      const quote = orderBuilder.calculateQuote();
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: `Los precios de la carta son por *cóctel y litraje* en ${session.eventoFormato} (*${allowedLitrages.join(', ')}*).

Tu pedido actual:
${formatEventCartSummary(session.orderBuilder.products, formatKey)}

${formatEventCartTotalsLine(quote)}

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
          customReply: `Para ${session.eventoFormato} los tamaños válidos son: *${allowedLitrages.join(', ')}*.

*¿Me indicas de nuevo con un litraje compatible?*
_(ej: Mojito ${allowedLitrages[0]})_`
        };
      }
      const pendingItems = pendingNames.map((name) => ({ name, quantity: 1, litrage: litrageOnly }));
      const { parsedProducts, invalidLitrages } = validateEventProductLines(
        messageText, pendingItems, formatKey, allowedLitrages, defaultLitrage, catalogNames
      );
      if (parsedProducts.length > 0) {
        session.pendingEventCocktails = null;
        applyProductsToCart(session, parsedProducts, { messageText });
        const { reply } = buildCartReply({
          session, formatKey, minLiters, header: `🍹 Listo, anoté con *${litrageOnly}*:`
        });
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

    // Rama: eliminar productos ("quita el aperol") — NUNCA caer al flujo de agregar
    if (cartHasItems && isBareEventEliminationRequest(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: askWhatToRemoveReply(session, formatKey)
      };
    }

    const eliminationMatch = parseEventElimination(messageText, session.orderBuilder.products);
    if (eliminationMatch?.notInCart) {
      const cart = formatEventCartSummary(session.orderBuilder.products, formatKey) || '_Vacío_\n';
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: `No tienes *${eliminationMatch.requestedName}* en el pedido ahora 😊

Tu pedido actual:
${cart}
*¿Qué quieres quitar o agregar?*
_(ej: quita el mojito o 5L Aperol)_`
      };
    }

    if (eliminationMatch) {
      const keys = Array.isArray(eliminationMatch.keys) && eliminationMatch.keys.length
        ? eliminationMatch.keys
        : [eliminationMatch.key];
      const { newQty, name, litrage } = eliminationMatch;

      for (const key of keys) {
        if (!key || !session.orderBuilder.products[key]) continue;
        // Solo bajamos cantidad en la primera línea si pidió "quita 1 …"
        if (newQty > 0 && key === eliminationMatch.key) {
          session.orderBuilder.products[key].quantity = newQty;
        } else {
          delete session.orderBuilder.products[key];
        }
      }

      const orderBuilder = new OrderBuilder(formatKey, preciosData);
      orderBuilder.products = session.orderBuilder.products;
      const quote = orderBuilder.calculateQuote();
      const totalLiters = orderBuilder.getTotalLiters();

      let reply = `✅ Quité *${name}*`;
      if (litrage && newQty <= 0) reply += ` (${litrage})`;
      reply += `. Ahora tu pedido incluye:\n\n`;
      reply += formatEventCartSummary(session.orderBuilder.products, formatKey) || '_Vacío_\n';
      reply += `\n${formatEventCartTotalsLine(quote, { minLiters })}\n\n`;
      if (Object.keys(session.orderBuilder.products).length === 0) {
        reply += ASK_COCKTAILS;
      } else if (totalLiters >= minLiters) {
        reply += `*¿Quieres eliminar otro o agregar más?*
_(ej: escribe *ok* si está listo)_ 🍸`;
      } else {
        reply += `Aún faltan litros para el mínimo (*${minLiters}L*).

*¿Qué más agregamos?*
_(ej: 5L Mojito)_ 🍸`;
      }
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    // Dijo "quitar/elimina…" pero no resolvimos el cóctel → preguntar (no agregar)
    if (cartHasItems && hasEventEliminationIntent(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: askWhatToRemoveReply(session, formatKey)
      };
    }

    // "qué mojito sabor tienes?" → listar variantes del catálogo sin tocar el carrito
    const flavorAsk = detectFlavorListRequest(messageText, catalogNames);
    if (flavorAsk) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: getFlavorListReply(flavorAsk.family, flavorAsk.opciones, { withLitersHint: true })
      };
    }

    // "seguimos" puro con carrito: avanzar sin NLU (evita que la IA re-sume el pedido)
    if (isOnlyAdvanceProductsOrder(messageText)) {
      const cartHasItems = Object.keys(session.orderBuilder.products).length > 0;
      if (!cartHasItems) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Aún no hay cócteles en el pedido 😊

*¿Qué cócteles te gustaría incluir?*
_(ej: 5L de mojito)_

_(o escribe *lista* para ver precios)_`
        };
      }
      const earlyBuilder = new OrderBuilder(formatKey, preciosData);
      earlyBuilder.products = session.orderBuilder.products;
      const earlyLiters = earlyBuilder.getTotalLiters();
      if (earlyLiters < minLiters) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Tu pedido suma *${earlyLiters}L* y el mínimo para ${session.eventoFormato} es *${minLiters}L*.

${formatEventCartSummary(session.orderBuilder.products, formatKey)}
*¿Qué cóctel o litraje agregamos para llegar al mínimo?*
_(ej: 5L Mojito)_ 🍸`
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

    // Multi-intent: pedido + despacho → parseamos/NLU sin la pregunta
    const hasDispatchQ = asksDeliveryOrDispatchQuestion(messageText);
    const extractText = hasDispatchQ ? stripDeliveryQuestionForCart(messageText) : messageText;

    const programmaticNames = parseCocktailNamesWithoutLitrage(extractText || messageText, catalogNames);
    const programmaticWithLitrage = parseEventProductsProgrammatic(
      extractText || messageText, catalogNames, allowedLitrages, defaultLitrage
    );
    const interceptedOption = interceptBotOptionsAnswer(extractText || messageText, lastBotMessage);

    // Primero reglas locales (con o sin litraje) — evita colgar el chat esperando al LLM.
    // Si el cliente nombró un cóctel del catálogo, eso manda por sobre el interceptor de opciones.
    if (programmaticWithLitrage.length > 0) {
      extractedList = programmaticWithLitrage;
    } else if (programmaticNames.length > 0 && !litrageOnly) {
      extractedList = programmaticNames.map((name) => ({ name, quantity: 1, litrage: defaultLitrage }));
    } else if (interceptedOption) {
      extractedList.push({ ...interceptedOption, litrage: defaultLitrage });
    } else {
      const result = await extractEventProductsWithAI(extractText || messageText, catalogNames, formatKey, lastBotMessage);
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

*¿Qué cócteles te gustaría incluir?*
_(ej: 5L de mojito)_

_(o escribe *lista* para ver precios)_`
      };
    }

    // Avanzar solo con lo que ya está en el carrito (sin productos nuevos en este mensaje)
    if (wantsAdvance && cartHasItemsAfter && !hasExtracted) {
      if (currentLiters < minLiters) {
        const reply = `Tu pedido suma *${currentLiters}L* y el mínimo para ${session.eventoFormato} es *${minLiters}L*.

${formatEventCartSummary(session.orderBuilder.products, formatKey)}
*¿Qué cóctel o litraje agregamos para llegar al mínimo?*
_(ej: 5L Mojito)_ 🍸`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }
      return { success: true, nextState: 'EVENTOS_COTIZACION' };
    }

    // Intentar resolver dudas sin preguntar (ej. "piscola alto" → una sola opción clara).
    // Si el cliente *preguntó* por sabores, nunca auto-elegir ni mutar el carrito.
    const isFlavorQuestion = asksCocktailFlavorList(messageText);
    if (dudas?.length > 0 && !isFlavorQuestion) {
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
    const cartOpts = { forceReplace: isCorrection, messageText };

    if (dudas?.length > 0) {
      // Listar opciones: no aplicar productos parciales en una pregunta de sabores
      if (!isFlavorQuestion && parsedProducts.length > 0) {
        applyProductsToCart(session, parsedProducts, cartOpts);
      }
      const duda = dudas[0];
      const familyFromOpts = (duda.opciones || [])
        .map((n) => getProductFamilyBase(n))
        .find(Boolean);
      if (familyFromOpts) {
        const opciones = getCatalogFamilyFlavorOptions(familyFromOpts, catalogNames);
        if (opciones.length >= 2) {
          return {
            success: true,
            nextState: 'EVENTOS_ELECCION_MENU',
            customReply: getFlavorListReply(familyFromOpts, opciones, { withLitersHint: true })
          };
        }
      }
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones)
      };
    }

    if (parsedProducts.length > 0) {
      session.pendingEventCocktails = null;
      const inCartBefore = namesAlreadyInCart(session.orderBuilder.products);
      const replacing = isCorrection || (
        !hasExplicitEventAddIntent(messageText)
        && parsedProducts.some((p) => inCartBefore.has(p.name))
      );
      applyProductsToCart(session, parsedProducts, cartOpts);

      const cartBuilder = new OrderBuilder(formatKey, preciosData);
      cartBuilder.products = session.orderBuilder.products;

      // "10L mojito seguimos" → si cumple mínimo, cotiza; si no, pide más litros
      if (wantsAdvance && cartBuilder.getTotalLiters() >= minLiters && invalidLitrages.length === 0) {
        return { success: true, nextState: 'EVENTOS_COTIZACION' };
      }

      const header = replacing
        ? `✅ Listo, actualicé tu pedido:`
        : `🍹 Te confirmo los cócteles seleccionados:`;
      const { reply } = buildCartReply({
        session, formatKey, minLiters, header, invalidLitrages, allowedLitrages
      });
      // Multi-intent: cócteles + duda de despacho → carrito + cobertura
      const withDispatch = hasDispatchQ
        ? `${reply}\n\n${REPLY_DISPATCH_SIDEBAR}`
        : reply;
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: withDispatch,
        flowProgress: true
      };
    }

    // Solo litrajes inválidos (sin productos válidos) → guardar pendientes y guiar
    if (invalidLitrages.length > 0) {
      const pending = [...new Set(invalidLitrages.map((i) => i.name))];

      // "2 mojito": el número suelto se lee como litros, pero 2L no existe.
      // Antes de pedir litraje preguntamos si en realidad quiso decir 2 barriles.
      const bareQuantity = parseBareQuantityWithoutUnit(messageText);
      if (bareQuantity && invalidLitrages.every((i) => i.litrage === `${bareQuantity}L`)) {
        session.pendingBarrelQuantity = { names: pending, quantity: bareQuantity, litrage: defaultLitrage };
        session.pendingEventCocktails = null;
        const totalLiters = bareQuantity * parseInt(defaultLitrage, 10);
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `En *${session.eventoFormato}* los barriles son de *${allowedLitrages.join(', ')}*, así que *${bareQuantity}L* no existe como tamaño.

¿Te refieres a esto?

${formatMenuBlock([
  `${bareQuantity} barriles de ${defaultLitrage} de ${pending.join(' y ')} (${totalLiters}L en total)`,
  `Elegir otro tamaño (${allowedLitrages.join(' / ')})`
])}`
        };
      }

      session.pendingEventCocktails = pending;

      let reply = `Para *${session.eventoFormato}* los barriles son: *${allowedLitrages.join(', ')}*`;
      if (formatKey === 'muro') reply += ` (no hay 5L)`;
      reply += `.\n\nAnoté: *${pending.join('*, *')}*.`;
      reply += `\n¿Con qué litraje los quieres? Puedes decir *10L* para todos, o por ejemplo: _"5L Mojito y 10L Aperol"_`;
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    return { success: false };
  }
});
