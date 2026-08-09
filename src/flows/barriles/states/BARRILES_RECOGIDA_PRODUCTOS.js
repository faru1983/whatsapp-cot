// ==============================================================================
// OBJETIVO: Paso BARRILES_RECOGIDA_PRODUCTOS — NLU + carrito de cócteles 5L.
// Textos, prompt IA y lógica de productos en un solo archivo.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
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
  hasProductOrderSignal,
  wantsNonAlcoholicOption,
  isMocktailName
} from '../../../logic/utils.js';
import {
  wantsAdvanceProductsOrder,
  isOnlyAdvanceProductsOrder,
  isGreetingOrNoise,
  asksCocktailPriceOrCatalog
} from '../../../logic/interruptions.js';
import { extractProductsWithAI } from '../../../core/llm.js';
import { getEnv } from '../../../core/config.js';
import { getDoubtClarificationTemplate, getBrowseOnlyGoodbye, getFlavorListReply, getNonAlcoholicSuggestionReply } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  asksDeliveryOrDispatchQuestion,
  REPLY_DISPATCH_SIDEBAR_BARRILES,
  stripDeliveryQuestionForCart,
  parseBarrilesProductsProgrammatic,
  matchCocktailNamesInText
} from '../../../logic/eventos-helpers.js';
import {
  formatBarrilesCartLines,
  CART_OK_CTA,
  looksLikeUnrecognizedFlavorAttempt,
  buildBarrilesMatchedCartReplies,
  findUnmatchedFlavorSegments,
  asksBarrilesCatalogList,
  buildBarrilesCompactCatalogReply,
  registerBarrilesProductOrderMiss
} from '../../../logic/barriles-intro.js';

const AI_PROMPT = `[SISTEMA - ESTADO: CATÁLOGO (FALLBACK)]
El cliente debe indicar sabor y cantidad de Barriles Desechables (5L).
1. Duda breve (ingredientes, despacho RM / encomienda regiones). NUNCA inventes costos.
2. Solo formato 5L. Si solo mira / no quiere ahora: despídete y NO preguntes más.
3. Si no: cierra pidiendo sabor/cantidad (ej. "1 mojito y 1 sangría"). Si ya tiene pedido, sugiere escribir *OK* para continuar con la cotización.`;

/** Pregunta cuando aún no hay cócteles en el carrito. */
const ASK_FLAVOR_QTY = `*¿Qué sabor y cuántos barriles quieres?*
_(ej: 2 mojitos — o escribe *lista*)_`;

/** Pregunta cuando ya hay ítems: confirmar / editar. */
const ASK_OK_AFTER_CART = `*¿Todo bien con el pedido?*
_(ej: escribe *OK* para continuar, o "elimina el aperol, agrega 1 sangría")_`;

/**
 * shortQuestionForSession: Sin carrito → pedir sabor/cantidad; con carrito → *OK*.
 * Evita el mensaje repetitivo que pegaba ambas preguntas a la vez en el miss del engine.
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  const hasCart = session.orderBuilder?.products
    && Object.keys(session.orderBuilder.products).length > 0;
  return withAssistantFooter(hasCart ? ASK_OK_AFTER_CART : ASK_FLAVOR_QTY);
}

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

${formatBarrilesCartLines(products)}

${CART_OK_CTA}${note}`;
}

/**
 * advanceToPedidoDatos: Tras *OK* del carrito → checkout de pedido (datos uno a uno).
 * Ya no pasamos por cotización intermedia: el cliente eligió *hacer un pedido*.
 *
 * @param {object} session
 * @returns {object}
 */
function advanceToPedidoDatos(session) {
  // Reset fase para que el intro pregunte lo que falte (comuna primero)
  session.barrilesPedidoPhase = null;
  return {
    success: true,
    nextState: 'BARRILES_RECOGIDA_DATOS',
    flowProgress: true
  };
}

export const BARRILES_RECOGIDA_PRODUCTOS = defineState({
  id: 'BARRILES_RECOGIDA_PRODUCTOS',
  // Al entrar: solo pedimos sabor/cantidad. *OK* se ofrece cuando ya hay carrito.
  promptQuestion: () => ASK_FLAVOR_QTY,
  shortQuestion: shortQuestionForSession,
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
      return advanceToPedidoDatos(session);
    }

    // "¿cuáles tienes?" / "lista" / "disponibles" → lista compacta (sin reenviar la imagen)
    if (asksBarrilesCatalogList(messageText) && !hasProductOrderSignal(messageText)) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: buildBarrilesCompactCatalogReply(),
        flowProgress: true
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

${formatBarrilesCartLines(session.orderBuilder.products)}

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

${formatBarrilesCartLines(session.orderBuilder.products)}`
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
${formatBarrilesCartLines(session.orderBuilder.products)}

*¿Qué quieres quitar o agregar?*
_(ej: quita el mojito)_`
      };
    }

    const catalogNames = Object.keys(preciosData.cocteles || {});

    // "sin alcohol" / "mocktail" → NO es un sabor inventado (looksLikeUnrecognizedFlavorAttempt
    // ya lo excluye) ni un pedido normal: sugerimos el Mocktail del sabor mencionado en el mismo
    // mensaje (ej. "mojito sin alcohol") o de lo que ya tiene en el carrito; si no hay ninguna
    // relación clara, mostramos toda la carta Mocktails. Nunca agregamos nada solos.
    // Excepción: si el mensaje YA nombra un Mocktail exacto (ej. respondiendo a esa misma
    // sugerencia con "Mojito Mocktail"), seguimos el flujo normal de abajo para agregarlo
    // al carrito en vez de repetir la misma sugerencia en bucle.
    if (wantsNonAlcoholicOption(messageText)) {
      const allMentioned = matchCocktailNamesInText(messageText, catalogNames);
      const directMocktailMatches = allMentioned.filter(isMocktailName);
      if (directMocktailMatches.length === 0) {
        const mentioned = allMentioned.filter((n) => !isMocktailName(n));
        const referenceNames = mentioned.length > 0
          ? mentioned
          : Object.keys(session.orderBuilder.products || {});
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
          customReply: getNonAlcoholicSuggestionReply(referenceNames, catalogNames)
        };
      }
    }

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

    // Precio/valores/carta: el engine da tip contextual (no “no entendí tu pedido”)
    if (
      asksCocktailPriceOrCatalog(messageText)
      && !hasProductOrderSignal(extractText || messageText)
    ) {
      return { success: false };
    }

    // Primero reglas locales (fuzzy/typos) — luego NLU.
    const programmatic = parseBarrilesProductsProgrammatic(extractText || messageText, catalogNames);
    const interceptedOption = interceptBotOptionsAnswer(extractText || messageText, lastBotMessage);
    const maybeUnknownFlavor = looksLikeUnrecognizedFlavorAttempt(messageText);
    if (programmatic.length > 0) {
      extractedList = programmatic;
    } else if (interceptedOption) {
      extractedList.push(interceptedOption);
    } else if (hasProductOrderSignal(extractText || messageText) || maybeUnknownFlavor) {
      // Pedido claro O nombre suelto/typo: dejamos que la IA mapee al catálogo
      const result = await extractProductsWithAI(extractText || messageText, catalogNames, lastBotMessage);
      extractedList = result.productos;
      dudas = result.dudas;
      quiere_avanzar = result.quiere_avanzar;
    } else {
      // Texto suelto sin señal de cóctel → miss con strikes (catálogo ya enviado)
      const threshold = getEnv().security?.maxConsecutiveErrors || 2;
      return registerBarrilesProductOrderMiss(session, threshold);
    }
    const wantsAdvance = quiere_avanzar || wantsAdvanceProductsOrder(messageText);

    // "seguimos" solo (o NLU dice avanzar) con carrito ya lleno → siguiente paso
    if (wantsAdvance && Object.keys(session.orderBuilder.products).length > 0 && (!extractedList || extractedList.length === 0)) {
      return advanceToPedidoDatos(session);
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
      const hadProductsBefore = Object.keys(session.orderBuilder.products || {}).length > 0;
      const isCartEcho = Object.keys(parsedProducts).length === Object.keys(session.orderBuilder.products).length
        && Object.entries(parsedProducts).every(([name, qty]) => session.orderBuilder.products[name] === qty);

      if (wantsAdvance && isCartEcho) {
        return advanceToPedidoDatos(session);
      }

      for (const [pName, pQty] of Object.entries(parsedProducts)) {
        session.orderBuilder.products[pName] = (session.orderBuilder.products[pName] || 0) + pQty;
      }

      // "2 mojitos y 1 aperol seguimos" → agrega al carrito y avanza (no re-pregunta vacío)
      if (wantsAdvance) {
        return advanceToPedidoDatos(session);
      }

      // Multi-intent: pedido + duda de despacho → carrito + respuesta corta de cobertura
      const dispatchNote = hasDispatchQ ? REPLY_DISPATCH_SIDEBAR_BARRILES : '';

      // Primer sabor(es) del pedido → pitch "Excelente elección" (ingredientes + precio/copa)
      if (!hadProductsBefore) {
        const addedNames = Object.keys(parsedProducts);
        const unmatched = findUnmatchedFlavorSegments(messageText);
        const replies = buildBarrilesMatchedCartReplies(
          addedNames,
          session.orderBuilder.products,
          unmatched
        );
        if (dispatchNote) {
          // Nota de despacho al final del pitch (sin inventar otra burbuja)
          if (typeof replies[0] === 'string') replies[0] = `${replies[0]}\n\n${dispatchNote}`;
        }
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
          customReplies: replies,
          flowProgress: true
        };
      }

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

    // NLU vacío: miss con strikes (no “aún no lo tenemos” + flowProgress que reseteaba strikes)
    if (looksLikeUnrecognizedFlavorAttempt(messageText) || String(messageText || '').trim().length > 0) {
      const threshold = getEnv().security?.maxConsecutiveErrors || 2;
      return registerBarrilesProductOrderMiss(session, threshold);
    }

    return { success: false };
  }
});
