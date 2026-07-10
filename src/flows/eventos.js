import {
  getWelcomeEventos,
  getDoubtClarificationTemplate,
  getEventQuotationTemplate,
  buildAdminEventosOrderBody,
  getEventFormatPitch,
  getEventLitersSuggestion,
  getEventFormatRecommendation,
  getEventDataSummary
} from '../views/templates.js';
import { STATE_PROMPTS } from '../views/prompts.js';
import {
  findLocationByFuzzyMatch,
  parseDate,
  hasDrinkSelection,
  formatPrice,
  preciosData,
  getCartaCocteles,
  findClosestCatalogMatch,
  resolveDoubtsProgrammatically,
  parseEventElimination,
  isEventMenuCorrection,
  fixEventLitrageShorthand
} from '../logic/utils.js';
import { extractEventProductsWithAI } from '../core/llm.js';
import { OrderBuilder } from '../logic/order-builder.js';
import { resolveDecisionIntent } from '../logic/decision-intent.js';

// ==============================================================================
// OBJETIVO: Flujo Eventos (Servicio para Eventos).
// Guía al cliente desde que elige "eventos" hasta confirmar la cotización.
// Pasos (orden típico; las transiciones reales van en nextState):
// filtro canal -> recogida datos -> confirmar datos (ok) -> elección formato ->
// confirmar formato (pitch) -> elección menú (carta + NLU + carrito) -> cotización.
// ==============================================================================

/**
 * parseCelebrationType: Detecta qué celebra el cliente (matrimonio, cumpleaños, etc.).
 * Es opcional: si no aparece, el flujo sigue igual con invitados/fecha/comuna.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {string|null} Tipo de celebración o null
 */
function parseCelebrationType(messageText) {
  const lower = String(messageText || '').toLowerCase();
  const map = [
    [/matrimonio|casamiento|boda|wedding/i, 'Matrimonio'],
    [/cumplea[nñ]os|cumple/i, 'Cumpleaños'],
    [/empresa|corporativ|oficina|trabajo/i, 'Evento corporativo'],
    [/graduaci[oó]n|egreso/i, 'Graduación'],
    [/aniversario/i, 'Aniversario'],
    [/baby\s*shower|babyshower/i, 'Baby shower'],
    [/fiesta|celebraci[oó]n|evento/i, 'Celebración']
  ];
  for (const [re, label] of map) {
    if (re.test(lower)) return label;
  }
  return null;
}

/**
 * applyEventDataFromMessage: Extrae celebración, comuna, fecha, invitados del mensaje
 * y los guarda en sesión. Devuelve true si algo nuevo se anotó.
 * Reutilizado en recogida y en confirmación (por si corrige en el mismo paso).
 *
 * @param {string} messageText - Mensaje del cliente
 * @param {object} session - Sesión (se muta)
 * @returns {boolean} true si hubo al menos un dato nuevo
 */
function applyEventDataFromMessage(messageText, session) {
  let hasNewInfo = false;

  const celebration = parseCelebrationType(messageText);
  if (celebration && celebration !== session.celebrationType) {
    session.celebrationType = celebration;
    hasNewInfo = true;
  }

  const locationSearch = findLocationByFuzzyMatch(messageText);
  if (locationSearch) {
    session.location = locationSearch.name;
    session.isRM = locationSearch.isRM;
    session.region = locationSearch.region;
    hasNewInfo = true;
  } else {
    const locationMatch = messageText.match(/\ben\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)\b/i);
    if (locationMatch && !/el|la|un|una|mi|casa/i.test(locationMatch[1])) {
      session.location = locationMatch[1].trim();
      session.isRM = false;
      session.region = null;
      hasNewInfo = true;
    }
  }

  const dateSearch = parseDate(messageText);
  if (dateSearch) {
    session.date = dateSearch;
    hasNewInfo = true;
  }

  // Quitamos fechas del texto para no confundir "15 de mayo" con cantidad de invitados
  const cleanText = messageText.replace(/\b\d+\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi, "");
  const guestsMatch = cleanText.match(/\b(\d+)\s*(personas|invitados|pax|inv)?\b/i);
  if (guestsMatch) {
    session.guests = parseInt(guestsMatch[1], 10);
    hasNewInfo = true;
  }

  return hasNewInfo;
}

/**
 * buildMenuEntryReplies: Tras confirmar formato: carta + sugerencia de litros + pregunta.
 * Tres burbujas para que el cliente lea precios y orientación de consumo con calma.
 *
 * @param {object} session - Sesión (guests, eventoFormato)
 * @param {string} formatKey - 'dispensador' | 'muro'
 * @returns {string[]}
 */
function buildMenuEntryReplies(session, formatKey) {
  // Carta sin pregunta final: la pregunta va en la 3ª burbuja
  const carta = getCartaCocteles(formatKey, { includeClosingQuestion: false });
  const litersHint = getEventLitersSuggestion(session.guests, formatKey);
  return [
    carta,
    litersHint,
    `¿Qué cócteles te gustaría incluir en tu evento? (ej: "Mojito 10L y 1 Aperol 5L")`
  ];
}

/**
 * getEventFormatKey: Traduce el nombre amigable del formato a la clave de precios.
 * "Muro de Coctelería" → "muro"; cualquier otro → "dispensador".
 *
 * @param {string} eventoFormato - Texto guardado en session.eventoFormato
 * @returns {'muro'|'dispensador'}
 */
function getEventFormatKey(eventoFormato) {
  return eventoFormato === 'Muro de Coctelería' ? 'muro' : 'dispensador';
}

/**
 * getMinLitersForFormat: Pedido mínimo en litros según formato.
 *
 * @param {string} formatKey - 'muro' | 'dispensador'
 * @returns {number}
 */
function getMinLitersForFormat(formatKey) {
  return formatKey === 'muro' ? 30 : 10;
}

/**
 * getAllowedLitrages: Litrajes válidos según formato (para validar lo que extrajo la IA).
 *
 * @param {string} formatKey - 'muro' | 'dispensador'
 * @returns {string[]}
 */
function getAllowedLitrages(formatKey) {
  return formatKey === 'muro' ? ['10L', '20L', '30L'] : ['5L', '10L'];
}

/**
 * ensureEventOrderBuilder: Crea o reinicia el carrito de eventos en la sesión.
 * Si el formato cambió (dispensador ↔ muro), empezamos carrito limpio.
 *
 * @param {object} session - Sesión del cliente
 * @param {string} formatKey - 'dispensador' | 'muro'
 */
function ensureEventOrderBuilder(session, formatKey) {
  if (!session.orderBuilder || session.orderBuilder.type !== formatKey) {
    session.orderBuilder = {
      type: formatKey,
      products: {},
      extras: {},
      clientData: {
        date: session.date || null,
        location: session.location || null,
        guests: session.guests || null
      }
    };
  }
}

/**
 * formatEventCartSummary: Lista el carrito actual con precios unitarios.
 *
 * @param {object} products - Carrito { "Mojito::10L": { name, quantity, litrage } }
 * @param {string} formatKey - Clave de precios
 * @returns {string}
 */
function formatEventCartSummary(products, formatKey) {
  let reply = '';
  for (const entry of Object.values(products)) {
    const price = preciosData.cocteles[entry.name]?.[formatKey]?.[entry.litrage] || 0;
    reply += `- ${entry.quantity}x ${entry.name} (${entry.litrage}): ${formatPrice(price * entry.quantity)}\n`;
  }
  return reply;
}

/**
 * buildEventQuoteFromSession: Calcula cotización con OrderBuilder + datos de sesión.
 *
 * @param {object} session - Sesión del cliente
 * @returns {{ quote: object, deliveryCost: number|null, formatKey: string }}
 */
function buildEventQuoteFromSession(session) {
  const formatKey = getEventFormatKey(session.eventoFormato);
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  orderBuilder.products = session.orderBuilder?.products || {};
  orderBuilder.extras = session.orderBuilder?.extras || {};

  // Despacho/logística: solo si conocemos la comuna en RM
  let deliveryCost = null;
  if (session.location) {
    const locationSearch = findLocationByFuzzyMatch(session.location);
    if (locationSearch?.isRM && locationSearch.deliveryCost?.evento != null) {
      deliveryCost = locationSearch.deliveryCost.evento;
    }
  }

  const quote = orderBuilder.calculateQuote(deliveryCost);
  return { quote, deliveryCost, formatKey };
}

export const eventosStates = {

  // ==============================================================================
  // FILTRO DE CANAL (¿web o WhatsApp?)
  // promptQuestion viene en 2 bloques (formatos + pregunta) vía getWelcomeEventos().
  // ==============================================================================
  EVENTOS_FILTRO_CANAL: {
    id: 'EVENTOS_FILTRO_CANAL',
    promptQuestion: () => getWelcomeEventos(),
    shortQuestion: `¿Prefieres cotizar en la página web o los cotizamos juntos por este chat?`,
    aiContextPrompt: STATE_PROMPTS.EVENTOS_FILTRO_CANAL,

    async validateAndProcess(messageText, session) {
      const normalizedMessage = messageText.toLowerCase();

      // Detectar si quiere ir a la web (y NO quiere seguir por chat)
      const wantsWeb = /web|link|pagina|sitio/i.test(normalizedMessage)
        && !/chat|whatsapp|aqui|por aqui/i.test(normalizedMessage);

      // Palabras que indican "sigamos por aquí" (incluye "no" cuando el bot preguntó web vs chat).
      // "aka" = typo frecuente de "acá" (mismo criterio que en barriles).
      // NO incluir precio/valor/cuánto: eso es duda → FAQ/IA, no avance de canal.
      const wantsWhatsapp = /^no$|aqui|aca|aka|chat|whatsapp|ayuda|ayudar|ayudando|por favor|porfa|dime|muestra|catalogo|quiero|si|sigamos|seguimos|seguir|continuar/i.test(normalizedMessage);

      if (wantsWeb) {
        return {
          success: true,
          nextState: 'CERRADO',
          customReply: `¡Buenísimo! Si tienes alguna pregunta mientras cotizas, me escribes por aquí y te ayudo con gusto. 🥂`,
          mute: true
        };
      }

      if (wantsWhatsapp) {
        return { success: true, nextState: 'EVENTOS_RECOGIDA_DATOS' };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // RECOGIDA DE DATOS DEL EVENTO (qué celebra, invitados, fecha, comuna)
  // Igual que el carrito de cócteles: el cliente puede mandar todo junto o de a uno.
  // Guardamos lo que venga en sesión y pedimos SOLO lo que falta.
  // ==============================================================================
  EVENTOS_RECOGIDA_DATOS: {
    id: 'EVENTOS_RECOGIDA_DATOS',
    promptQuestion: () => [
      `¡Excelente! 🎉 Para poder asesorarte bien, por favor cuéntame sobre tu evento:

- ¿Qué celebras?
- ¿Cuántos invitados serán aprox?
- ¿Para qué fecha?
- ¿En qué comuna se realizará?`,
      `Puedes escribirlo así: _"matrimonio, 50 invitados, 15 de mayo, Las Condes"_`
    ],
    // Solo invitados es obligatorio para avanzar; celebración/fecha/comuna son bonus
    shortQuestion: (session) => {
      if (!session.guests) return `¿Cuántos invitados serán aproximadamente?`;
      return `¿Me confirmas los datos del evento para seguir?`;
    },
    aiContextPrompt: STATE_PROMPTS.EVENTOS_RECOGIDA_DATOS_DUDAS,

    async validateAndProcess(messageText, session) {
      // Extraemos lo que venga (puede ser 1 dato o varios)
      const hasNewInfo = applyEventDataFromMessage(messageText, session);
      const guestsJustParsed = /\b(\d+)\s*(personas|invitados|pax|inv)?\b/i.test(
        messageText.replace(/\b\d+\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi, "")
      );

      // --- Pregunta de precios sin datos → web, pero seguimos en este estado ---
      const isAskingForPriceWithoutData = /precio|precios|cu[aá]nto|cuanto|valor|vale|cat[aá]logo|carta|lista/i.test(messageText)
        && !session.guests
        && !guestsJustParsed;
      if (isAskingForPriceWithoutData) {
        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReplies: [
            `¡Claro! La forma más rápida de ver todos los precios y armar tu cotización en tiempo real es directamente en nuestra web: https://cocktailsontap.cl/eventos 🍸

Allí puedes elegir el formato, los cócteles y los litros que necesitas, y ver el total al instante. Si surge cualquier duda, estaremos atentos aquí para ayudarte. 🙌`,
            `Para seguir por aquí, ¿cuántos *invitados* serán aproximadamente?`
          ]
        };
      }

      // --- Con invitados → resumen para confirmar (ok) antes de recomendar formato ---
      if (session.guests) {
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_DATOS',
          customReplies: getEventDataSummary(session)
        };
      }

      // --- Parcial sin invitados (ej. solo "cumpleaños") → pedir SOLO invitados ---
      if (hasNewInfo) {
        const got = [];
        if (session.celebrationType) got.push(`celebración: *${session.celebrationType}*`);
        if (session.date) got.push(`fecha: *${session.date}*`);
        if (session.location) got.push(`comuna: *${session.location}*`);

        const ack = got.length > 0
          ? `Perfecto, anoté ${got.join(', ')}. `
          : `Perfecto. `;

        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReply: `${ack}Para recomendarte el formato, ¿cuántos *invitados* serán aproximadamente?`
        };
      }

      // --- No entendimos nada nuevo → engine: FAQ → IA → re-pregunta ---
      return { success: false };
    }
  },

  // ==============================================================================
  // CONFIRMAR DATOS DEL EVENTO (resumen + ok / corregir)
  // Solo invitados es obligatorio; el resto puede quedar "Por confirmar".
  // Decisión corta → keywords + classifyStepIntent.
  // ==============================================================================
  EVENTOS_CONFIRMAR_DATOS: {
    id: 'EVENTOS_CONFIRMAR_DATOS',
    promptQuestion: (session) => getEventDataSummary(session),
    shortQuestion: `¿Todo bien? Escribe *ok* para continuar o corrige un dato.`,
    aiContextPrompt: STATE_PROMPTS.EVENTOS_CONFIRMAR_DATOS,

    async validateAndProcess(messageText, session) {
      // Primero: ¿está corrigiendo o agregando un dato? (antes que "ok")
      const hasNewInfo = applyEventDataFromMessage(messageText, session);

      // Si aún no hay invitados (caso raro: borró el dato), volvemos a pedirlos
      if (!session.guests) {
        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReply: `Para recomendarte el formato, ¿cuántos *invitados* serán aproximadamente?`
        };
      }

      // Corrigió algo → reenviamos el resumen actualizado (sigue en este estado)
      if (hasNewInfo) {
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_DATOS',
          customReplies: getEventDataSummary(session)
        };
      }

      // ¿Confirma con ok / sí / dale?
      const intent = await resolveDecisionIntent({
        messageText,
        session,
        stepQuestion: eventosStates.EVENTOS_CONFIRMAR_DATOS.shortQuestion,
        allowedLabels: ['CONFIRMAR', 'CORREGIR'],
        labelHints: {
          CONFIRMAR: 'Los datos están bien; quiere seguir (ok, sí, dale, correcto, perfecto).',
          CORREGIR: 'Quiere cambiar algún dato pero aún no dijo el valor nuevo (cambiar, modificar, mal).'
        },
        keywordGuess: () => {
          const lower = messageText.toLowerCase().trim();
          if (/^(ok|okay|si|sí|dale|listo|perfecto|correcto|esta bien|está bien|todo bien|vamos|claro)$/i.test(lower)) {
            return 'CONFIRMAR';
          }
          if (/\b(ok|okay|correcto|esta bien|está bien|todo bien|perfecto|dale|listo)\b/i.test(lower)
              && !/\b(no|mal|cambi|modific|equivoc)\b/i.test(lower)) {
            return 'CONFIRMAR';
          }
          if (/\b(cambi|modific|equivoc|mal|correg)\b/i.test(lower)) return 'CORREGIR';
          return null;
        }
      });

      if (intent === 'CONFIRMAR') {
        const instalacionMuro = formatPrice(preciosData.instalacion_muro || 50000);
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_FORMATO',
          customReplies: getEventFormatRecommendation(session.guests, instalacionMuro)
        };
      }

      // Quiere corregir pero no dio el dato nuevo → pedimos que lo escriba
      if (intent === 'CORREGIR') {
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_DATOS',
          customReply: `Claro, ¿qué dato quieres cambiar? Puedes escribirlo directo (ej: "son 80 invitados", "es en Providencia" o "15 de mayo").`
        };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // ELECCIÓN DE FORMATO (Dispensador vs Muro)
  // Al elegir, NO mostramos carta aún: vamos al pitch + confirmación.
  // ==============================================================================
  EVENTOS_ELECCION_FORMATO: {
    id: 'EVENTOS_ELECCION_FORMATO',
    promptQuestion: () => `Por favor, confírmame si prefieres el *Dispensador Portátil* o el *Muro de Coctelería* para continuar.`,
    shortQuestion: `¿Qué formato prefieres, Dispensador o Muro?`,
    aiContextPrompt: STATE_PROMPTS.EVENTOS_ELECCION_FORMATO_DUDAS,

    async validateAndProcess(messageText, session) {
      const intent = await resolveDecisionIntent({
        messageText,
        session,
        stepQuestion: eventosStates.EVENTOS_ELECCION_FORMATO.shortQuestion,
        allowedLabels: ['DISPENSADOR', 'MURO'],
        labelHints: {
          DISPENSADOR: 'Elige opción 1 / Dispensador Portátil (instalación gratis, mínimo 10L). También: "1", "uno", "primera".',
          MURO: 'Elige opción 2 / Muro de Coctelería (instalación con costo, mínimo 30L). También: "2", "dos", "segunda".'
        },
        keywordGuess: () => {
          const trimmed = messageText.trim();
          // Números y palabras: "1" / "uno" / "primera" → Dispensador; "2" / "dos" / "segunda" → Muro
          if (/^(1|uno|primera?|opci[oó]n\s*1)$/i.test(trimmed)) return 'DISPENSADOR';
          if (/^(2|dos|segunda?|opci[oó]n\s*2)$/i.test(trimmed)) return 'MURO';

          const isMuro = /\bmuro\b/i.test(messageText);
          const isDispensador = /\b(dispensador|portatil|portátil)\b/i.test(messageText);
          if (isMuro && !isDispensador) return 'MURO';
          if (isDispensador && !isMuro) return 'DISPENSADOR';
          if (isMuro) return 'MURO';
          if (isDispensador) return 'DISPENSADOR';
          return null;
        }
      });

      if (intent === 'MURO' || intent === 'DISPENSADOR') {
        session.eventoFormato = intent === 'MURO' ? 'Muro de Coctelería' : 'Dispensador Portátil';
        const formatKey = getEventFormatKey(session.eventoFormato);
        ensureEventOrderBuilder(session, formatKey);

        // Pitch del formato + pregunta "ok para ver carta"
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_FORMATO',
          customReplies: getEventFormatPitch(formatKey)
        };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // CONFIRMAR FORMATO (pitch + ok / cambiar a otro formato)
  // Decisión corta → keywords + classifyStepIntent. NO es paso de datos.
  // ==============================================================================
  EVENTOS_CONFIRMAR_FORMATO: {
    id: 'EVENTOS_CONFIRMAR_FORMATO',
    promptQuestion: (session) => getEventFormatPitch(getEventFormatKey(session.eventoFormato)),
    shortQuestion: `¿Continuamos con este formato? Escribe *ok* o dime si prefieres el otro.`,
    aiContextPrompt: STATE_PROMPTS.EVENTOS_CONFIRMAR_FORMATO,

    async validateAndProcess(messageText, session) {
      const currentKey = getEventFormatKey(session.eventoFormato);

      const intent = await resolveDecisionIntent({
        messageText,
        session,
        stepQuestion: eventosStates.EVENTOS_CONFIRMAR_FORMATO.shortQuestion,
        allowedLabels: ['CONTINUAR', 'CAMBIAR_MURO', 'CAMBIAR_DISPENSADOR'],
        labelHints: {
          CONTINUAR: 'Confirma el formato actual y quiere ver la carta de cócteles (ok, sí, dale, adelante).',
          CAMBIAR_MURO: 'Quiere cambiar al Muro de Coctelería en lugar del Dispensador.',
          CAMBIAR_DISPENSADOR: 'Quiere cambiar al Dispensador Portátil en lugar del Muro.'
        },
        keywordGuess: () => {
          const lower = messageText.toLowerCase();
          const wantsMuro = /\bmuro\b/i.test(lower);
          const wantsDisp = /\b(dispensador|portatil|portátil)\b/i.test(lower);
          const wantsOk = /\b(ok|okay|si|sí|dale|vamos|listo|perfecto|continuar|continuemos|adelante|claro|por\s+favor|porfa)\b/i.test(lower);

          // Cambio explícito de formato (antes que "ok")
          if (wantsMuro && currentKey !== 'muro') return 'CAMBIAR_MURO';
          if (wantsDisp && currentKey !== 'dispensador') return 'CAMBIAR_DISPENSADOR';
          // Si nombra el mismo formato o dice ok → continuar
          if (wantsOk || (wantsMuro && currentKey === 'muro') || (wantsDisp && currentKey === 'dispensador')) {
            return 'CONTINUAR';
          }
          return null;
        }
      });

      // Quiere el otro formato → actualizamos y reenviamos el pitch
      if (intent === 'CAMBIAR_MURO' || intent === 'CAMBIAR_DISPENSADOR') {
        session.eventoFormato = intent === 'CAMBIAR_MURO' ? 'Muro de Coctelería' : 'Dispensador Portátil';
        const formatKey = getEventFormatKey(session.eventoFormato);
        ensureEventOrderBuilder(session, formatKey);
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_FORMATO',
          customReplies: getEventFormatPitch(formatKey)
        };
      }

      // Confirma → carta + sugerencia de litros + pregunta de cócteles
      if (intent === 'CONTINUAR') {
        const formatKey = getEventFormatKey(session.eventoFormato);
        ensureEventOrderBuilder(session, formatKey);
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReplies: buildMenuEntryReplies(session, formatKey)
        };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // SELECCIÓN DE CÓCTELES (NLU + carrito estructurado)
  // Igual patrón que barriles: extraemos productos con IA, guardamos en orderBuilder
  // y solo avanzamos a cotización cuando el carrito cumple el mínimo de litros.
  // ==============================================================================
  EVENTOS_ELECCION_MENU: {
    id: 'EVENTOS_ELECCION_MENU',
    promptQuestion: () => `¿Qué cócteles te gustaría incluir en tu evento? (ej: "Mojito 10L y 1 Aperol 5L")`,
    shortQuestion: `¿Qué cócteles de la carta te gustaría incluir?`,
    aiContextPrompt: STATE_PROMPTS.EVENTOS_ELECCION_MENU_DUDAS,

    async validateAndProcess(messageText, session) {
      const formatKey = getEventFormatKey(session.eventoFormato);
      const minLiters = getMinLitersForFormat(formatKey);
      const allowedLitrages = getAllowedLitrages(formatKey);
      ensureEventOrderBuilder(session, formatKey);

      const catalogNames = Object.keys(preciosData.cocteles || {});
      const isAskingForPrices = /precio|precios|cu[aá]nto|cuanto|valor|cat[aá]logo|lista de precios/i.test(messageText);

      // Pide precios sin nombrar cócteles → sugerimos web
      if (isAskingForPrices && !hasDrinkSelection(messageText) && Object.keys(session.orderBuilder.products).length === 0) {
        const reply = `Para ver todos los precios en detalle y armar tu cotización en tiempo real, puedes hacerlo directamente en nuestra web: https://cocktailsontap.cl/eventos 🍸\n\nSi prefieres continuar aquí, dime qué cócteles te gustaría incluir de la carta y los ajustamos juntos. 😊`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }

      // --- Rama: eliminar productos ("quita el mojito 10L") ---
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
        reply += `¿Quieres eliminar otro, agregar más o *continuamos* con estos? 🍸`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }

      // Último mensaje del bot da contexto a la IA (ej. si el cliente elige una marca)
      let lastBotMessage = "";
      if (session.history?.turns?.length > 0) {
        const botTurns = session.history.turns.filter(t => t.role === 'model');
        if (botTurns.length > 0) lastBotMessage = botTurns[botTurns.length - 1].text;
      }

      // --- Rama: agregar / confirmar con NLU de eventos ---
      let { productos: extractedList, dudas, quiere_avanzar } = await extractEventProductsWithAI(
        messageText,
        catalogNames,
        formatKey,
        lastBotMessage
      );

      // Si el cliente dice que ya terminó y el carrito cumple el mínimo → cotización
      const cartHasItems = Object.keys(session.orderBuilder.products).length > 0;
      const tempBuilder = new OrderBuilder(formatKey, preciosData);
      tempBuilder.products = session.orderBuilder.products;
      const currentLiters = tempBuilder.getTotalLiters();

      if (
        (quiere_avanzar || /^(nada|nada mas|solo esto|solo estos|solo|eso es|listo|ya|fin|sin mas|no hay mas|no quiero mas|continuar|continuamos|avanzar|seguir|siguiente|no)$/i.test(messageText.trim())) &&
        cartHasItems
      ) {
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
            // resolveDoubts no trae litrage; usamos el default del formato
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

        // Corrige "10 de mojito" mal leído como 10 unidades del litraje default
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

        // ¿Existe precio para ese cóctel + litraje en este formato?
        const price = preciosData.cocteles[matchedName]?.[formatKey]?.[litrage];
        if (price == null) {
          invalidLitrages.push({ name: matchedName, litrage });
          continue;
        }

        parsedProducts.push({ name: matchedName, quantity, litrage });
      }

      /**
       * applyProductsToCart: Suma productos al carrito, o reemplaza líneas del mismo
       * cóctel si el cliente está corrigiendo ("me equivoqué, son 10L no 10x").
       *
       * @param {Array<{name: string, quantity: number, litrage: string}>} products
       * @param {boolean} replaceSameName - true = borrar otras líneas de ese nombre primero
       */
      const applyProductsToCart = (products, replaceSameName) => {
        if (replaceSameName) {
          // Sacamos todas las líneas del mismo cóctel (cualquier litraje) antes de poner la correcta
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
      };

      // ¿Está corrigiendo un malentendido? (ej. "me equivoqué, son 10L no 10x")
      const isCorrection = isEventMenuCorrection(messageText);

      if (dudas?.length > 0) {
        // Cuando una palabra puede significar más de un cóctel, pedimos aclaración.
        // Antes guardamos lo que sí quedó claro.
        applyProductsToCart(parsedProducts, isCorrection);
        const duda = dudas[0];
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones) };
      }

      if (parsedProducts.length > 0) {
        applyProductsToCart(parsedProducts, isCorrection);

        const orderBuilder = new OrderBuilder(formatKey, preciosData);
        orderBuilder.products = session.orderBuilder.products;
        const quote = orderBuilder.calculateQuote();
        const totalLiters = orderBuilder.getTotalLiters();

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
          reply += `\n¿Quieres agregar otro sabor o *solo estos*? 🍸`;
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
  },

  // ==============================================================================
  // COTIZACIÓN Y CONFIRMACIÓN (programática, como revisión en barriles)
  // promptQuestion arma el texto con OrderBuilder; validateAndProcess confirma o
  // vuelve a elección de menú si el cliente quiere modificar cócteles.
  // ==============================================================================
  EVENTOS_COTIZACION: {
    id: 'EVENTOS_COTIZACION',
    promptQuestion: (session) => {
      const { quote, deliveryCost } = buildEventQuoteFromSession(session);
      session.orderBuilder = session.orderBuilder || {};
      session.orderBuilder.quote = quote;
      session.quotationGenerated = true;

      return getEventQuotationTemplate(
        {
          eventoFormato: session.eventoFormato,
          celebrationType: session.celebrationType,
          guests: session.guests,
          date: session.date,
          location: session.location
        },
        quote,
        deliveryCost,
        session.isRM
      );
    },
    shortQuestion: `¿Te enviamos los datos de reserva o quieres ajustar algo?`,
    aiContextPrompt: STATE_PROMPTS.EVENTOS_COTIZACION_DUDAS,

    async validateAndProcess(messageText, session) {
      const isRequestingChanges = /cambi|sacar|agrega|modific|ajust|litro|litraje|quita|elimina/i.test(messageText);
      const isConfirming = /(si|sí|ok|perfecto|listo|dale|confirm|esta bien|está bien|todo bien|vamos|súper|super|correcto|excelente|genial|aprob|bueno)/i.test(messageText);

      // Cliente quiere modificar → volvemos a elección de menú con el carrito actual
      if (isRequestingChanges) {
        session.quotationGenerated = false;
        const formatKey = getEventFormatKey(session.eventoFormato);
        const cart = formatEventCartSummary(session.orderBuilder?.products || {}, formatKey);
        const reply = `Claro, ajustemos el menú. Actualmente tienes:\n\n${cart || '_Vacío_\n'}\n¿Qué deseas agregar o eliminar? (ej: "agrega Mojito 10L" o "quita el aperol")`;
        return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
      }

      // Cliente aprueba la cotización → cerramos, silenciamos bot y avisamos al equipo
      if (isConfirming) {
        const { location, date, guests, eventoFormato, celebrationType } = session;
        const quote = session.orderBuilder?.quote;
        const totalStr = quote?.total != null ? formatPrice(quote.total) : 'Revisar chat';
        const formatKey = getEventFormatKey(eventoFormato);

        // Armamos las líneas del menú (nombre + litraje + precio) para no perder la orden
        let adminProducts = '';
        for (const entry of Object.values(session.orderBuilder?.products || {})) {
          const price = preciosData.cocteles[entry.name]?.[formatKey]?.[entry.litrage] || 0;
          adminProducts += `- ${entry.quantity}x ${entry.name} (${entry.litrage}): ${formatPrice(price * entry.quantity)}\n`;
        }

        // Cabecera (cliente WhatsApp) la pone index.js; aquí el cuerpo con la orden
        const alert = {
          type: 'SUCCESS',
          title: 'EVENTOS',
          labelKey: 'cotizacionEventos',
          body: buildAdminEventosOrderBody({
            eventoFormato,
            celebrationType,
            guests,
            location,
            date,
            productsText: adminProducts,
            totalStr
          })
        };

        const closingReply = `✅ Tu cotización quedó registrada.\n\nEn unos minutos uno de nuestros ejecutivos revisará la disponibilidad para esa fecha y te enviará los datos de transferencia.\n\nUna vez confirmado el pago, agendamos formalmente tu evento. 🥂`;

        return {
          success: true,
          nextState: 'CERRADO',
          mute: true,
          notifyAdmin: alert,
          customReply: closingReply
        };
      }

      return { success: false };
    }
  }
};
