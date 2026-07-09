import { getWelcomeEventos, getDoubtClarificationTemplate, getEventQuotationTemplate } from '../views/templates.js';
import { STATE_PROMPTS } from '../views/prompts.js';
import {
  findLocationByFuzzyMatch,
  parseClientName,
  parseDate,
  hasDrinkSelection,
  formatPrice,
  preciosData,
  getCartaCocteles,
  findClosestCatalogMatch,
  resolveDoubtsProgrammatically,
  parseEventElimination
} from '../logic/utils.js';
import { extractEventProductsWithAI } from '../core/llm.js';
import { OrderBuilder } from '../logic/order-builder.js';

// ==============================================================================
// OBJETIVO: Flujo B (Servicio para Eventos).
// Guía al cliente desde que elige "eventos" hasta confirmar la cotización:
// 1) Canal web/chat, 2) datos del evento, 3) formato, 4) menú (NLU + carrito),
// 5) cotización programática con OrderBuilder (igual patrón que barriles).
// Cada clave (B1, B2...) es un estado que engine.js ejecuta en orden.
// ==============================================================================

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
        name: session.userName || null,
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

export const flowBStates = {

  // ==============================================================================
  // B1 — FILTRO DE CANAL (¿web o WhatsApp?)
  // ==============================================================================
  B1_FILTRO_CANAL_EVENTOS: {
    id: 'B1_FILTRO_CANAL_EVENTOS',
    promptQuestion: () => getWelcomeEventos(),
    shortQuestion: `¿Prefieres cotizar en la página web o los cotizamos juntos por este chat?`,
    aiContextPrompt: STATE_PROMPTS.B1_FILTRO_CANAL_EVENTOS,

    async validateAndProcess(messageText, session) {
      const normalizedMessage = messageText.toLowerCase();

      // Detectar si quiere ir a la web (y NO quiere seguir por chat)
      const wantsWeb = /web|link|pagina|sitio/i.test(normalizedMessage)
        && !/chat|whatsapp|aqui|por aqui/i.test(normalizedMessage);

      // Palabras que indican "sigamos por aquí" (incluye "no" cuando el bot preguntó web vs chat)
      const wantsWhatsapp = /^no$|aqui|aca|chat|whatsapp|ayuda|ayudar|ayudando|por favor|porfa|dime|muestra|catalogo|quiero|si|sigamos|seguimos|seguir|continuar|precio|valor|cuesta|cuanto/i.test(normalizedMessage);

      if (wantsWeb) {
        return {
          success: true,
          nextState: 'CERRADO',
          customReply: `¡Buenísimo! Te dejo el link directo: https://cocktailsontap.cl/eventos\nSi tienes alguna pregunta mientras cotizas, me escribes por aquí y te ayudo con gusto. 🥂`,
          mute: true
        };
      }

      if (wantsWhatsapp) {
        return { success: true, nextState: 'B2_RECOGIDA_DATOS_EVENTOS' };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // B2 — DATOS DEL EVENTO (invitados, fecha, comuna)
  // ==============================================================================
  B2_RECOGIDA_DATOS_EVENTOS: {
    id: 'B2_RECOGIDA_DATOS_EVENTOS',
    promptQuestion: () => `¡Excelente! 🎉 Para poder asesorarte bien, por favor cuéntame sobre tu evento:\n\n- ¿Cuántos invitados esperas aproximadamente?\n- ¿Para qué fecha lo tienes planeado?\n- ¿En qué comuna se realizará?\n\nPuedes escribirlo así: "50 invitados, 15 de mayo, Las Condes"`,
    shortQuestion: `¿Me ayudas con la comuna, fecha e invitados?`,
    aiContextPrompt: STATE_PROMPTS.B1_DETALLES_EVENTO_DUDAS,

    async validateAndProcess(messageText, session) {
      // --- Extraer ubicación con búsqueda flexible en datos.json ---
      const locationSearch = findLocationByFuzzyMatch(messageText);
      if (locationSearch) {
        session.location = locationSearch.name;
        session.isRM = locationSearch.isRM;       // ¿Está en Región Metropolitana?
        session.region = locationSearch.region;
      } else {
        // Plan B: buscar patrón "en Las Condes" si el fuzzy match no encontró nada
        const locationMatch = messageText.match(/\ben\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)\b/i);
        if (locationMatch && !/el|la|un|una|mi|casa/i.test(locationMatch[1])) {
          session.location = locationMatch[1].trim();
          session.isRM = false;
          session.region = null;
        }
      }

      // Nombre y fecha son opcionales en este paso pero los guardamos si aparecen
      const nameSearch = parseClientName(messageText);
      if (nameSearch && !session.userName) session.userName = nameSearch;

      const dateSearch = parseDate(messageText);
      if (dateSearch && !session.date) session.date = dateSearch;

      // Quitamos fechas del texto para no confundir "15 de mayo" con cantidad de invitados
      const cleanText = messageText.replace(/\b\d+\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi, "");
      const guestsMatch = cleanText.match(/\b(\d+)\s*(personas|invitados|pax|inv)?\b/i);

      // Si pide precios sin dar datos del evento, redirigimos a la web pero seguimos en este estado
      const isAskingForPriceWithoutData = /precio|precios|cu[aá]nto|cuanto|valor|vale|cat[aá]logo|carta|lista/i.test(messageText) && !guestsMatch;
      if (isAskingForPriceWithoutData) {
        const reply = `¡Claro! La forma más rápida de ver todos los precios y armar tu cotización en tiempo real es directamente en nuestra web: https://cocktailsontap.cl/eventos 🍸\n\nAllí puedes elegir el formato, los cócteles y los litros que necesitas, y ver el total al instante. Si surge cualquier duda, estaremos atentos aquí para ayudarte. 🙌\n\nPara seguir por aquí, cuéntame: ¿cuántos invitados, qué fecha y en qué comuna será tu evento?`;
        return { success: true, nextState: 'B2_RECOGIDA_DATOS_EVENTOS', customReply: reply };
      }

      // Cuando tenemos cantidad de invitados, calculamos litros estimados y recomendamos formato
      if (guestsMatch) {
        session.guests = parseInt(guestsMatch[1], 10);

        // Fórmula: invitados × tragos por persona × 0.2 (litros por trago), redondeado a múltiplos de 5L
        const tranquilo = Math.ceil((session.guests * 2 * 0.2) / 5) * 5;
        const fiesta = Math.ceil((session.guests * 4 * 0.2) / 5) * 5;
        const calcText = `*Cálculo de Consumo Estimado:*\n- *Opción Tranquila* (2 a 3 tragos por persona): Necesitarás aprox. *${tranquilo} litros* de cóctel en total.\n- *Opción Fiesta* (3 a 5 tragos por persona): Necesitarás aprox. *${fiesta} litros* de cóctel en total.`;

        const warningText = `Ojo: Siempre recomendamos reservar con un mínimo de 1 semana de anticipación. (disponibilidad sujeta a confirmación)\n\n`;

        // Menos de 100 invitados → Dispensador; más → Muro (regla de negocio)
        const recomendacion = session.guests < 100 ? '*Dispensador Portátil*' : '*Muro de Coctelería*';

        const reply = `${warningText}¡Genial${session.userName ? ', ' + session.userName : ''}! Para tu evento de ${session.guests} invitados, te recomendamos nuestro ${recomendacion}. De todas formas, aquí tienes ambas opciones para que elijas la que más te guste:\n\n1. *Dispensador Portátil*: Instalación gratuita, pedido mínimo 10L.\n2. *Muro de Coctelería*: Instalación ${formatPrice(preciosData.instalacion_muro || 50000)}, pedido mínimo 30L.\n\n${calcText}\n\n¿Qué formato prefieres para tu celebración? (Dispensador o Muro)`;

        return { success: true, nextState: 'B3_ELECCION_FORMATO', customReply: reply };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // B3 — ELECCIÓN DE FORMATO (Dispensador vs Muro)
  // ==============================================================================
  B3_ELECCION_FORMATO: {
    id: 'B3_ELECCION_FORMATO',
    promptQuestion: () => `Por favor, confírmame si prefieres el *Dispensador Portátil* o el *Muro de Coctelería* para continuar.`,
    shortQuestion: `¿Qué formato prefieres, Dispensador o Muro?`,
    aiContextPrompt: STATE_PROMPTS.B1_5_ELECCION_FORMATO_DUDAS,

    async validateAndProcess(messageText, session) {
      const isMuro = /muro/i.test(messageText);
      const isDispensador = /dispensador|portatil|portátil/i.test(messageText);

      if (isMuro || isDispensador) {
        session.eventoFormato = isMuro ? 'Muro de Coctelería' : 'Dispensador Portátil';

        // Cada formato tiene mínimos de litros y tamaños de barril distintos
        const minLiters = isMuro ? '30L' : '10L';
        const formatsCompat = isMuro ? '10L, 20L y 30L' : '5L y 10L';
        const formatKey = getEventFormatKey(session.eventoFormato);

        // Inicializamos carrito vacío para este formato
        ensureEventOrderBuilder(session, formatKey);

        const reply = `¡Excelente elección! El ${session.eventoFormato} será un éxito. \nRecuerda que el pedido mínimo para este formato es de *${minLiters}* totales, y los barriles compatibles son de *${formatsCompat}*.\n\nAquí tienes nuestra carta de cócteles:\n\n${getCartaCocteles(formatKey)}`;
        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // B4 — SELECCIÓN DE CÓCTELES (NLU + carrito estructurado)
  // Igual patrón que A3: extraemos productos con IA, guardamos en orderBuilder
  // y solo avanzamos a cotización cuando el carrito cumple el mínimo de litros.
  // ==============================================================================
  B4_ELECCION_MENU: {
    id: 'B4_ELECCION_MENU',
    promptQuestion: () => `¿Qué cócteles te gustaría incluir en tu evento?`,
    shortQuestion: `¿Qué cócteles de la carta te gustaría incluir?`,
    aiContextPrompt: STATE_PROMPTS.B2_ELECCION_MENU_DUDAS,

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
        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
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
        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
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
          return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
        }
        return { success: true, nextState: 'B5_COTIZACION' };
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
      const parsedProducts = [];
      const invalidLitrages = [];
      for (const item of extractedList) {
        if (!item.name || !item.quantity) continue;
        const matchedName = findClosestCatalogMatch(item.name, catalogNames);
        if (!matchedName) continue;

        let litrage = item.litrage || (formatKey === 'muro' ? '10L' : '5L');
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

        parsedProducts.push({ name: matchedName, quantity: item.quantity, litrage });
      }

      if (dudas?.length > 0) {
        // Cuando una palabra puede significar más de un cóctel, pedimos aclaración.
        // Antes guardamos lo que sí quedó claro.
        for (const p of parsedProducts) {
          const key = OrderBuilder.productLineKey(p.name, p.litrage);
          const prev = session.orderBuilder.products[key];
          session.orderBuilder.products[key] = {
            name: p.name,
            litrage: p.litrage,
            quantity: (prev?.quantity || 0) + p.quantity
          };
        }
        const duda = dudas[0];
        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones) };
      }

      if (parsedProducts.length > 0) {
        for (const p of parsedProducts) {
          const key = OrderBuilder.productLineKey(p.name, p.litrage);
          const prev = session.orderBuilder.products[key];
          session.orderBuilder.products[key] = {
            name: p.name,
            litrage: p.litrage,
            quantity: (prev?.quantity || 0) + p.quantity
          };
        }

        const orderBuilder = new OrderBuilder(formatKey, preciosData);
        orderBuilder.products = session.orderBuilder.products;
        const quote = orderBuilder.calculateQuote();
        const totalLiters = orderBuilder.getTotalLiters();

        let reply = `🍹 Te confirmo los cócteles seleccionados:\n\n`;
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

        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
      }

      // Solo litrajes inválidos (sin productos válidos)
      if (invalidLitrages.length > 0) {
        let reply = `Ese litraje no está disponible para ${session.eventoFormato}.\n`;
        reply += `Los barriles compatibles son: *${allowedLitrages.join(', ')}*.\n\n`;
        reply += `¿Me indiques de nuevo el cóctel con un litraje válido? (ej: "Mojito 10L")`;
        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
      }

      return { success: false };
    }
  },

  // ==============================================================================
  // B5 — COTIZACIÓN Y CONFIRMACIÓN (programática, como A4 en barriles)
  // promptQuestion arma el texto con OrderBuilder; validateAndProcess confirma o
  // vuelve a B4 si el cliente quiere modificar cócteles.
  // ==============================================================================
  B5_COTIZACION: {
    id: 'B5_COTIZACION',
    promptQuestion: (session) => {
      const { quote, deliveryCost } = buildEventQuoteFromSession(session);
      session.orderBuilder = session.orderBuilder || {};
      session.orderBuilder.quote = quote;
      session.quotationGenerated = true;

      return getEventQuotationTemplate(
        {
          eventoFormato: session.eventoFormato,
          guests: session.guests,
          date: session.date,
          location: session.location,
          userName: session.userName
        },
        quote,
        deliveryCost,
        session.isRM
      );
    },
    shortQuestion: `¿Te enviamos los datos de reserva o quieres ajustar algo?`,
    aiContextPrompt: STATE_PROMPTS.B5_COTIZACION_DUDAS,

    async validateAndProcess(messageText, session) {
      const isRequestingChanges = /cambi|sacar|agrega|modific|ajust|litro|litraje|quita|elimina/i.test(messageText);
      const isConfirming = /(si|sí|ok|perfecto|listo|dale|confirm|esta bien|está bien|todo bien|vamos|súper|super|correcto|excelente|genial|aprob|bueno)/i.test(messageText);

      // Cliente quiere modificar → volvemos a B4 con el carrito actual visible
      if (isRequestingChanges) {
        session.quotationGenerated = false;
        const formatKey = getEventFormatKey(session.eventoFormato);
        const cart = formatEventCartSummary(session.orderBuilder?.products || {}, formatKey);
        const reply = `Claro, ajustemos el menú. Actualmente tienes:\n\n${cart || '_Vacío_\n'}\n¿Qué deseas agregar o eliminar? (ej: "agrega Mojito 10L" o "quita el aperol")`;
        return { success: true, nextState: 'B4_ELECCION_MENU', customReply: reply };
      }

      // Cliente aprueba la cotización → cerramos, silenciamos bot y avisamos al equipo
      if (isConfirming) {
        const { userName, location, date, guests, eventoFormato } = session;
        const quote = session.orderBuilder?.quote;
        const totalStr = quote?.total != null ? formatPrice(quote.total) : 'Revisar chat';
        const formatKey = getEventFormatKey(eventoFormato);

        let adminProducts = '';
        for (const entry of Object.values(session.orderBuilder?.products || {})) {
          const price = preciosData.cocteles[entry.name]?.[formatKey]?.[entry.litrage] || 0;
          adminProducts += `- ${entry.quantity}x ${entry.name} (${entry.litrage}): ${formatPrice(price * entry.quantity)}\n`;
        }

        const alert = {
          type: 'SUCCESS',
          message: `✅ *NUEVO EVENTO CONFIRMADO*\nCliente: ${userName || 'No informado'}\n\n📋 *Resumen:*\n- Formato: ${eventoFormato || 'No informado'}\n- Invitados: ${guests || 'No informado'}\n- Ubicación: ${location || 'No informado'}\n- Fecha: ${date || 'No informado'}\n\n🍹 *Cócteles:*\n${adminProducts.trim() || '- (ver chat)'}\n\nTotal a facturar: ${totalStr}`
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
