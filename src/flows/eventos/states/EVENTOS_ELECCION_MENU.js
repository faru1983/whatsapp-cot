// ==============================================================================
// OBJETIVO: Paso EVENTOS_ELECCION_MENU — NLU + carrito estructurado.
// Extraemos productos con IA, guardamos en orderBuilder y avanzamos cuando
// el carrito cumple el mínimo de litros del formato elegido.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getDoubtClarificationTemplate, getFlavorListReply, getNonAlcoholicSuggestionReply } from '../../../views/templates.js';
import {
  hasDrinkSelection,
  hasProductOrderSignal,
  preciosData,
  resolveDoubtsProgrammatically,
  interceptBotOptionsAnswer,
  parseEventElimination,
  isEventMenuCorrection,
  isBareEventEliminationRequest,
  hasEventEliminationIntent,
  hasExplicitEventAddIntent,
  hasEventCartPreserveIntent,
  detectFlavorListRequest,
  asksCocktailFlavorList,
  asksAvailableCocktailsList,
  getCoctelesNamesCatalog,
  getProductFamilyBase,
  getCatalogFamilyFlavorOptions,
  wantsNonAlcoholicOption,
  isMocktailName,
  detectNamedCatalogCategory
} from '../../../logic/utils.js';
import {
  wantsAdvanceProductsOrder,
  isOnlyAdvanceProductsOrder,
  isGreetingOrNoise
} from '../../../logic/interruptions.js';
import { extractEventProductsWithAI } from '../../../core/llm.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import { getEnv } from '../../../core/config.js';
import {
  looksLikeUnrecognizedFlavorAttempt,
  findUnmatchedFlavorSegments
} from '../../../logic/barriles-intro.js';
import {
  getEventFormatKey,
  getMinLitersForFormat,
  getAllowedLitrages,
  ensureEventOrderBuilder,
  formatEventCartSummary,
  formatEventCartTotalsLine,
  buildEventCartOkAsk,
  buildEventCartRemoveExamples,
  getEventCocktailSingleExample,
  getEventCocktailOrderExample,
  buildAskEventCocktails,
  parseLitrageOnlyMessage,
  parseCocktailNamesWithoutLitrage,
  parseEventProductsProgrammatic,
  parseBareQuantityWithoutUnit,
  validateEventProductLines,
  asksDeliveryOrDispatchQuestion,
  REPLY_DISPATCH_SIDEBAR_EVENTOS,
  stripDeliveryQuestionForCart,
  matchCocktailNamesInText,
  registerEventosProductOrderMiss,
  formatEventosUnmatchedFlavorNote,
  tryApplyEventosIntroPriorCorrection
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';
import { matchesMenuOption } from '../../../logic/keyword-intent.js';
import {
  applyStylePackToSession,
  applySuggestedSelectionToSession,
  buildPackProposalReply,
  wantsMoreEventQuantity,
  wantsSelfBuildEventMenu,
  wantsSuggestedSelection,
  resolveSuggestedSelectionIntent,
  applyBaselineLitersIfNamesOnly,
  messageOmitsEventLitrage,
  EVENT_DRINKS_PER_GUEST_PARTY,
  asksEventCombinadosInfo,
  asksEventMocktailsInfo,
  buildCombinadosInfoReply,
  buildMocktailsInfoReply,
  detectSideStyleFromText,
  buildFlavorPickQuestion,
  buildFlavorCatalogBlock,
  asksEventCatalogPriceList,
  buildEventPriceListAskReplies,
  buildCategoryFlavorAsk
} from '../../../logic/eventos-style-pack.js';
import { nextEventosAck } from '../../../logic/eventos-intro.js';

const AI_PROMPT = `[SISTEMA - ESTADO: ELECCIÓN DE SABORES (EVENTOS)]
Un solo paso: el cliente elige cócteles (favoritos manuales, *sugerida*, o ajustando un pedido ya armado).
La lista de sabores NO incluye precios. Usa el CONTEXTO DE FORMATO inyectado (Dispensador/Muro, litrajes, mínimo, instalación).

1. Dudas breves (logística, rendimiento, mocktails). Precios/valores de carta → imagen de precios del formato (no inventes cifras).
2. Con pedido armado: ajustar sabores o *ok* para cotización formal.
3. Si nombra una CATEGORÍA (Clásicos, Combinados, Mocktails) sin un sabor concreto: NO elijas un cóctel por él. Pide nombres de esa categoría.
4. Corrige invitados/tipo sin cócteles → confirma y vuelve a pedir sabores o *sugerida*.
5. Dispensador: instalación gratis. Muro: instalación ~$50.000. No inventes envíos extra.`;

/**
 * eventCartLineCount: Cuántas líneas de cóctel hay en el carrito Eventos.
 *
 * @param {object} session
 * @returns {number}
 */
function eventCartLineCount(session) {
  return Object.keys(session.orderBuilder?.products || {}).length;
}

/**
 * withFirstCocktailCrmEngage: Si el carrito pasó de vacío a tener ítems, marca Interesado.
 *
 * @param {number} linesBefore
 * @param {object} session
 * @param {object} result - Resultado validateAndProcess
 * @returns {object}
 */
function withFirstCocktailCrmEngage(linesBefore, session, result) {
  if (linesBefore === 0 && eventCartLineCount(session) > 0) {
    return { ...result, crmEngage: 'eventos_elige_cocteles' };
  }
  return result;
}

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
    const formatKey = getEventFormatKey(session.eventoFormato);
    return withAssistantFooter(buildEventCartOkAsk(session.orderBuilder.products, formatKey));
  }
  // Sin carrito: misma pregunta abierta (sin re-listar todo el catálogo)
  return withAssistantFooter(buildFlavorPickQuestion());
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
  const removeExamples = buildEventCartRemoveExamples(session.orderBuilder.products);
  const okAsk = buildEventCartOkAsk(session.orderBuilder.products, formatKey);
  const literMatch = okAsk.match(/"(\d+L [^"]+)"/);
  const literHint = literMatch ? literMatch[1] : 'cambia los litros de un sabor';
  return `Claro 😊

${cart}
*¿Qué quieres quitar de tu pedido?*
_(ej: ${removeExamples})_

_(si quieres cambiar cantidad: ${literHint})_`;
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
  const explicitAdd = Boolean(opts.explicitAdd) || hasExplicitEventAddIntent(messageText);
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
 * buildCartReply: Arma el carrito (burbuja 1) + pregunta de confirmación (burbuja 2).
 * Lo comparten todas las ramas que agregan cócteles, para no repetir el formato.
 *
 * @param {object} params
 * @param {object} params.session - Sesión del cliente
 * @param {string} params.formatKey - 'dispensador' | 'muro'
 * @param {number} params.minLiters - Mínimo de litros del formato
 * @param {string} params.header - Primera línea (confirmación o corrección)
 * @param {Array<{name: string, litrage: string}>} [params.invalidLitrages] - Líneas que no se pudieron agregar
 * @param {string[]} [params.allowedLitrages] - Tamaños válidos, para explicar los rechazos
 * @param {string} [params.unmatchedNote] - Aviso de sabores fuera de carta
 * @returns {{ reply: string, followUp: string, totalLiters: number }}
 */
function buildCartReply({ session, formatKey, minLiters, header, invalidLitrages = [], allowedLitrages = [], unmatchedNote = '' }) {
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  orderBuilder.products = session.orderBuilder.products;
  const quote = orderBuilder.calculateQuote();
  const totalLiters = orderBuilder.getTotalLiters();

  // Burbuja 1: lista + subtotal + litros (sin la pregunta)
  let reply = `${header}\n\n`;
  reply += formatEventCartSummary(session.orderBuilder.products, formatKey);
  reply += `\n${formatEventCartTotalsLine(quote, { guests: session.guests })}\n`;

  if (invalidLitrages.length > 0) {
    reply += `\n⚠️ No pude agregar:\n`;
    for (const inv of invalidLitrages) {
      reply += `- ${inv.name} (${inv.litrage}): litraje no disponible en ${session.eventoFormato}. Válidos: ${allowedLitrages.join(', ')}.\n`;
    }
  }

  if (unmatchedNote) reply += unmatchedNote;

  // Burbuja 2: confirmar *ok* o pedir más litros si falta el mínimo
  const followUp = totalLiters >= minLiters
    ? `${buildEventCartOkAsk(session.orderBuilder.products, formatKey)} 🍸`
    : `Aún faltan litros para el mínimo (*${minLiters}L*). ¿Qué más agregamos? 🍸`;

  return { reply, followUp, totalLiters };
}

/**
 * buildSuggestedSelectionTurn: Arma la cotización sugerida (pack populares).
 *
 * @param {object} session
 * @param {string} formatKey
 * @param {number} linesBefore - Líneas de carrito antes (CRM)
 * @returns {object} Resultado para validateAndProcess
 */
function buildSuggestedSelectionTurn(session, formatKey, linesBefore) {
  const pack = applySuggestedSelectionToSession(session, formatKey);
  const { reply, followUp } = buildPackProposalReply(session, formatKey, pack);
  return withFirstCocktailCrmEngage(linesBefore, session, {
    success: true,
    nextState: 'EVENTOS_ELECCION_MENU',
    customReplies: [reply, followUp],
    flowProgress: true
  });
}

export const EVENTOS_ELECCION_MENU = defineState({
  id: 'EVENTOS_ELECCION_MENU',
  promptQuestion: () => buildFlavorPickQuestion(),
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const formatKey = getEventFormatKey(session.eventoFormato);
    const minLiters = getMinLitersForFormat(formatKey);
    const allowedLitrages = getAllowedLitrages(formatKey);
    ensureEventOrderBuilder(session, formatKey);

    const catalogNames = Object.keys(preciosData.cocteles || {});
    const defaultLitrage = formatKey === 'muro' ? '10L' : '5L';
    // Para CRM Interesado: primer cóctel del carrito (no al solo ver la carta)
    const linesBefore = eventCartLineCount(session);

    // ------------------------------------------------------------------
    // Selección sugerida (opcional) o pack propuesto: más cantidad / atajos
    // ------------------------------------------------------------------
    if (
      resolveSuggestedSelectionIntent(messageText)
      && eventCartLineCount(session) === 0
    ) {
      return buildSuggestedSelectionTurn(session, formatKey, linesBefore);
    }

    if (session.eventosPackProposed && wantsMoreEventQuantity(messageText) && session.eventosStyleKey) {
      const pack = session.eventosStyleKey === 'SUGERIDO'
        ? applySuggestedSelectionToSession(session, formatKey, EVENT_DRINKS_PER_GUEST_PARTY)
        : applyStylePackToSession(
          session,
          session.eventosStyleKey,
          formatKey,
          EVENT_DRINKS_PER_GUEST_PARTY
        );
      const { reply, followUp } = buildPackProposalReply(session, formatKey, pack);
      return withFirstCocktailCrmEngage(linesBefore, session, {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          `${nextEventosAck(session)}, lo subimos a ~*${EVENT_DRINKS_PER_GUEST_PARTY} por persona* (más fiesta) 🎉\n\n${reply}`,
          followUp
        ],
        flowProgress: true
      });
    }

    if (wantsSelfBuildEventMenu(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          buildFlavorCatalogBlock(formatKey),
          buildFlavorPickQuestion()
        ],
        flowProgress: true
      };
    }

    // Nombró una categoría (Clásicos / Combinados / Mocktails) sin un sabor concreto.
    // Con carrito, "sin alcohol" sigue el flujo de sugerir Mocktail de la familia.
    const namedCategory = detectNamedCatalogCategory(messageText);
    if (
      namedCategory
      && !hasProductOrderSignal(messageText)
      && eventCartLineCount(session) === 0
    ) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: buildCategoryFlavorAsk(namedCategory, formatKey),
        flowProgress: true
      };
    }

    // Pack lateral: combinados / sin alcohol — solo si aún no hay carrito manual,
    // o si viene de un pack y elige explícito (mensaje corto).
    const sideStyle = detectSideStyleFromText(messageText);
    const packCartEmpty = eventCartLineCount(session) === 0;
    const shortSidePick = /^(combinados?|piscola|piscolas|sin\s+alcohol|mocktails?|mocktail)$/i
      .test(String(messageText || '').trim());
    if (
      sideStyle
      && !hasProductOrderSignal(messageText)
      && (packCartEmpty || (session.eventosPackProposed && shortSidePick))
    ) {
      const pack = applyStylePackToSession(session, sideStyle, formatKey);
      const { reply, followUp } = buildPackProposalReply(session, formatKey, pack);
      return withFirstCocktailCrmEngage(linesBefore, session, {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [reply, followUp],
        flowProgress: true
      });
    }
    if (asksEventCombinadosInfo(messageText) && !hasProductOrderSignal(messageText) && packCartEmpty) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: buildCombinadosInfoReply(false)
          + '\n\nDime el *nombre* que quieres (ej: Piscola Alto 35°), o escribe *sugerida* 😊',
        flowProgress: true
      };
    }
    // "sin alcohol" con carrito: lo maneja getNonAlcoholicSuggestionReply más abajo (familia)
    if (
      (asksEventMocktailsInfo(messageText) || wantsNonAlcoholicOption(messageText))
      && !hasProductOrderSignal(messageText)
      && !hasDrinkSelection(messageText)
      && packCartEmpty
    ) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: buildMocktailsInfoReply(false)
          + '\n\nDime el *nombre* del Mocktail que quieres, o escribe *sugerida* 🍹',
        flowProgress: true
      };
    }

    // Corrección de invitados/tipo sin pedido de cócteles (no roba "10L mojito"
    // ni el menú pendiente "¿son N barriles?")
    if (
      !session.pendingBarrelQuantity
      && !hasDrinkSelection(messageText)
      && !hasProductOrderSignal(messageText)
    ) {
      const priorFix = tryApplyEventosIntroPriorCorrection(messageText, session);
      if (priorFix) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `${priorFix.ack}\n\n${shortQuestionForSession(session)}`,
          flowProgress: true
        };
      }
    }

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
          const { reply, followUp } = buildCartReply({
            session, formatKey, minLiters, header: `🍹 Listo, lo anoté así:`
          });
          return withFirstCocktailCrmEngage(linesBefore, session, {
            success: true,
            nextState: 'EVENTOS_ELECCION_MENU',
            customReplies: [reply, followUp]
          });
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

    // "sin alcohol" / "mocktail" (con o sin sabor en el mismo mensaje, ej. "mojito sin
    // alcohol") → sugerimos el Mocktail de ese sabor o de lo que ya tiene en el carrito;
    // sin relación clara, mostramos toda la carta Mocktails. Nunca agregamos nada solos.
    // Excepción: si el mensaje YA nombra un Mocktail exacto, seguimos el flujo normal para
    // agregarlo al carrito (evita repetir la misma sugerencia en bucle).
    if (wantsNonAlcoholicOption(messageText)) {
      const allMentioned = matchCocktailNamesInText(messageText, catalogNames);
      const directMocktailMatches = allMentioned.filter(isMocktailName);
      if (directMocktailMatches.length === 0) {
        const mentioned = allMentioned.filter((n) => !isMocktailName(n));
        const referenceNames = mentioned.length > 0 ? mentioned : [...namesAlreadyInCart(session.orderBuilder.products)];
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: getNonAlcoholicSuggestionReply(referenceNames, catalogNames, { withLitersHint: true })
        };
      }
    }

    // Catálogo de precios on-demand (mismo paso: favoritos, sugerida o carrito ya armado)
    if (asksEventCatalogPriceList(messageText) && !hasDrinkSelection(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: buildEventPriceListAskReplies(formatKey, { session })
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
        const { reply, followUp } = buildCartReply({
          session, formatKey, minLiters, header: `🍹 Listo, anoté con *${litrageOnly}*:`
        });
        return withFirstCocktailCrmEngage(linesBefore, session, {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReplies: [reply, followUp]
        });
      }
      if (invalidLitrages.length > 0) {
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReply: `Ese litraje no está disponible para ${session.eventoFormato}. Válidos: *${allowedLitrages.join(', ')}*.`
        };
      }
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
_(ej: quita el mojito o ${getEventCocktailSingleExample(formatKey)})_`
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
      reply += `\n${formatEventCartTotalsLine(quote, { guests: session.guests })}\n\n`;
      if (Object.keys(session.orderBuilder.products).length === 0) {
        reply += buildFlavorPickQuestion();
      } else if (totalLiters >= minLiters) {
        reply += `*¿Quieres eliminar otro o agregar más?*
_(ej: escribe *ok* si está listo)_ 🍸`;
      } else {
        reply += `Aún faltan litros para el mínimo (*${minLiters}L*).

*¿Qué más agregamos?*
_(ej: ${getEventCocktailSingleExample(formatKey)})_ 🍸`;
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

    // "¿cuáles tienes?" / "¿qué cócteles hay?" → nombres por categoría (sin FAQ/LLM)
    if (asksAvailableCocktailsList(messageText) && !hasDrinkSelection(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          getCoctelesNamesCatalog(),
          buildFlavorPickQuestion()
        ]
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

${buildAskEventCocktails(formatKey)}

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
_(ej: ${getEventCocktailSingleExample(formatKey)})_ 🍸`
        };
      }
      session.eventosContactPhase = null;
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        flowProgress: true
      };
    }

    // Cortesía / ruido sin pedido → engine re-pregunta (sin NLU que invente cócteles)
    if (isGreetingOrNoise(messageText) && !hasProductOrderSignal(messageText)) {
      return { success: false };
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

    const cartHasItemsEarly = eventCartLineCount(session) > 0;
    const preserveCartEarly = hasExplicitEventAddIntent(messageText) || hasEventCartPreserveIntent(messageText);
    if (
      preserveCartEarly
      && cartHasItemsEarly
      && messageOmitsEventLitrage(messageText)
      && parseCocktailNamesWithoutLitrage(messageText, catalogNames).length === 0
    ) {
      const { reply, followUp } = buildCartReply({
        session,
        formatKey,
        minLiters,
        header: 'Perfecto, mantengo tu pedido tal como está 😊'
      });
      return withFirstCocktailCrmEngage(linesBefore, session, {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          `${reply}\n\n¿Qué sabor quieres *sumar* a lo anterior?`,
          followUp
        ],
        flowProgress: true
      });
    }

    // Multi-intent: pedido + despacho → parseamos/NLU sin la pregunta
    const hasDispatchQ = asksDeliveryOrDispatchQuestion(messageText);
    const extractText = hasDispatchQ ? stripDeliveryQuestionForCart(messageText) : messageText;

    const programmaticNames = parseCocktailNamesWithoutLitrage(extractText || messageText, catalogNames);
    const programmaticWithLitrage = parseEventProductsProgrammatic(
      extractText || messageText, catalogNames, allowedLitrages, defaultLitrage
    );
    const interceptedOption = interceptBotOptionsAnswer(extractText || messageText, lastBotMessage);
    // Nombre suelto fuera de carta ("piña colada") → misma lógica que Barriles (NLU + miss)
    const maybeUnknownFlavor = looksLikeUnrecognizedFlavorAttempt(messageText);

    // Primero reglas locales (con o sin litraje) — evita colgar el chat esperando al LLM.
    // Si el cliente nombró un cóctel del catálogo, eso manda por sobre el interceptor de opciones.
    if (programmaticWithLitrage.length > 0) {
      extractedList = programmaticWithLitrage;
    } else if (programmaticNames.length > 0 && !litrageOnly) {
      extractedList = programmaticNames.map((name) => ({ name, quantity: 1, litrage: defaultLitrage }));
    } else if (interceptedOption) {
      extractedList.push({ ...interceptedOption, litrage: defaultLitrage });
    } else if (!hasProductOrderSignal(extractText || messageText) && !maybeUnknownFlavor) {
      // Sin señal de pedido ni intento de sabor: no llamar NLU — evita alucinaciones
      return { success: false };
    } else {
      const result = await extractEventProductsWithAI(extractText || messageText, catalogNames, formatKey, lastBotMessage);
      if (
        eventCartLineCount(session) === 0
        && resolveSuggestedSelectionIntent(extractText || messageText, result)
      ) {
        return buildSuggestedSelectionTurn(session, formatKey, linesBefore);
      }
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

${buildAskEventCocktails(formatKey)}

_(o escribe *lista* para ver precios)_`
      };
    }

    // Avanzar solo con lo que ya está en el carrito (sin productos nuevos en este mensaje)
    if (wantsAdvance && cartHasItemsAfter && !hasExtracted) {
      if (currentLiters < minLiters) {
        const reply = `Tu pedido suma *${currentLiters}L* y el mínimo para ${session.eventoFormato} es *${minLiters}L*.

${formatEventCartSummary(session.orderBuilder.products, formatKey)}
*¿Qué cóctel o litraje agregamos para llegar al mínimo?*
_(ej: ${getEventCocktailSingleExample(formatKey)})_ 🍸`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }
      session.eventosContactPhase = null;
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        flowProgress: true
      };
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

    // Si ya fijó cócteles p/p y solo nombró sabores (sin 5L/10L), repartimos litros
    const cartLitersBeforeExtract = (() => {
      const b = new OrderBuilder(formatKey, preciosData);
      b.products = session.orderBuilder.products;
      return b.getTotalLiters();
    })();
    const inCartNames = [...namesAlreadyInCart(session.orderBuilder.products)];
    const preserveCart = hasExplicitEventAddIntent(messageText) || hasEventCartPreserveIntent(messageText);
    if (
      extractedList.length > 0
      && session.eventosDrinksPerGuest
      && messageOmitsEventLitrage(extractText || messageText)
    ) {
      const scaled = applyBaselineLitersIfNamesOnly(
        extractedList,
        extractText || messageText,
        session,
        formatKey,
        { cartLiters: cartLitersBeforeExtract, isAdd: preserveCart, inCartNames, preserveCart }
      );
      if (scaled.length > 0) {
        const isFullReselect = !preserveCart && cartLitersBeforeExtract > 0
          && scaled.some((p) => inCartNames.includes(p.name));
        // Vaciar solo en corrección o re-lista completa (no al sumar sabores nuevos)
        if ((isEventMenuCorrection(messageText) || isFullReselect) && cartLitersBeforeExtract > 0) {
          session.orderBuilder.products = {};
        }
        extractedList = scaled;
      }
    }

    const { parsedProducts, invalidLitrages } = validateEventProductLines(
      messageText, extractedList, formatKey, allowedLitrages, defaultLitrage, catalogNames
    );

    const isCorrection = isEventMenuCorrection(messageText);
    const allNewFlavors = parsedProducts.length > 0
      && parsedProducts.every((p) => !inCartNames.includes(p.name));
    const cartOpts = {
      forceReplace: isCorrection,
      messageText,
      explicitAdd: preserveCart || (cartLitersBeforeExtract > 0 && allNewFlavors)
    };

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
          return withFirstCocktailCrmEngage(linesBefore, session, {
            success: true,
            nextState: 'EVENTOS_ELECCION_MENU',
            customReply: getFlavorListReply(familyFromOpts, opciones, { withLitersHint: true })
          });
        }
      }
      return withFirstCocktailCrmEngage(linesBefore, session, {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones)
      });
    }

    if (parsedProducts.length > 0) {
      session.pendingEventCocktails = null;
      const inCartBefore = namesAlreadyInCart(session.orderBuilder.products);
      const replacing = isCorrection || (
        !preserveCart && !allNewFlavors
        && parsedProducts.some((p) => inCartBefore.has(p.name))
      );
      applyProductsToCart(session, parsedProducts, cartOpts);

      const cartBuilder = new OrderBuilder(formatKey, preciosData);
      cartBuilder.products = session.orderBuilder.products;

      // "10L mojito seguimos" → si cumple mínimo, cotiza; si no, pide más litros
      if (wantsAdvance && cartBuilder.getTotalLiters() >= minLiters && invalidLitrages.length === 0) {
        session.eventosContactPhase = null;
        // Transición a contacto: CRM también se dispara por shouldEngageCrmOnTransition
        return withFirstCocktailCrmEngage(linesBefore, session, {
          success: true,
          nextState: 'EVENTOS_DATOS_CONTACTO',
          flowProgress: true
        });
      }

      const header = replacing
        ? `✅ Listo, actualicé tu pedido:`
        : `🍹 Te confirmo los cócteles seleccionados:`;
      const unmatchedNote = formatEventosUnmatchedFlavorNote(findUnmatchedFlavorSegments(messageText));
      const { reply, followUp } = buildCartReply({
        session, formatKey, minLiters, header, invalidLitrages, allowedLitrages, unmatchedNote
      });
      // Multi-intent: cócteles + duda de despacho → carrito + cobertura (en la 1ª burbuja)
      const withDispatch = hasDispatchQ
        ? `${reply}\n\n${REPLY_DISPATCH_SIDEBAR_EVENTOS}`
        : reply;
      return withFirstCocktailCrmEngage(linesBefore, session, {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [withDispatch, followUp],
        flowProgress: true
      });
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

      let reply = `Para *${session.eventoFormato}* los barriles son: *${allowedLitrages.join(', ')}*.\n\n`;
      reply += `Anoté: *${pending.join('*, *')}*.`;
      reply += `\n¿Con qué litraje los quieres? Puedes decir *${allowedLitrages[0]}* para todos, o por ejemplo: _"${getEventCocktailOrderExample(formatKey)}"_`;
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    // Tras intentar parsear/NLU: sabor fuera de carta o pedido vacío → miss (como Barriles)
    if (maybeUnknownFlavor || hasProductOrderSignal(extractText || messageText)) {
      const threshold = getEnv().security?.maxConsecutiveErrors || 2;
      return registerEventosProductOrderMiss(session, threshold);
    }

    return { success: false };
  }
});
