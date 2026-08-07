// ==============================================================================
// OBJETIVO: Paso EVENTOS_COTIZACION — cotización programática + confirmación.
// OrderBuilder arma los números; el cliente confirma o vuelve a elegir menú.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventQuotationTemplate, getEventosContactIntroAsk } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOModificar } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  formatEventCartSummary,
  buildEventQuoteFromSession
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';

const MENU_BLOCK = formatMenuBlock(['Continuar', 'Modificar']);

const SHORT_Q = withAssistantFooter(`*¿Te parece bien la cotización?*

${MENU_BLOCK}`);

const AI_PROMPT = `[SISTEMA - ESTADO: REVISIÓN DE COTIZACIÓN DE EVENTO]
El cliente ya recibió una cotización generada por el sistema (precios oficiales).
Tu tarea es:
1. Responder dudas breves sobre el pedido, formato, instalación o logística.
2. REGLA: Instalación Dispensador = $0. Instalación Muro = $50.000. NUNCA inventes tarifas.
3. NUNCA recalcules ni inventes una cotización nueva con precios distintos a los ya mostrados.
4. Al finalizar, pide que escriba *1* Continuar o *2* Modificar.
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
        CONFIRMAR: 'Opción 1 / aprueba la cotización y quiere seguir (1, 1️⃣, ok).',
        MODIFICAR: 'Opción 2 / quiere cambiar cócteles, litros o algo del menú (2, 2️⃣, modificar).'
      }
    });

    // Cliente quiere modificar → volvemos a elección de menú con el carrito actual
    if (intent === 'MODIFICAR') {
      session.quotationGenerated = false;
      const formatKey = getEventFormatKey(session.eventoFormato);
      const cart = formatEventCartSummary(session.orderBuilder?.products || {}, formatKey);
      const reply = `Claro, ajustemos el menú. Actualmente tienes:\n\n${cart || '_(vacío)_'}\n\n*¿Qué deseas cambiar?*
_(ej: 20L Mojito y 10L Aperol / quita el aperol / agrega 5L Sangría)_`;
      return { success: true, nextState: 'EVENTOS_ELECCION_MENU', customReply: reply };
    }

    // Cliente aprueba el resumen → invitamos a dejar datos para la cotización formal
    if (intent === 'CONFIRMAR') {
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        customReply: getEventosContactIntroAsk()
      };
    }

    return { success: false };
  }
});
