// ==============================================================================
// OBJETIVO: Paso EVENTOS_COTIZACION — cotización programática + confirmación.
// OrderBuilder arma los números; el cliente confirma o vuelve a elegir menú.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import {
  getEventQuotationTemplate,
  buildAdminEventosOrderBody
} from '../../../views/templates.js';
import { formatPrice, preciosData } from '../../../logic/utils.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOModificar } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  formatEventCartSummary,
  buildEventQuoteFromSession
} from '../../../logic/eventos-helpers.js';

const SHORT_Q = `Si está bien, escribe *ok*. Si quieres cambiar algo, escribe *modificar*.`;

const AI_PROMPT = `[SISTEMA - ESTADO: REVISIÓN DE COTIZACIÓN DE EVENTO]
El cliente ya recibió una cotización generada por el sistema (precios oficiales).
Tu tarea es:
1. Responder dudas breves sobre el pedido, formato, instalación o logística.
2. REGLA: Instalación Dispensador = $0. Instalación Muro = $50.000. NUNCA inventes tarifas.
3. NUNCA recalcules ni inventes una cotización nueva con precios distintos a los ya mostrados.
4. Al finalizar, pide escribir *ok* para avanzar (o *modificar* si quiere cambios).
REGLA DE NEGRITA: Usa un solo asterisco (*) para negrita en WhatsApp.`;

export const EVENTOS_COTIZACION = defineState({
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
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR', 'MODIFICAR'],
      keywordRules: rulesConfirmarOModificar(),
      labelHints: {
        CONFIRMAR: 'Aprueba la cotización y quiere datos de reserva / transferencia.',
        MODIFICAR: 'Quiere cambiar cócteles, litros o algo del menú.'
      }
    });

    // Cliente quiere modificar → volvemos a elección de menú con el carrito actual
    if (intent === 'MODIFICAR') {
      session.quotationGenerated = false;
      const formatKey = getEventFormatKey(session.eventoFormato);
      const cart = formatEventCartSummary(session.orderBuilder?.products || {}, formatKey);
      const reply = `Claro, ajustemos el menú. Actualmente tienes:\n\n${cart || '_(vacío)_'}\n\n¿Qué deseas agregar o eliminar? (ej: "agrega Mojito 10L" o "quita el aperol")`;
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    // Cliente aprueba la cotización → cerramos, silenciamos bot y avisamos al equipo
    if (intent === 'CONFIRMAR') {
      const { location, date, guests, eventoFormato, celebrationType } = session;
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
});
