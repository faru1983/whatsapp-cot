// ==============================================================================
// OBJETIVO: Implementación y Ejecución de Herramientas (Tool Handlers).
// Conecta el agente IA con el cotizador oficial, el catálogo vivo y el CRM.
// ==============================================================================

import { preciosData, formatPrice, findLocationByFuzzyMatch, normalizeString, parseDate } from '../../logic/utils.js';
import { getMinLitersForFormat, getAllowedLitrages } from '../../logic/eventos-helpers.js';
import {
  quoteCatalogShipping,
  quoteBarrilesDirectShipping,
  resolveOfficialProductName,
  buildGroupedDispensadorMenuText,
  getDispensadorProductPriceSync
} from '../../logic/cot-catalog.js';
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
      const detectedGuests = args.guests || session?.guests || context.contextMeta?.detectedGuests;
      const verifiedDrinks = session?.drinksPerGuest || context.contextMeta?.detectedDrinksPerPerson;

      if (!detectedGuests || detectedGuests <= 0) {
        return {
          success: false,
          instruction: 'El cliente NO ha indicado el número de invitados en la conversación. PROHIBIDO hacer cálculos o pedir tragos por persona. Responde directamente la duda o consulta que hizo el cliente (ej: explicando el servicio o precios) y pregúntale amablemente: "¿Cuántos invitados aproximadamente tendrás en tu evento?"'
        };
      }

      if (!verifiedDrinks || verifiedDrinks <= 0) {
        const dateStr = session?.eventDate
          ? ` para el *${String(session.eventDate).replace(/^para\s+el\s+/i, '').replace(/^el\s+/i, '').trim()}*`
          : '';
        return {
          success: false,
          needsDrinksPerPerson: true,
          allowSingleReply: true,
          reply: `¡Súper! Anotado${dateStr} con *${detectedGuests} invitados* 🗓️🍹\n\nPara recomendarte la cantidad exacta de litros, cuéntame cómo quieres enfocar la barra:\n• *2 tragos p/p:* ideal como complemento (si habrá cerveza, vino u otras bebidas).\n• *3 o más tragos p/p:* recomendado si seremos la barra principal de la fiesta.\n\n*¿Cuántos tragos por persona te gustaría calcular?*`
        };
      }

      const guests = Number(detectedGuests);
      const drinksPerPerson = Number(verifiedDrinks);
      const formatKey = 'dispensador';

      const totalRequiredDrinks = Math.ceil(guests * drinksPerPerson);

      // Regla oficial de negocio: 1 Litro = 5 Cócteles (vaso estándar 200ml)
      // Dispensador Portátil: usa barriles de 5L ($69.990) y 10L ($109.990), mínimo 10L
      const exactLiters = Math.ceil(totalRequiredDrinks / 5);
      const totalLiters = Math.max(10, Math.ceil(exactLiters / 5) * 5);

      let estimatedSubtotal = 0;
      if (totalLiters === 10) {
        estimatedSubtotal = 109990;
      } else if (totalLiters === 15) {
        estimatedSubtotal = 109990 + 69990; // 179.980
      } else if (totalLiters === 20) {
        estimatedSubtotal = 109990 * 2; // 219.980
      } else if (totalLiters === 25) {
        estimatedSubtotal = (109990 * 2) + 69990; // 289.970
      } else {
        const count10 = Math.floor(totalLiters / 10);
        const rem = totalLiters % 10;
        estimatedSubtotal = (count10 * 109990) + (rem >= 5 ? 69990 : 0);
      }

      const totalCocktails = totalLiters * 5;
      const estimatedTotal = estimatedSubtotal;
      const pricePerCocktail = Math.round(estimatedTotal / totalCocktails);
      const formatLabel = 'Dispensador Portátil';

      if (session) {
        session.guests = guests;
        session.drinksPerGuest = drinksPerPerson;
        session.drinksPerPerson = drinksPerPerson;
        session.eventFormat = 'dispensador';
        session.lastEstimatedSubtotal = estimatedSubtotal;
        session.lastEstimatedTotal = formatPrice(estimatedTotal);
        session.lastCocktailsCount = totalCocktails;
        session.lastTotalLiters = totalLiters;
        session.proposalDelivered = true;
      }

      const bubble1 = `*Tu Medida Recomendada* 🍹

Para *${guests} invitados* calculando *${drinksPerPerson} tragos p/p* (~${totalRequiredDrinks} cócteles), lo ideal son *${totalLiters} Litros (${totalCocktails} cócteles)* combinando barriles de 10L y 5L:

• Opción *${totalLiters}L (${totalCocktails} cócteles):* desde *${formatPrice(estimatedTotal)}* (~*${formatPrice(pricePerCocktail)}* por trago).
• Incluye *100% GRATIS* estación con dispensadores, hielo total, garnish, vasos/copas y montaje/retiro en Provincia de Santiago.`;

      const bubble2 = buildGroupedDispensadorMenuText();

      const formattedProposalText = `${bubble1}\n\n===BURBUJA===\n\n${bubble2}`;

      return {
        success: true,
        guests,
        drinksPerPerson,
        totalCocktails,
        totalLiters,
        formatKey: 'dispensador',
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

      const formattedCatalogText = buildGroupedDispensadorMenuText();

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
      const drinksPerGuestTarget = session?.drinksPerGuest || 3;
      const formatKey = 'dispensador';
      const rawItems = Array.isArray(args.items) ? args.items : [];

      let totalLiters = 0;
      let total = 0;
      const lineDetails = [];

      for (const item of rawItems) {
        const rawName = String(item.flavor || '').trim();
        const officialName = resolveOfficialProductName(rawName);
        const liters = Number(item.liters) === 5 ? 5 : 10;

        const unitPrice = getDispensadorProductPriceSync(officialName, liters);

        total += unitPrice;
        totalLiters += liters;
        lineDetails.push({
          flavor: officialName,
          liters,
          unitPrice,
          unitPriceFormatted: formatPrice(unitPrice)
        });
      }

      // Si por alguna razón el litraje quedó menor a 10L (mínimo oficial), ajustar
      if (totalLiters < 10 && lineDetails.length === 1) {
        // Si pidió solo 1 barril de 5L, advertir o calcular base 10L
        // En carrito de eventos el mínimo es 10L
      }

      const totalCocktails = totalLiters * 5;
      const drinksPerPersonCalculated = guests > 0 ? (Math.round((totalCocktails / guests) * 10) / 10) : drinksPerGuestTarget;
      const pricePerCocktail = totalCocktails > 0 ? Math.round(total / totalCocktails) : 2200;

      const itemsText = lineDetails
        .map((it) => `• *${it.liters}L* ${it.flavor} (${it.liters * 5} cócteles): *${it.unitPriceFormatted}*`)
        .join('\n');

      const rawEventDate = session?.eventDate || context?.contextMeta?.detectedDate;
      const eventDate = rawEventDate ? String(rawEventDate).replace(/^para\s+el\s+/i, '').replace(/^el\s+/i, '').trim() : '';
      const commune = session?.commune || session?.location || context?.contextMeta?.detectedCommune;

      let closingQuestion = '';
      if (eventDate && commune) {
        closingQuestion = `*¿Te parece bien esta combinación para revisar disponibilidad para el ${eventDate} en ${commune}?*`;
      } else if (eventDate) {
        closingQuestion = `*¿En qué comuna de la Región Metropolitana sería el evento para confirmar despacho y disponibilidad para el ${eventDate}?*`;
      } else if (commune) {
        closingQuestion = `*¿Para qué fecha estás pensando tu evento en ${commune} para revisar disponibilidad?*`;
      } else {
        closingQuestion = `*¿Para qué fecha y en qué comuna de la Región Metropolitana sería el evento para revisar disponibilidad?*`;
      }

      let warningMinimum = '';
      if (totalLiters < 10) {
        warningMinimum = `\n⚠️ _Nota: Nuestro servicio de Bar Móvil tiene un pedido mínimo de 10L (50 cócteles), pudiendo combinar 2 sabores de 5L._\n`;
      }

      const formattedCartText = `*Resumen de tu Barra Personalizada* 🍸

${itemsText}
${warningMinimum}
*TOTAL:* *${formatPrice(total)}*
• *Costo por trago:* Solo *${formatPrice(pricePerCocktail)}* por trago servido.
📊 _${totalCocktails} cócteles | ~${drinksPerPersonCalculated} tragos p/p | ${formatPrice(pricePerCocktail)} por trago con todo el servicio GRATIS_

*Servicio Todo Incluido ($0 adicional):*
• Estación autoservicio con dispensadores instalados
• Hielo suficiente para todo el evento
• Préstamo de vasos/copas reutilizables (o desechables), garnish y accesorios
• Montaje y retiro gratis en Provincia de Santiago

${closingQuestion}`;

      if (session) {
        session.cartSummary = formattedCartText;
        session.cartItems = lineDetails;
        session.cartTotal = total;
        session.cartTotalFormatted = formatPrice(total);
        session.cartTotalCocktails = totalCocktails;
        session.cartTotalLiters = totalLiters;
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
        session.userIntent = 'EVENTOS';

        // Auto-sincronizar el lead en el CRM de forma determinista
        const extraPayload = {
          agentVersion: 'agent-ia-v2',
          summary: summaryContext || `Lead eventos: ${session.guests || 'XX'} invitados, fecha ${session.eventDate || 'por confirmar'}`
        };
        syncCrmEngagedAsync(session, 'intent_selected', extraPayload);

        if (typeof applyBusinessLabel === 'function') {
          applyBusinessLabel('clientePotencial').catch(() => {});
        }
      }

      if (typeof alertAdmin === 'function') {
        const guests = session?.guests || 'XX';
        const drinks = session?.cartDrinksPerPerson || session?.drinksPerGuest || 'XX';
        const parsedDateFromQuestion = parseDate(question);
        const rawDate = session?.eventDate || context?.contextMeta?.detectedDate || parsedDateFromQuestion || 'por confirmar';
        const date = String(rawDate).replace(/^para\s+el\s+/i, '').replace(/^el\s+/i, '').trim();
        const commune = session?.commune || session?.location || context?.contextMeta?.detectedCommune || '';
        const communeStr = commune ? ` en *${commune}*` : '';

        let shippingInfo = '';
        if (commune) {
          const totalLitersForShipping = session?.cartTotalLiters || session?.lastTotalLiters || 10;
          const shippingRes = quoteCatalogShipping({
            serviceType: 'event',
            comunaName: commune,
            totalLiters: totalLitersForShipping
          });
          if (shippingRes) {
            shippingInfo = `\n🚚 *Flete ${commune}:* ${shippingRes.label || (shippingRes.cost === 0 ? '¡Gratis!' : formatPrice(shippingRes.cost))}`;
          }
        }

        const isQualifiedBooking = Boolean(session?.cartSummary || session?.cartItems?.length || session?.proposalDelivered);

        let alertTitle = 'NUEVO EVENTO LISTO PARA CIERRE (MUTE ACTIVO)';
        let bodyText = '';

        if (isQualifiedBooking) {
          let cartBlock = '';
          if (session?.cartItems && session.cartItems.length > 0) {
            cartBlock = session.cartItems
              .map((it) => `• ${it.liters}L ${it.flavor}: ${it.unitPriceFormatted}`)
              .join('\n');
            cartBlock += `\n💰 *TOTAL:* ${session.cartTotalFormatted || ''}`;
            cartBlock += `\n📊 _${session.cartTotalCocktails || ''} cócteles | ${drinks} tragos p/p | ${formatPrice(session.cartPricePerCocktail || 2200)} por trago_`;
          } else if (session?.cartSummary) {
            cartBlock = session.cartSummary;
          } else if (session?.lastEstimatedTotal) {
            cartBlock = `• Presupuesto estimado: ${session.lastEstimatedTotal} (${session.lastTotalLiters || 20}L ~ ${session.lastCocktailsCount || 100} cócteles)`;
          } else {
            cartBlock = 'Cotización inicial';
          }

          bodyText = `Hola, tenemos un cliente interesado en un evento para el *${date}*${communeStr}${shippingInfo}\n\nSon *${guests} invitados* y le interesa los siguientes cócteles:\n${cartBlock}\n\n_Ya te hice la pega inicial, ahora te toca a ti lograr el cierre. ¡Respóndele rápido!_ 🚀\n\n🤫 *(El bot se silenció en MUTE para que continúes tú directo desde WhatsApp).*`;
        } else {
          alertTitle = 'CONSULTA DE CLIENTE ESCALADA A ADMIN (MUTE ACTIVO)';
          bodyText = `El cliente escribió: "${question || summaryContext}"\n\nEstado: Sin carrito armado aún.\nInvitados: ${guests !== 'XX' ? guests : 'Por definir'}, Fecha: ${date}${communeStr}.\n\n🤫 *(El bot se silenció en MUTE para que continúes tú directo desde WhatsApp).*`;
        }

        await alertAdmin({
          type: 'SOS',
          title: alertTitle,
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
