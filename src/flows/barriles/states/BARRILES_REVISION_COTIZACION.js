// ==============================================================================
// OBJETIVO: Paso BARRILES_REVISION_COTIZACION — mostrar cotización y decidir.
// 1️⃣ Generar compra → datos de contacto + API; 2️⃣ Modificar → router.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { preciosData } from '../../../logic/utils.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOModificar } from '../../../logic/keyword-intent.js';
import { getQuotationTemplate } from '../../../views/templates.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';
import { buildBarrilesPedidoIntro } from '../../../logic/cot-barriles-contact.js';

const MENU_BLOCK = formatMenuBlock(['Generar compra', 'Modificar']);

const SHORT_Q = withAssistantFooter(`*¿Te parece bien esta cotización?*

${MENU_BLOCK}`);

const AI_PROMPT = `[SISTEMA - ESTADO: REVISIÓN COTIZACIÓN BARRILES]
Resuelve dudas breves de precio/despacho. Cierra pidiendo que escriba *1* Generar compra o *2* Modificar.`;

export const BARRILES_REVISION_COTIZACION = defineState({
  id: 'BARRILES_REVISION_COTIZACION',
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,
  promptQuestion: (session) => {
    if (!session.orderBuilder?.clientData) {
      return `Faltan datos del pedido. Escribe 1️⃣ para cócteles o vuelve a empezar con *Barriles Desechables*.`;
    }
    const orderBuilder = new OrderBuilder('desechable', preciosData);
    orderBuilder.products = session.orderBuilder.products || {};
    orderBuilder.extras = session.orderBuilder.extras || {};
    const locationData = session.orderBuilder.clientData.locationData;
    const deliveryCost = locationData?.deliveryCost?.desechable || null;
    const quote = orderBuilder.calculateQuote(deliveryCost);
    session.orderBuilder.quote = quote;
    session.quotationGenerated = true;
    return getQuotationTemplate(session.orderBuilder.clientData, quote, deliveryCost, locationData);
  },

  async validateAndProcess(messageText, session) {
    if (!session.orderBuilder?.clientData) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: `Revisemos el pedido desde los cócteles.

*¿Qué sabor y cuántos barriles quieres?*
_(ej: 1 mojito y 1 sangría)_`
      };
    }
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR', 'MODIFICAR'],
      keywordRules: rulesConfirmarOModificar(),
      labelHints: {
        CONFIRMAR: 'Opción 1 / quiere generar la compra online (1, 1️⃣, comprar, generar, ok, sí).',
        MODIFICAR: 'Opción 2 / quiere cambiar cócteles, fecha o comuna (2, 2️⃣, modificar).'
      }
    });

    // Cliente quiere avanzar → checkout uno a uno (mismo happy path que tras el carrito)
    if (intent === 'CONFIRMAR') {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_DATOS',
        customReply: buildBarrilesPedidoIntro(session),
        flowProgress: true
      };
    }

    if (intent === 'MODIFICAR') {
      session.quotationGenerated = false;
      return { success: true, nextState: 'BARRILES_ROUTER_MODIFICACION' };
    }

    return { success: false };
  }
});
