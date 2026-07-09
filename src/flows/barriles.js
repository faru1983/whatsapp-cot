import { 
  getWelcomeBarriles, 
  getCatalogDesechables,
  getDoubtClarificationTemplate,
  getQuotationTemplate
} from '../views/templates.js';
import { STATE_PROMPTS } from '../views/prompts.js';
import { 
  preciosData, 
  normalizeString, 
  formatPrice, 
  parseElimination, 
  findClosestCatalogMatch, 
  resolveDoubtsProgrammatically,
  parseClientName,
  parseDate,
  findLocationByFuzzyMatch,
  getCartaCocteles,
  hasDrinkSelection
} from '../logic/utils.js';
import { extractProductsWithAI } from '../core/llm.js';
import { OrderBuilder } from '../logic/order-builder.js';

// ============================================================================
// OBJETIVO: Flujo A (Barriles Desechables).
// Aquí están todos los pasos para vender barriles por WhatsApp:
// 1) Elegir canal, 2) ver catálogo, 3) armar pedido, 4) pedir datos,
// 5) revisar cotización y 6) confirmar.
// ============================================================================
export const flowAStates = {
  
  // Paso A1: definir si la persona quiere continuar por chat o ir a la web.
  A1_FILTRO_CANAL: {
    id: 'A1_FILTRO_CANAL',
    promptQuestion: () => getWelcomeBarriles(),
    shortQuestion: `¿Prefieres comprar tus barriles ahora mismo por la web o los cotizamos juntos por este chat?`,
    aiContextPrompt: STATE_PROMPTS.A1_FILTRO_CANAL,
    async validateAndProcess(messageText, session) {
      const normalizedMessage = normalizeString(messageText);

      // ¿Quiere ir a la web? (y no dijo que prefiere chat)
      const wantsWeb = /web|link|pagina|sitio/i.test(normalizedMessage) && !/chat|whatsapp|aqui|por aqui/i.test(normalizedMessage);
      // ¿Quiere seguir por WhatsApp? Incluye "no" cuando el bot preguntó web vs aquí
      const wantsWhatsapp = /^no$|aqui|aca|chat|whatsapp|ayuda|ayudar|ayudando|por favor|porfa|dime|muestra|catalogo|quiero|si|sigamos|seguimos|seguir|continuar|precio|valor|cuesta|cuanto/i.test(normalizedMessage);

      // Si elige web, cerramos el flujo de chat para evitar mensajes duplicados.
      if (wantsWeb) {
        return { success: true, nextState: 'CERRADO', customReply: `¡Buenísimo! Te dejo el link: https://cocktailsontap.cl/barriles. Si te surge cualquier duda durante tu compra, me escribes por aquí y te ayudo 🍹`, mute: true };
      } else if (wantsWhatsapp) {
        return { success: true, nextState: 'A2_OFRECER_CATALOGO' };
      }
      return { success: false };
    }
  },

  // Paso A2: confirmar si mostramos catálogo completo o si ya sabe qué pedir.
  A2_OFRECER_CATALOGO: {
    id: 'A2_OFRECER_CATALOGO',
    promptQuestion: () => getCatalogDesechables(),
    shortQuestion: () => `¿Te muestro los barriles disponibles y sus precios o ya sabes qué pedir?`,
    aiContextPrompt: STATE_PROMPTS.A2_OFRECER_CATALOGO,
    async validateAndProcess(messageText, session) {
      // El cliente pide ver precios / catálogo completo
      const wantsFullCatalog = /\b(si|sí|claro|ok|okay|dale|mu[eé]strame|precio|precios|valor|por favor|porfa|todos|todas|todo|lista|cat[áa]logo|menu|opciones|cuales|cu[aá]les|ver)\b/i.test(messageText);

      // Inicializamos estructura de pedido si todavía no existe en sesión.
      if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
        session.orderBuilder = {
          type: 'desechable',
          products: {},
          extras: {},
          clientData: { name: null, date: null, location: null },
        };
      }

      if (wantsFullCatalog) {
        return { success: true, nextState: 'A3_RECOGIDA_PRODUCTOS', customReply: getCartaCocteles() };
      }

      // Cliente no quiere catálogo ni comprar ahora → despedida y reset de sesión
      const refusesCatalog = /\b(no|no\s+gracias|despu[eé]s|luego|en\s+otro\s+momento|nada|cancelar)\b/i.test(messageText.trim());
      if (refusesCatalog) {
         return { success: true, nextState: 'CERRADO', customReply: "¡No hay problema! Si cambias de idea en el futuro, no dudes en escribirnos. ¡Hasta pronto! 🍹", shouldReset: true };
      }

      // Si ya nombra cócteles sin ver catálogo, saltamos directo al paso de productos
      if (hasDrinkSelection(messageText)) {
        return flowAStates.A3_RECOGIDA_PRODUCTOS.validateAndProcess(messageText, session);
      }

      return { success: false };
    }
  },

  // Paso A3: agregar/eliminar productos y resolver dudas de nombres ambiguos.
  A3_RECOGIDA_PRODUCTOS: {
    id: 'A3_RECOGIDA_PRODUCTOS',
    promptQuestion: () => `¿Qué cócteles te gustaría agregar a tu pedido?`,
    shortQuestion: `¿Qué cóctel agregarás, eliminarás o continuamos con estos?`,
    aiContextPrompt: STATE_PROMPTS.A3_RECOGIDA_PRODUCTOS_DUDAS,
    async validateAndProcess(messageText, session) {
      // Asegurar que existe el "carrito" en la sesión del cliente
      if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
        session.orderBuilder = {
          type: 'desechable',
          products: {},
          extras: {},
          clientData: { name: null, date: null, location: null },
        };
      }

      // Pedido de catálogo otra vez (solo si el carrito está vacío)
      const wantsFullCatalog = /\b(si|sí|claro|ok|okay|dale|mu[eé]strame|precio|precios|valor|por favor|porfa|todos|todas|todo|lista|cat[áa]logo|menu|opciones|cuales|cu[aá]les|ver)\b/i.test(messageText);
      if (wantsFullCatalog && Object.keys(session.orderBuilder.products).length === 0) {
        return { success: true, nextState: 'A3_RECOGIDA_PRODUCTOS', customReply: getCartaCocteles() };
      }

      // --- Rama: eliminar productos ("quita 1 mojito") ---
      const eliminationMatch = parseElimination(messageText, session.orderBuilder.products, Object.keys(preciosData.cocteles || {}));
      if (eliminationMatch) {
        const { name, newQty } = eliminationMatch;
        if (newQty > 0) session.orderBuilder.products[name] = newQty;
        else delete session.orderBuilder.products[name];
        
        const orderBuilder = new OrderBuilder('desechable', preciosData);
        orderBuilder.products = session.orderBuilder.products;
        orderBuilder.extras = session.orderBuilder.extras;
        const quote = orderBuilder.calculateQuote();

        let reply = `✅ Eliminado. Ahora tu pedido incluye:\n\n`;
        for (const [pName, qty] of Object.entries(session.orderBuilder.products)) {
          const price = preciosData.cocteles[pName]?.desechable?.["5L"] || 0;
          reply += `- ${qty}x ${pName}: ${formatPrice(price * qty)}\n`;
        }
        reply += `\n*Subtotal de cócteles:* ${formatPrice(quote.subtotal)}\n\n¿Quieres eliminar otro, agregar más cócteles o continuamos con estos? 🍸`;
        return { success: true, nextState: 'A3_RECOGIDA_PRODUCTOS', customReply: reply };
      }

      // --- Rama: agregar productos con IA (NLU híbrido) ---
      const catalogNames = Object.keys(preciosData.cocteles || {});

      // Último mensaje del bot da contexto a la IA (ej. si el cliente elige una marca)
      let lastBotMessage = "";
      if (session.history?.turns?.length > 0) {
        const botTurns = session.history.turns.filter(t => t.role === 'model');
        if (botTurns.length > 0) lastBotMessage = botTurns[botTurns.length - 1].text;
      }

      let { productos: extractedList, dudas, quiere_avanzar } = await extractProductsWithAI(messageText, catalogNames, lastBotMessage);

      // Si el cliente dice que ya terminó de elegir, pasamos a pedir datos.
      if (
        (quiere_avanzar || /^(nada|nada mas|solo esto|solo|eso es|listo|ya|fin|sin mas|no hay mas|no quiero mas|continuar|continuamos|avanzar|seguir|siguiente|no)/i.test(messageText.trim())) &&
        Object.keys(session.orderBuilder.products).length > 0
      ) {
        return { success: true, nextState: 'A3_RECOGIDA_DATOS' };
      }

      // Intentar resolver dudas sin preguntar (ej. "piscola alto" → una sola opción clara)
      if (dudas?.length > 0) {
        const { resolved, remaining } = resolveDoubtsProgrammatically(dudas);
        if (resolved.length > 0) {
          for (const item of resolved) {
            if (!extractedList.find(p => p.name === item.name)) extractedList.push(item);
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

      // Mapear nombres de la IA al catálogo oficial (tolerancia a typos)
      const parsedProducts = {};
      for (const item of extractedList) {
        if (!item.name || !item.quantity) continue;
        const matchedName = findClosestCatalogMatch(item.name, catalogNames);
        if (matchedName) parsedProducts[matchedName] = (parsedProducts[matchedName] || 0) + item.quantity;
      }

      if (dudas?.length > 0) {
        // Cuando una palabra puede significar más de un cóctel, pedimos aclaración.
        const duda = dudas[0];
        if (Object.keys(parsedProducts).length > 0) {
          for (const [pName, pQty] of Object.entries(parsedProducts)) {
            session.orderBuilder.products[pName] = (session.orderBuilder.products[pName] || 0) + pQty;
          }
        }
        return { success: true, nextState: 'A3_RECOGIDA_PRODUCTOS', customReply: getDoubtClarificationTemplate(duda.mencionado, duda.opciones) };
      }

      if (Object.keys(parsedProducts).length > 0) {
        for (const [pName, pQty] of Object.entries(parsedProducts)) {
          session.orderBuilder.products[pName] = (session.orderBuilder.products[pName] || 0) + pQty;
        }

        const orderBuilder = new OrderBuilder('desechable', preciosData);
        orderBuilder.products = session.orderBuilder.products;
        orderBuilder.extras = session.orderBuilder.extras;
        const quote = orderBuilder.calculateQuote();

        let reply = `🍹 Te confirmo los cócteles seleccionados:\n\n`;
        for (const [name, qty] of Object.entries(session.orderBuilder.products)) {
          const price = preciosData.cocteles[name]?.desechable?.["5L"] || 0;
          reply += `- ${qty}x ${name}: ${formatPrice(price * qty)}\n`;
        }
        reply += `\n*Subtotal de cócteles:* ${formatPrice(quote.subtotal)}\n\n¿Quieres agregar otro sabor o *solo estos*? 🍸`;
        return { success: true, nextState: 'A3_RECOGIDA_PRODUCTOS', customReply: reply };
      }

      const refusesCatalog = /\b(no|no\s+gracias|despu[eé]s|luego|en\s+otro\s+momento|nada|cancelar)\b/i.test(messageText.trim());
      if (refusesCatalog && Object.keys(session.orderBuilder.products).length === 0) {
          return { success: true, nextState: 'CERRADO', customReply: "¡No hay problema! Si cambias de idea en el futuro, no dudes en escribirnos. ¡Hasta pronto! 🍹", shouldReset: true };
      }

      return { success: false };
    }
  },



  // Paso A3 (datos): pedir fecha y ubicación para calcular despacho.
  A3_RECOGIDA_DATOS: {
    id: 'A3_RECOGIDA_DATOS',
    promptQuestion: () => `¡Excelente elección! 🤩 Ya casi terminamos, solo necesito dos datos finales para calcular tu cotización:\n\n📝 Por favor indícame:\n- Fecha que los necesitas:\n- Comuna o Ciudad de entrega:\n\n_(Ej: "Para este sábado en Providencia")_`,
    shortQuestion: `¿Me pasas la fecha y comuna o revisamos la cotización?`,
    aiContextPrompt: STATE_PROMPTS.A3_RECOGIDA_DATOS_DUDAS,
    async validateAndProcess(messageText, session) {
      // Extraer nombre, fecha y comuna del mensaje (pueden venir en un solo texto)
      let hasNewInfo = false;
      let parsedName = parseClientName(messageText) || session.orderBuilder.clientData.name;
      const parsedDate = parseDate(messageText) || session.orderBuilder.clientData.date;
      const locationSearch = findLocationByFuzzyMatch(messageText);

      if (parseClientName(messageText)) hasNewInfo = true;
      if (parseDate(messageText)) hasNewInfo = true;
      if (locationSearch) {
        session.orderBuilder.clientData.location = locationSearch.name;
        session.orderBuilder.clientData.locationData = locationSearch;
        hasNewInfo = true;
      }
      if (parsedName) session.orderBuilder.clientData.name = parsedName;
      if (parsedDate) session.orderBuilder.clientData.date = parsedDate;

      const hasAllData = session.orderBuilder.clientData.date && session.orderBuilder.clientData.location;

      // Faltan datos: pedir solo lo que no tenemos, o activar fallback si no entendimos nada
      if (!hasAllData) {
        if (!hasNewInfo) {
          return { success: false };
        } else {
          let missing = [];
          if (!session.orderBuilder.clientData.date) missing.push('✓ Fecha de entrega');
          if (!session.orderBuilder.clientData.location) missing.push('✓ Comuna/Ciudad');

          let reply = `Perfecto, recibí parte de tu información. Me falta:\n\n${missing.join('\n')}\n\n¿Puedes compartirlo?`;
          return { success: true, nextState: 'A3_RECOGIDA_DATOS', customReply: reply };
        }
      }
      
      return { success: true, nextState: 'A4_REVISION_COTIZACION' };
    }
  },

  // Paso A4: mostrar cotización final y preguntar confirmación.
  A4_REVISION_COTIZACION: {
    id: 'A4_REVISION_COTIZACION',
    promptQuestion: (session) => {
      // Al entrar en A4, calculamos la cotización y la guardamos en sesión
      const orderBuilder = new OrderBuilder('desechable', preciosData);
      orderBuilder.products = session.orderBuilder.products;
      orderBuilder.extras = session.orderBuilder.extras;
      const locationData = session.orderBuilder.clientData.locationData;
      const deliveryCost = locationData?.deliveryCost?.desechable || null;

      const quote = orderBuilder.calculateQuote(deliveryCost);
      session.orderBuilder.quote = quote;
      session.quotationGenerated = true;

      return getQuotationTemplate(session.orderBuilder.clientData, quote, deliveryCost, locationData);
    },
    shortQuestion: `¿Todo bien con la cotización o cambiamos algo?`,
    aiContextPrompt: STATE_PROMPTS.A4_REVISION_COTIZACION,
    async validateAndProcess(messageText, session) {
      const isConfirming = /(si|sí|ok|perfecto|listo|dale|confirm|esta bien|está bien|todo bien|vamos|súper|super|correcto|excelente|genial|aprob|bueno)/i.test(messageText);
      const isModifying = /cambiar|sacar|agregar|quitar|modif|ajust|cantidad|litro|cóctel|coctel|producto|extra|otro/i.test(messageText);

      // Cliente confirma sin pedir cambios → venta cerrada, alerta a admins
      if (isConfirming && !isModifying) {
        const { location, date } = session.orderBuilder.clientData;
        const total = session.orderBuilder.quote?.total;
        const totalStr = total ? formatPrice(total) : 'Revisar chat';

        let adminProducts = '';
        for (const [pName, qty] of Object.entries(session.orderBuilder.products)) {
          const price = preciosData.cocteles[pName]?.desechable?.["5L"] || 0;
          adminProducts += `- ${qty}x ${pName}: ${formatPrice(price * qty)}\n`;
        }

        let adminExtras = '';
        if (Object.keys(session.orderBuilder.extras).length > 0) {
          adminExtras += `\n✨ *Extras:*\n`;
          for (const [eName, qty] of Object.entries(session.orderBuilder.extras)) {
            const price = preciosData.extras[eName] || 0;
            adminExtras += `- ${qty}x ${eName}: ${formatPrice(price * qty)}\n`;
          }
        }

        const alert = {
          type: 'SUCCESS',
          message: `✅ *NUEVA COTIZACIÓN FINALIZADA - BARRILES DESECHABLES*\n\n📋 *Resumen:*\n- Ubicación: ${location}\n- Fecha: ${date}\n\n🍹 *Cócteles:*\n${adminProducts.trim()}\n${adminExtras}\nTotal a facturar: ${totalStr}`
        };

        const closingReply = `✅ Tu pedido quedó registrado.\n\nEn unos minutos uno de nuestros ejecutivos revisará la disponibilidad para esa fecha y te enviará los datos de transferencia.\n\nUna vez confirmado el pago, tu pedido queda agendado. 🍹`;

        return { 
          success: true, 
          nextState: 'CERRADO', 
          mute: true, 
          notifyAdmin: alert,
          customReply: closingReply 
        };
      } else if (isModifying) {
        // Si quiere cambios, lo llevamos a un mini-router de modificaciones.
        session.quotationGenerated = false;
        return { success: true, nextState: 'A4_1_ROUTER_MODIFICACION' };
      }
      return { success: false };
    }
  },

  // Paso A4.1: decide qué quiere modificar (productos o datos).
  A4_1_ROUTER_MODIFICACION: {
    id: 'A4_1_ROUTER_MODIFICACION',
    promptQuestion: () => `Claro, ¿qué deseas cambiar?\n\n1. *Cambiar cócteles* - ¿cuáles deseas en lugar de los actuales?\n2. *Actualizar datos* - ¿Fecha o ubicación?\n\nResponde con 1 o 2 para saber qué necesitas ajustar 🔧`,
    shortQuestion: `¿Responde 1 para cócteles o 2 para datos?`,
    aiContextPrompt: STATE_PROMPTS.A4_1_ROUTER_MODIFICACION,
    async validateAndProcess(messageText, session) {
      const isProductos = /1|coctel|cóctel|bebida|trago/i.test(messageText);
      const isDatos = /2|3|dato|fecha|ubicacion|ubicación/i.test(messageText); // Acepta 3 por compatibilidad

      // Opción 1: volver a editar el carrito de cócteles
      if (isProductos) {
        let reply = `Perfecto, volvamos a los cócteles. Actualmente tienes:\n${Object.entries(session.orderBuilder.products).map(([n,q])=>`- ${q}x ${n}`).join('\n')}\n\n¿Qué deseas agregar o eliminar? (ej: "agrega 1 mojito" o "elimina 1 aperol")`;
        return { success: true, nextState: 'A3_RECOGIDA_PRODUCTOS', customReply: reply };
      }

      // Opción 2: volver a pedir fecha y ubicación (reseteamos esos campos)
      if (isDatos) {
        session.orderBuilder.clientData = { name: null, date: null, location: null };
        return { success: true, nextState: 'A3_RECOGIDA_DATOS' };
      }
      
      return { success: false };
    }
  }
};
