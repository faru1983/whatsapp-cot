// ==============================================================================
// OBJETIVO: Implementación y Ejecución de Herramientas (Tool Handlers).
// Conecta el agente IA con el cotizador oficial, el catálogo vivo y el CRM.
// ==============================================================================

import { preciosData, formatPrice, findLocationByFuzzyMatch, normalizeString } from '../../logic/utils.js';
import { getMinLitersForFormat, getAllowedLitrages } from '../../logic/eventos-helpers.js';
import { quoteCatalogShipping, quoteBarrilesDirectShipping, resolveOfficialProductName } from '../../logic/cot-catalog.js';
import { syncCrmEngagedAsync } from '../../logic/cot-crm-sync.js';
import { buildAdminSosBody } from '../../views/templates.js';

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
      const detectedGuests = session?.guests || context.contextMeta?.detectedGuests;
      const detectedDrinks = session?.drinksPerGuest || context.contextMeta?.detectedDrinksPerPerson;

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
"¡Genial! 🍹 Ahora necesitamos definir cuántos tragos quieres calcular por persona:

• *2 tragos p/p:* ideal como complemento de otras bebidas.
• *3 o más tragos p/p:* recomendado si será la barra principal.

*¿Cuántos tragos por persona te gustaría calcular?* _Con eso te entrego un presupuesto estimado._"`
        };
      }

      const guests = Number(detectedGuests);
      const drinksPerPerson = Number(detectedDrinks);
      let formatKey = args.format;

      if (!formatKey || formatKey === 'auto') {
        formatKey = guests >= 80 ? 'muro' : 'dispensador';
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
        // Muro: usa combinaciones de 10L ($119.990), 20L ($169.900) y 30L ($239.990)
        const exactLiters = Math.ceil(totalRequiredDrinks / 5);
        totalLiters = Math.max(30, Math.ceil(exactLiters / 10) * 10);
        
        // Simulación de costo base mínimo de catálogo
        if (totalLiters === 30) {
          estimatedSubtotal = 239990;
          varietiesCount = Math.min(varietiesCount, 2);
        } else if (totalLiters <= 40) {
          estimatedSubtotal = 169900 * 2; // 2 de 20L
          varietiesCount = 2;
        } else if (totalLiters <= 60) {
          estimatedSubtotal = 169900 * 3; // 3 de 20L = 509.700
          varietiesCount = 3;
        } else {
          const count30 = Math.ceil(totalLiters / 30);
          estimatedSubtotal = count30 * 239990;
          varietiesCount = Math.min(4, count30);
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

      const varietiesWord = varietiesCount === 1 ? '1 variedad sugerida' : `${varietiesCount} variedades sugeridas`;
      const formattedProposalText = `*Tu Propuesta de Barra Sugerida* 🍹
Para tus ${guests} invitados y ${drinksPerPerson} tragos por persona, hemos calculado la siguiente configuración ideal:

• Aprox. ${totalCocktails} cócteles
• Equivalente a ${totalLiters} Litros en ${varietiesWord}.

*Presupuesto Estimado*
*${formatPrice(estimatedTotal)}*
Aprox. *${formatPrice(pricePerCocktail)}* por cóctel servido.
_(precios netos, no incluyen IVA)_

Lo mejor es que solo pagas los cócteles que elijas. El servicio incluye sin costo adicional:

🧊 Hielo para todo el evento
🍋 Decoraciones deshidratadas
🥂 Vasos y/o copas en préstamo
🍸 Hieleras y herramientas de bar
🚚 Instalación y retiro incluidos (provincia de Santiago)

📌 *Importante:* Este es un presupuesto estimado. El valor final dependerá de las variedades de cócteles y la cantidad que finalmente elijas.

🤔 *¿Tienes alguna duda o te gustaría que te envíe la lista de variedades disponibles con sus precios?*`;

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
        instruction: `Responde al cliente usando exactamente este texto formateado:\n\n${formattedProposalText}`
      };
    }

    case 'get_available_cocktails_catalog': {
      const guestsKnown = session?.guests || context.contextMeta?.detectedGuests;
      const waitingForFlavors = context.contextMeta?.waitingForFlavors;

      // Salvaguarda: Si no hay invitados ni se estaba en el paso de sabores, es una pregunta general de precios
      if (!guestsKnown && !waitingForFlavors) {
        return {
          success: false,
          instruction: `El cliente preguntó por precios en general pero aún no sabemos si busca Eventos o Barril para la casa. PROHIBIDO entregar una lista de cócteles individuales. Responde exactamente:
"Tenemos 2 modalidades principales:

1. *Servicio para Eventos:* desde *$109.990* 🍹 (incluye 10L ~ 50 cócteles con dispensador portátil instalado, hielo, vasos, garnish e instalación gratuita).
2. *Barriles Desechables de 5L:* desde *$31.990* por barril (~25 cócteles) sellados y listos para servir en casa.

¿Cuál de las dos opciones te interesa para orientarte mejor?"`
        };
      }

      const categoryFilter = String(args.category || 'all').toLowerCase();
      const formatKey = args.format === 'muro' ? 'muro' : 'dispensador';

      const cocteles = preciosData.cocteles || {};
      const clasicos = [];
      const combinados = [];
      const mocktails = [];

      for (const [name, data] of Object.entries(cocteles)) {
        const prices = data[formatKey] || {};
        const priceEntries = Object.entries(prices).map(([size, price]) => `${size}: ${formatPrice(price)}`).join(' | ');
        const itemInfo = `• *${name}* (${priceEntries})`;

        if (/mocktail|sin alcohol/i.test(name)) {
          mocktails.push(itemInfo);
        } else if (/piscola|whiskcola|combinado/i.test(name)) {
          combinados.push(itemInfo);
        } else {
          clasicos.push(itemInfo);
        }
      }

      const formattedCatalogText = `Aquí tienes nuestras variedades más pedidas con sus precios (${formatKey === 'muro' ? 'Muro' : 'Dispensador Portátil'}):

🍹 *Cócteles Clásicos y de Autor:*
${clasicos.slice(0, 8).join('\n')}

🤔 *¿Te gustaría ver también opciones de Combinados (piscolas, whiskcola) o Mocktails (sin alcohol), o qué sabores te gustaría incluir para tu evento?*`;

      return {
        success: true,
        formatKey,
        categories: {
          cocteles: clasicos,
          combinados: combinados,
          mocktails: mocktails
        },
        formattedCatalogText,
        instruction: `Responde al cliente presentando estas variedades:\n\n${formattedCatalogText}`
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
        const coctelData = catalogCocteles[officialName] || catalogCocteles[rawName] || null;

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
        const coctelData = catalogCocteles[officialName] || catalogCocteles[rawName] || null;

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
        const bodyText = `❓ *Pregunta no cubierta:* "${question}"\n\n📌 *Contexto:* ${summaryContext || 'El cliente hizo una consulta que requiere atención de un asesor humano.'}\n\n🤫 *El bot se silenció automáticamente (Mute).*`;
        await alertAdmin({
          type: 'SOS',
          title: 'CONSULTA PENDIENTE DE CLIENTE',
          body: bodyText
        });
      }

      return {
        success: true,
        muted: true,
        message: 'Escalación silenciosa completada. El bot está en silencio y el administrador fue notificado por WhatsApp.'
      };
    }

    default:
      return { success: false, error: `Herramienta desconocida: ${toolName}` };
  }
}
