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
  interceptBotOptionsAnswer,
  isOnlyBrowsing,
  wantsInstagramOrSocial,
  hasEventEliminationIntent,
  isBareEventEliminationRequest,
  detectFlavorListRequest,
  asksCocktailFlavorList,
  getProductFamilyBase,
  getCatalogFamilyFlavorOptions,
  hasProductOrderSignal
} from '../../../logic/utils.js';
import {
  wantsAdvanceProductsOrder,
  isOnlyAdvanceProductsOrder,
  isGreetingOrNoise
} from '../../../logic/interruptions.js';
import { extractProductsWithAI } from '../../../core/llm.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import { getDoubtClarificationTemplate, getBrowseOnlyGoodbye, getFlavorListReply } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  asksDeliveryOrDispatchQuestion,
  REPLY_DISPATCH_SIDEBAR_BARRILES,
  stripDeliveryQuestionForCart,
  parseBarrilesProductsProgrammatic
} from '../../../logic/eventos-helpers.js';

const AI_PROMPT = `[SISTEMA - ESTADO: CATÁLOGO (FALLBACK)]
El cliente debe indicar sabor y cantidad de Barriles Desechables (5L).
1. Duda breve (ingredientes, despacho RM / encomienda regiones). NUNCA inventes costos.
2. Solo formato 5L. Si solo mira / no quiere ahora: despídete y NO preguntes más.
3. Si no: cierra pidiendo sabor/cantidad (ej. "1 mojito y 1 sangría"). Si ya tiene pedido, sugiere escribir *OK* para continuar con la cotización.`;

/**
 * formatCartLines: Lista de ítems + subtotal + explicación de litros/tragos.
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
    lines += `- ${qty}x ${name} 5L: ${formatPrice(price * qty)}\n`;
  }
  lines += `\n*Subtotal de cócteles:* ${formatPrice(quote.subtotal)}`;
  // Línea aparte: litros totales y qué significa en copas (≈200ml con hielo)
  if (quote.totalLiters > 0) {
    lines += `\n\nSerían *${quote.totalLiters}L totales*, que equivalen a *${quote.totalDrinks} tragos* de 200ml en una copa/vaso con hielo.`;
  }
  return lines;
}

/** CTA tras confirmar carrito: *OK* o pedir cambio con ejemplo concreto. */
const CART_OK_CTA = `Si está bien así, escribe *OK* para continuar o dime qué agregar o quitar.
_(ej: elimina el aperol, agrega 1 sangría)_`;

/**
 * buildCartConfirmReply: Resumen de cócteles + CTA (*OK* para seguir; también vale *seguimos*).
 * El siguiente paso puede ser fecha/comuna o el resumen final, según lo que ya tengamos.
 *
 * @param {object} products - Mapa nombre → cantidad
 * @param {string} [extraNote] - Nota extra (ej. duda de despacho en el mismo mensaje)
 * @returns {string}
 */
function buildCartConfirmReply(products, extraNote = '') {
  const note = extraNote ? `\n\n${extraNote}` : '';
  return `🍹 Te confirmo los cócteles seleccionados:

${formatCartLines(products)}

${CART_OK_CTA}${note}`;
}

/**
 * hasDeliveryData: ¿Ya tenemos fecha y comuna? (se piden en RECOGIDA_DATOS si faltan).
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
  // Al entrar: solo pedimos sabor/cantidad. *OK* se ofrece cuando ya hay carrito.
  promptQuestion: () => `*¿Qué sabor y cuántos barriles quieres?*
_(ej: 1 mojito y 1 sangría)_`,
  shortQuestion: withAssistantFooter(`*¿Todo bien con el pedido?*
_(ej: escribe *OK* para continuar, o "elimina el aperol, agrega 1 sangría")_`),
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

*¿Qué sabor y cuántos barriles quieres?*
_(ej: 1 mojito)_

_(o escribe *lista* para ver la carta)_`
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
          `*¿Qué sabor y cuántos barriles quieres?*
_(ej: 2 mojitos y 1 aperol)_`
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

${CART_OK_CTA}`
      };
    }

    // Dijo "quitar" solo, sin nombrar el cóctel → preguntar qué, no asumir "no encontrado"
    if (Object.keys(session.orderBuilder.products || {}).length > 0
        && isBareEventEliminationRequest(messageText)) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: `Claro 😊

*¿Qué quieres quitar de tu pedido?*
_(ej: quita el mojito)_

${formatCartLines(session.orderBuilder.products)}`
      };
    }

    // "no quiero el aperol" / "sin mojito" pero no coincide con nada del carrito:
    // nunca caer al flujo de agregar
    if (
      Object.keys(session.orderBuilder.products || {}).length > 0
      && hasEventEliminationIntent(messageText)
    ) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: `No encontré ese cóctel en tu pedido 😊

Tu pedido actual:
${formatCartLines(session.orderBuilder.products)}

*¿Qué quieres quitar o agregar?*
_(ej: quita el mojito)_`
      };
    }

    const catalogNames = Object.keys(preciosData.cocteles || {});

    // Pregunta de sabores → listar sin mutar carrito
    const flavorAsk = detectFlavorListRequest(messageText, catalogNames);
    if (flavorAsk) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: getFlavorListReply(flavorAsk.family, flavorAsk.opciones, { withLitersHint: false })
      };
    }

    // Cortesía / ruido sin pedido → re-pregunta del engine (sin NLU)
    if (isGreetingOrNoise(messageText) && !hasProductOrderSignal(messageText)) {
      return { success: false };
    }

    let lastBotMessage = '';
    if (session.history?.turns?.length > 0) {
      const botTurns = session.history.turns.filter((t) => t.role === 'model');
      if (botTurns.length > 0) lastBotMessage = botTurns[botTurns.length - 1].text;
    }

    let extractedList = [];
    let dudas = [];
    let quiere_avanzar = false;

    // Multi-intent: si hay pedido + duda de despacho, extraemos cócteles sin la pregunta
    const hasDispatchQ = asksDeliveryOrDispatchQuestion(messageText);
    const extractText = hasDispatchQ ? stripDeliveryQuestionForCart(messageText) : messageText;

    // Primero reglas locales (como en eventos) — no depender solo del LLM
    const programmatic = parseBarrilesProductsProgrammatic(extractText || messageText, catalogNames);
    const interceptedOption = interceptBotOptionsAnswer(extractText || messageText, lastBotMessage);
    if (programmatic.length > 0) {
      extractedList = programmatic;
    } else if (interceptedOption) {
      extractedList.push(interceptedOption);
    } else if (!hasProductOrderSignal(extractText || messageText)) {
      // Sin señal de cóctel/barril → no llamar NLU (evita inventar productos)
      return { success: false };
    } else {
      const result = await extractProductsWithAI(extractText || messageText, catalogNames, lastBotMessage);
      extractedList = result.productos;
      dudas = result.dudas;
      quiere_avanzar = result.quiere_avanzar;
    }
    const wantsAdvance = quiere_avanzar || wantsAdvanceProductsOrder(messageText);

    // "seguimos" solo (o NLU dice avanzar) con carrito ya lleno → siguiente paso
    if (wantsAdvance && Object.keys(session.orderBuilder.products).length > 0 && (!extractedList || extractedList.length === 0)) {
      return { success: true, nextState: nextStateAfterProducts(session) };
    }

    if (dudas?.length > 0) {
      const isFlavorQuestion = asksCocktailFlavorList(messageText);
      if (!isFlavorQuestion) {
        const { resolved, remaining } = resolveDoubtsProgrammatically(dudas, lastBotMessage);
        if (resolved.length > 0) {
          for (const item of resolved) {
            if (!extractedList.find((p) => p.name === item.name)) extractedList.push(item);
          }
        }
        dudas = remaining;
      }
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
      const isFlavorQuestion = asksCocktailFlavorList(messageText);
      if (!isFlavorQuestion && Object.keys(parsedProducts).length > 0) {
        for (const [pName, pQty] of Object.entries(parsedProducts)) {
          session.orderBuilder.products[pName] = (session.orderBuilder.products[pName] || 0) + pQty;
        }
      }
      const familyFromOpts = (duda.opciones || [])
        .map((n) => getProductFamilyBase(n))
        .find(Boolean);
      if (familyFromOpts) {
        const opciones = getCatalogFamilyFlavorOptions(familyFromOpts, catalogNames);
        if (opciones.length >= 2) {
          return {
            success: true,
            nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
            customReply: getFlavorListReply(familyFromOpts, opciones, { withLitersHint: false })
          };
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

      // Multi-intent: pedido + duda de despacho → carrito + respuesta corta de cobertura
      const dispatchNote = hasDispatchQ ? REPLY_DISPATCH_SIDEBAR_BARRILES : '';

      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: buildCartConfirmReply(session.orderBuilder.products, dispatchNote),
        flowProgress: true
      };
    }

    if ((isOnlyBrowsing(messageText) || wantsInstagramOrSocial(messageText))
        && Object.keys(session.orderBuilder.products).length === 0) {
      return { success: true, nextState: 'CERRADO', customReply: getBrowseOnlyGoodbye(), mute: true };
    }

    return { success: false };
  }
});
