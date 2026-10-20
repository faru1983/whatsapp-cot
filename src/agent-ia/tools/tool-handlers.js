// ==============================================================================
// OBJETIVO: Implementación y Ejecución de Herramientas (Tool Handlers).
// Conecta el agente IA con el cotizador oficial, el catálogo vivo y el CRM.
// ==============================================================================

import { preciosData, formatPrice, findLocationByFuzzyMatch, normalizeString } from '../../logic/utils.js';
import { getMinLitersForFormat, getAllowedLitrages } from '../../logic/eventos-helpers.js';
import { quoteCatalogShipping, quoteBarrilesDirectShipping, resolveOfficialProductName } from '../../logic/cot-catalog.js';
import { syncCrmEngagedAsync } from '../../logic/cot-crm-sync.js';
import { buildAdminSosBody } from '../../views/templates.js';
import { buildCatalogFollowUpBubble } from '../catalog-example.js';

/**
 * executeAgentTool: Ejecuta una tool invocada por el modelo.
 * 
 * @param {string} toolName - Nombre de la tool
 * @param {object} args - Argumentos enviados por el LLM
 * @param {object} context - Contexto de ejecución { session, sessionId, alertAdmin, applyBusinessLabel }
 * @returns {Promise<object>} Resultado estructurado para el LLM
 */
export async function executeAgentTool(toolName, args, context = {}) {
  const { session, sessionId, alertAdmin, applyBusinessLabel } = context;

  switch (toolName) {
    case 'calculate_event_estimate': {
      const detectedGuests = session?.guests || context.contextMeta?.detectedGuests || args.guests;
      const detectedDrinks = session?.drinksPerGuest || context.contextMeta?.detectedDrinksPerPerson || args.drinksPerPerson;

      if (!detectedGuests || detectedGuests <= 0) {
        return {
          success: false,
          instruction: 'El cliente NO ha indicado el número de invitados en la conversación. PROHIBIDO hacer cálculos o pedir tragos por persona. Responde directamente la duda o consulta que hizo el cliente (ej: explicando el servicio o precios) y pregúntale amablemente: "¿Cuántos invitados aproximadamente tendrás en tu evento?"'
        };
      }

      if (!detectedDrinks || detectedDrinks <= 0) {
        return {
          success: false,
          needsDrinksPerPerson: true,
          instruction: `El cliente indicó ${detectedGuests} invitados, pero AÚN NO HA INDICADO los tragos por persona. Tu respuesta obligatoria ahora debe ser:
"¡Súper! 🍹 Ahora definamos el consumo por persona para calcular los litros ideales:

• *2 tragos p/p:* ideal como complemento si habrá cerveza, vino u otras bebidas.
• *3 o más tragos p/p:* recomendado si será la barra principal de la fiesta.

*¿Cuántos tragos por persona te gustaría calcular?*"`
        };
      }

      const guests = Number(detectedGuests);
      const drinksPerPerson = Number(detectedDrinks);
      let formatKey = args.format;

      if (!formatKey || formatKey === 'auto') {
        formatKey = session?.eventFormat || (args.format && args.format !== 'auto' ? args.format : 'dispensador');
      }

      const totalRequiredDrinks = Math.ceil(guests * drinksPerPerson);
      const minL = getMinLitersForFormat(formatKey);

      // Regla oficial de negocio: 1 Litro = 5 Cócteles (vaso estándar 200ml)
      // Generamos la combinación óptima de barriles igual que el wizard web
      let targetVarieties = Math.max(1, Math.round(drinksPerPerson));
      if (guests <= 10) targetVarieties = 1;

      // Cálculo de litros necesarios en múltiplos de barril
      let totalLiters = 0;
      let estimatedSubtotal = 0;
      let varietiesCount = targetVarieties;

      if (formatKey === 'muro') {
        // Muro: usa combinaciones de 10L ($119.990) y 20L ($169.900)
        const exactLiters = Math.ceil(totalRequiredDrinks / 5);
        totalLiters = Math.max(30, Math.ceil(exactLiters / 10) * 10);
        
        // Simulación de costo base mínimo de catálogo
        if (totalLiters === 30) {
          estimatedSubtotal = 169900 + 119990; // 20L + 10L = 289.890
          varietiesCount = Math.min(varietiesCount, 2);
        } else if (totalLiters === 40) {
          estimatedSubtotal = 169900 * 2; // 2 de 20L
          varietiesCount = 2;
        } else if (totalLiters === 50) {
          estimatedSubtotal = (169900 * 2) + 119990; // 2 de 20L + 1 de 10L = 459.790
          varietiesCount = 3;
        } else if (totalLiters === 60) {
          estimatedSubtotal = 169900 * 3; // 3 de 20L = 509.700
          varietiesCount = 3;
        } else {
          const count20 = Math.floor(totalLiters / 20);
          const rem = totalLiters % 20;
          estimatedSubtotal = (count20 * 169900) + (rem >= 10 ? 119990 : 0);
          varietiesCount = Math.min(4, count20 + (rem > 0 ? 1 : 0));
        }
      } else {
        // Dispensador Portátil: usa barriles de 5L ($69.990) y 10L ($109.990)
        const exactLiters = Math.ceil(totalRequiredDrinks / 5);
        totalLiters = Math.max(10, Math.ceil(exactLiters / 5) * 5);

        if (totalLiters === 10) {
          estimatedSubtotal = 109990;
          varietiesCount = 1;
        } else if (totalLiters === 15) {
          estimatedSubtotal = 109990 + 69990; // 179.980
          varietiesCount = 2;
        } else if (totalLiters === 20) {
          estimatedSubtotal = 109990 * 2; // 219.980
          varietiesCount = 2;
        } else if (totalLiters === 25) {
          estimatedSubtotal = (109990 * 2) + 69990; // 289.970
          varietiesCount = 2;
        } else {
          const count10 = Math.ceil(totalLiters / 10);
          estimatedSubtotal = count10 * 109990;
          varietiesCount = Math.min(3, count10);
        }
      }

      const totalCocktails = totalLiters * 5;
      const estimatedTotal = estimatedSubtotal;
      const pricePerCocktail = Math.round(estimatedTotal / totalCocktails);
      const formatLabel = formatKey === 'muro' ? 'Muro de Coctelería' : 'Dispensador Portátil';

      if (session) {
        session.eventFormat = formatKey;
        session.lastEstimatedSubtotal = estimatedSubtotal;
        session.lastEstimatedTotal = formatPrice(estimatedTotal);
        session.lastCocktailsCount = totalCocktails;
        session.lastTotalLiters = totalLiters;
        session.proposalDelivered = true;
      }

      const bubble1 = `*Tu Propuesta de Barra Sugerida* 🍹

Para poder brindar a *${guests} invitados* un promedio de *${drinksPerPerson} tragos p/p* necesitamos:

• *${totalCocktails} cócteles*, esto equivale a *${totalLiters} Litros*.

*Presupuesto Estimado:* *${formatPrice(estimatedTotal)}*
• *Costo por trago:* Solo *${formatPrice(pricePerCocktail)}* por trago servido.
_(¡Te sale a solo ${formatPrice(pricePerCocktail)} por trago con todo el servicio incluido: barra, hielo, vasos y garnish!)_

*Servicio Todo Incluido ($0 adicional):*

🧊 Hielo suficiente para todo el evento
🍋 Decoraciones deshidratadas (garnish)
🥂 Vasos desechables o cristalería premium en préstamo
🍸 Herramientas de bar (bombillas, palas, pinzas, hieleras, etc.)`;

      const bubble2 = `🍸 *¡Ahora viene la mejor parte: armar tu barra!*

Puedes elegir entre nuestros cócteles clásicos, combinados o sin alcohol (Mojito, Sangría, Caipiriña, Pisco Sour, Aperol, Ramazzotti y más).

*¿Te gustaría que te comparta la carta de variedades disponibles?*`;

      const formattedProposalText = `${bubble1}\n\n===BURBUJA===\n\n${bubble2}`;

      return {
        success: true,
        guests,
        drinksPerPerson,
        totalCocktails,
        totalLiters,
        varietiesCount,
        formatKey,
        formatLabel,
        estimatedTotal,
        estimatedTotalFormatted: formatPrice(estimatedTotal),
        pricePerCocktail,
        pricePerCocktailFormatted: formatPrice(pricePerCocktail),
        formattedProposalText,
        instruction: `Responde al cliente usando exactamente este texto formateado en 2 burbujas:\n\n${formattedProposalText}`
      };
    }

    case 'send_cocktails_catalog':
    case 'get_available_cocktails_catalog': {
      const guests = session?.guests || 20;
      const drinks = session?.drinksPerGuest || 3;
      const calcLiters = Math.max(10, Math.ceil((guests * drinks * 0.2) / 5) * 5);
      const liters = session?.lastTotalLiters || session?.cartLiters || calcLiters;

      const bubble1 = `[IMG:lista_precios_completa.webp]`;
      const bubble2 = buildCatalogFollowUpBubble(session);

      const formattedCatalogText = `${bubble1}\n\n===BURBUJA===\n\n${bubble2}`;

      if (session) {
        session.catalogSent = true;
      }

      return {
        success: true,
        liters,
        formattedCatalogText,
        instruction: `Responde exactamente enviando la carta de variedades:\n\n${formattedCatalogText}`
      };
    }

    case 'build_custom_cart_quote': {
      const guests = session?.guests || 20;
      const drinksPerGuestTarget = session?.drinksPerGuest || 4;
      const formatKey = args.format === 'muro' ? 'muro' : (session?.eventFormat || 'dispensador');
      const rawItems = Array.isArray(args.items) ? args.items : [];

      let totalLiters = 0;
      let total = 0;
      const lineDetails = [];

      for (const item of rawItems) {
        const rawName = String(item.flavor || '').trim();
        const officialName = resolveOfficialProductName(rawName);
        const liters = Number(item.liters) || 10;
        const sizeLabel = `${liters}L`;

        const catalogCocteles = preciosData.cocteles || {};
        const lookupKey = officialName === 'Mojito Tradicional' ? 'Mojito' : officialName;
        const coctelData = catalogCocteles[lookupKey] || catalogCocteles[officialName] || catalogCocteles[rawName] || null;

        let unitPrice = 0;
        if (coctelData && coctelData[formatKey] && coctelData[formatKey][sizeLabel]) {
          unitPrice = coctelData[formatKey][sizeLabel];
        } else {
          if (formatKey === 'muro') {
            unitPrice = liters === 10 ? 119990 : liters === 20 ? 169900 : 239990;
          } else {
            unitPrice = liters === 5 ? 69990 : liters === 10 ? 109990 : (Math.ceil(liters / 10) * 109990);
          }
        }

        total += unitPrice;
        totalLiters += liters;
        lineDetails.push({
          flavor: officialName,
          liters,
          unitPrice,
          unitPriceFormatted: formatPrice(unitPrice)
        });
      }

      const totalCocktails = totalLiters * 5;
      const drinksPerPersonCalculated = guests > 0 ? (Math.round((totalCocktails / guests) * 10) / 10) : drinksPerGuestTarget;
      const pricePerCocktail = totalCocktails > 0 ? Math.round(total / totalCocktails) : 2200;

      const itemsText = lineDetails
        .map((it) => `• *${it.liters}L* ${it.flavor}: *${it.unitPriceFormatted}*`)
        .join('\n');

      const formattedCartText = `*Resumen de tu Barra Personalizada* 🍸

${itemsText}

*TOTAL:* *${formatPrice(total)}* (neto)
• *Costo por trago:* Solo *${formatPrice(pricePerCocktail)}* por trago servido.
📊 _${totalCocktails} cócteles | ${drinksPerPersonCalculated} tragos p/p | ${formatPrice(pricePerCocktail)} por trago_

*Servicio Todo Incluido ($0 adicional):*
• Dispensador portátil listo para servir
• Hielo suficiente para todo el evento
• Vasos en préstamo, garnish y herramientas de bar

*¿Te parece bien esta selección o te gustaría ajustar alguna variedad?*`;

      if (session) {
        session.cartSummary = formattedCartText;
        session.cartItems = lineDetails;
        session.cartTotal = total;
        session.cartTotalFormatted = formatPrice(total);
        session.cartTotalCocktails = totalCocktails;
        session.cartDrinksPerPerson = drinksPerPersonCalculated;
        session.cartPricePerCocktail = pricePerCocktail;
      }

      return {
        success: true,
        items: lineDetails,
        total,
        totalFormatted: formatPrice(total),
        totalLiters,
        totalCocktails,
        drinksPerPersonCalculated,
        pricePerCocktail,
        formattedCartText,
        instruction: `Responde al cliente usando exactamente este texto formateado de carrito:\n\n${formattedCartText}`
      };
    }

    case 'calculate_formal_quote': {
      const formatKey = args.format === 'muro' ? 'muro' : 'dispensador';
      const items = Array.isArray(args.items) ? args.items : [];
      const guests = Number(args.guests) || 0;
      const comunaInput = String(args.comuna || '').trim();

      let subtotal = 0;
      let totalLiters = 0;
      const lineDetails = [];

      for (const item of items) {
        const rawName = String(item.flavor || '').trim();
        const officialName = resolveOfficialProductName(rawName);
        const liters = Number(item.liters) || 5;
        const sizeLabel = `${liters}L`;

        const catalogCocteles = preciosData.cocteles || {};
        const lookupKey = officialName === 'Mojito Tradicional' ? 'Mojito' : officialName;
        const coctelData = catalogCocteles[lookupKey] || catalogCocteles[officialName] || catalogCocteles[rawName] || null;

        let unitPrice = 0;
        if (coctelData && coctelData[formatKey] && coctelData[formatKey][sizeLabel]) {
          unitPrice = coctelData[formatKey][sizeLabel];
        } else {
          // Fallback proporcional razonable si no está exacto
          unitPrice = liters === 5 ? 79990 : liters === 10 ? 119990 : liters === 20 ? 189990 : 254990;
        }

        subtotal += unitPrice;
        totalLiters += liters;
        lineDetails.push({
          flavor: officialName,
          liters,
          unitPrice,
          unitPriceFormatted: formatPrice(unitPrice)
        });
      }

      const installationCost = formatKey === 'muro' ? 50000 : 0;
      
      // Cálculo de flete
      let shippingCost = 0;
      let shippingLabel = 'Gratis';
      if (comunaInput) {
        const shippingRes = quoteCatalogShipping({
          serviceType: 'event',
          comunaName: comunaInput,
          totalLiters
        });
        if (shippingRes && !shippingRes.isPending) {
          shippingCost = shippingRes.cost || 0;
          shippingLabel = shippingRes.label || (shippingCost === 0 ? '¡Gratis!' : formatPrice(shippingCost));
        } else {
          // Revisión local RM
          const locHit = findLocationByFuzzyMatch(comunaInput);
          if (locHit?.deliveryCost?.evento !== null && locHit?.deliveryCost?.evento !== undefined) {
            shippingCost = locHit.deliveryCost.evento;
            shippingLabel = shippingCost === 0 ? '¡Gratis!' : formatPrice(shippingCost);
          } else {
            shippingLabel = 'Por confirmar (fuera de RM)';
          }
        }
      }

      const total = subtotal + installationCost + shippingCost;
      const totalCocktails = totalLiters * 5;
      const formatLabel = formatKey === 'muro' ? 'Muro de Coctelería' : 'Dispensador Portátil';

      return {
        success: true,
        formatLabel,
        totalLiters,
        totalCocktails,
        lineDetails,
        subtotal,
        subtotalFormatted: formatPrice(subtotal),
        installationCost,
        installationCostFormatted: installationCost === 0 ? '¡Gratis!' : formatPrice(installationCost),
        shippingCost,
        shippingLabel,
        total,
        totalFormatted: formatPrice(total),
        includes: [
          'Hielo en cubo y picado suficiente para todo el evento',
          'Garnish (decoraciones de limón y naranja deshidratadas, menta fresca, bombillas)',
          'Préstamo de vasos y copas de vidrio según los cócteles',
          'Accesorios de bar (hieleras de acero inoxidable, pinzas, palas)',
          'Instalación previa al evento y retiro al día siguiente sin apuros'
        ]
      };
    }

    case 'calculate_direct_sale': {
      const items = Array.isArray(args.items) ? args.items : [];
      const comunaInput = String(args.comuna || '').trim();

      let subtotal = 0;
      let totalBarrels = 0;
      const lineDetails = [];

      for (const item of items) {
        const rawName = String(item.flavor || '').trim();
        const officialName = resolveOfficialProductName(rawName);
        const qty = Math.max(1, Number(item.quantity) || 1);

        const catalogCocteles = preciosData.cocteles || {};
        const lookupKey = officialName === 'Mojito Tradicional' ? 'Mojito' : officialName;
        const coctelData = catalogCocteles[lookupKey] || catalogCocteles[officialName] || catalogCocteles[rawName] || null;

        let unitPrice = 47990;
        if (coctelData?.desechable?.['5L']) {
          unitPrice = coctelData.desechable['5L'];
        } else if (/mocktail|sin alcohol/i.test(officialName)) {
          unitPrice = 31990;
        } else if (/sangr[ií]a/i.test(officialName)) {
          unitPrice = 39990;
        }

        const itemTotal = unitPrice * qty;
        subtotal += itemTotal;
        totalBarrels += qty;
        lineDetails.push({
          flavor: officialName,
          quantity: qty,
          unitPrice,
          unitPriceFormatted: formatPrice(unitPrice),
          total: itemTotal,
          totalFormatted: formatPrice(itemTotal)
        });
      }

      const totalLiters = totalBarrels * 5;
      let shippingCost = 5000;
      let shippingLabel = '$5.000';

      if (comunaInput) {
        const directQuote = quoteBarrilesDirectShipping({
          comunaName: comunaInput,
          totalLiters
        });
        if (directQuote && !directQuote.isPending && directQuote.cost !== null) {
          shippingCost = directQuote.cost;
          shippingLabel = formatPrice(shippingCost);
        } else {
          shippingLabel = 'Por calcular según comuna';
        }
      }

      const total = subtotal + shippingCost;

      return {
        success: true,
        totalBarrels,
        totalLiters,
        totalCocktails: totalLiters * 5,
        lineDetails,
        subtotal,
        subtotalFormatted: formatPrice(subtotal),
        shippingCost,
        shippingLabel,
        total,
        totalFormatted: formatPrice(total)
      };
    }

    case 'sync_lead_crm': {
      if (session) {
        session.userIntent = args.intent === 'direct' ? 'BARRILES' : 'EVENTOS';
        if (args.guests) session.guests = Number(args.guests);
        if (args.comuna) session.location = args.comuna;
        if (args.eventDate) session.date = args.eventDate;

        const extraPayload = {
          agentVersion: 'agent-ia-v2',
          summary: args.summary || ''
        };

        syncCrmEngagedAsync(session, 'intent_selected', extraPayload);

        if (typeof applyBusinessLabel === 'function') {
          await applyBusinessLabel('clientePotencial');
        }
      }
      return {
        success: true,
        message: 'Lead registrado exitosamente en el CRM como Interesado.'
      };
    }

    case 'silent_admin_escalation': {
      const question = String(args.clientQuestion || '').trim();
      const summaryContext = String(args.context || '').trim();

      if (session) {
        session.isMuted = true;
        session.silenciado_timestamp = Date.now();
      }

      if (typeof alertAdmin === 'function') {
        const guests = session?.guests || 'XX';
        const drinks = session?.cartDrinksPerPerson || session?.drinksPerGuest || 'XX';
        const rawDate = session?.eventDate || question || 'por confirmar';
        const date = String(rawDate).replace(/^para\s+el\s+/i, '').replace(/^el\s+/i, '').trim();
        const commune = session?.commune || session?.location || context.contextMeta?.detectedCommune || '';
        const communeStr = commune ? ` en *${commune}*` : '';

        let cartBlock = '';
        if (session?.cartItems && session.cartItems.length > 0) {
          cartBlock = session.cartItems
            .map((it) => `• ${it.liters}L ${it.flavor}: ${it.unitPriceFormatted}`)
            .join('\n');
          cartBlock += `\n💰 *TOTAL:* ${session.cartTotalFormatted || ''} (neto)`;
          cartBlock += `\n📊 _${session.cartTotalCocktails || ''} cócteles | ${drinks} tragos p/p | ${formatPrice(session.cartPricePerCocktail || 2200)} por trago_`;
        } else if (session?.cartSummary) {
          cartBlock = session.cartSummary;
        } else if (session?.lastEstimatedTotal) {
          cartBlock = `• Presupuesto estimado: ${session.lastEstimatedTotal} (${session.lastTotalLiters || 20}L ~ ${session.lastCocktailsCount || 100} cócteles)`;
        } else {
          cartBlock = 'Cotización inicial';
        }

        const bodyText = `Hola, tenemos un cliente interesado en un evento para el *${date}*${communeStr}\n\nSon *${guests} invitados* y le interesa los siguientes cócteles:\n${cartBlock}\n\n_Ya te hice la pega inicial, ahora te toca a ti lograr el cierre. ¡Respóndele rápido!_ 🚀\n\n🤫 *(El bot se silenció en MUTE para que continúes tú directo desde WhatsApp).*`;

        await alertAdmin({
          type: 'SOS',
          title: 'NUEVO EVENTO LISTO PARA CIERRE (MUTE ACTIVO)',
          body: bodyText
        });
      }

      return {
        success: true,
        muted: true,
        silenceClient: true,
        message: 'Escalación silenciosa completada. El bot está en MUTE y el administrador fue notificado. NO envíes ningún mensaje al cliente; guarda absoluto silencio.'
      };
    }

    case 'handle_payment_confirmation': {
      const details = args.details || 'Confirmación de pago recibida';

      if (session) {
        session.isMuted = true;
        session.silenciado_timestamp = Date.now();
        session.paymentConfirmationReceived = true;
        session.allowSingleReply = true;
      }

      if (typeof alertAdmin === 'function') {
        await alertAdmin({
          type: 'SUCCESS',
          title: 'COMPROBANTE DE PAGO RECIBIDO (BARRIL/COMPRA)',
          body: `💰 *Nuevo comprobante de pago recibido de cliente*\n\n💬 *Detalle:* "${details}"\n\n✅ *El bot respondió:* "¡Muchas gracias! Revisamos y te confirmamos enseguida 🍹"\n\n🤫 *El bot quedó silenciado (MUTE) para que verifiques la transferencia en la cuenta y confirmes el pedido directamente desde WhatsApp.*`
        });
      }

      const reply = '¡Muchas gracias! Revisamos y te confirmamos enseguida 🍹';
      return {
        success: true,
        muted: true,
        allowSingleReply: true,
        reply,
        instruction: 'Responde obligatoriamente al cliente con este mensaje exacto:\n\n¡Muchas gracias! Revisamos y te confirmamos enseguida 🍹'
      };
    }

    default:
      return { success: false, error: `Herramienta desconocida: ${toolName}` };
  }
}
