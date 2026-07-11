// ==============================================================================
// OBJETIVO: Paso BARRILES_REVISION_COTIZACION — mostrar cotización y confirmar.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { preciosData, formatPrice } from '../../../logic/utils.js';
import { OrderBuilder } from '../../../logic/order-builder.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOModificar } from '../../../logic/keyword-intent.js';
import { getQuotationTemplate, buildAdminBarrilesOrderBody } from '../../../views/templates.js';

const SHORT_Q = `¿Todo bien con la cotización o cambiamos algo?`;

const AI_PROMPT = `[SISTEMA - ESTADO: REVISIÓN COTIZACIÓN BARRILES]
Resuelve dudas breves de precio/despacho. Cierra: "¿Todo bien con la cotización o cambiamos algo?".`;

export const BARRILES_REVISION_COTIZACION = defineState({
  id: 'BARRILES_REVISION_COTIZACION',
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,
  promptQuestion: (session) => {
    if (!session.orderBuilder?.clientData) {
      return `Faltan datos del pedido. Escribe *1* para cócteles o vuelve a empezar con *Barriles Desechables*.`;
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
      return { success: true, nextState: 'BARRILES_RECOGIDA_PRODUCTOS', customReply: `Revisemos el pedido desde los cócteles. ¿Qué sabor y cuántos?` };
    }
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR', 'MODIFICAR'],
      keywordRules: rulesConfirmarOModificar()
    });

    if (intent === 'CONFIRMAR') {
      const { location, date } = session.orderBuilder.clientData;
      const total = session.orderBuilder.quote?.total;
      const totalStr = total ? formatPrice(total) : 'Revisar chat';

      let adminProducts = '';
      for (const [pName, qty] of Object.entries(session.orderBuilder.products)) {
        const price = preciosData.cocteles[pName]?.desechable?.['5L'] || 0;
        adminProducts += `- ${qty}x ${pName}: ${formatPrice(price * qty)}\n`;
      }

      let adminExtras = '';
      if (Object.keys(session.orderBuilder.extras).length > 0) {
        for (const [eName, qty] of Object.entries(session.orderBuilder.extras)) {
          const price = preciosData.extras[eName] || 0;
          adminExtras += `- ${qty}x ${eName}: ${formatPrice(price * qty)}\n`;
        }
      }

      const alert = {
        type: 'SUCCESS',
        title: 'BARRILES DESECHABLES',
        labelKey: 'cotizacionBarriles',
        body: buildAdminBarrilesOrderBody({
          location,
          date,
          productsText: adminProducts,
          extrasText: adminExtras,
          totalStr
        })
      };

      return {
        success: true,
        nextState: 'CERRADO',
        mute: true,
        notifyAdmin: alert,
        customReply: `✅ Tu pedido quedó registrado.\n\nEn unos minutos alguien de nuestro equipo aprobará tu cotización y te enviará los datos de transferencia.\n\nUna vez confirmado el pago, tu pedido queda agendado. 🍹`
      };
    }

    if (intent === 'MODIFICAR') {
      session.quotationGenerated = false;
      return { success: true, nextState: 'BARRILES_ROUTER_MODIFICACION' };
    }

    return { success: false };
  }
});
