// ==============================================================================
// OBJETIVO: Paso EVENTOS_CONFIRMAR_ENVIO — resumen final + confirmar antes de la API.
// El cliente revisa contacto, evento y pedido; solo entonces creamos la cotización web.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventosQuoteSummary } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  applyEventosContactDataFromMessage,
  getMissingEventosContactFields,
  askForMissingEventosContact,
  submitEventosQuoteConfirmed,
  wantsToChangeEventosOrder
} from '../../../logic/cot-eventos-contact.js';
import {
  formatEventCartSummary,
  getEventFormatKey,
  getEventCocktailOrderExample
} from '../../../logic/eventos-helpers.js';
import {
  applyCliApiModeChoice,
  beginCliApiModeAsk,
  getCliApiSubmitAskReply,
  isAwaitingCliApiMode,
  parseCliApiModeChoice,
  shouldAskCliApiModeOnConfirm
} from '../../../logic/cot-api.js';

const SHORT_Q = withAssistantFooter(`*¿Todo bien con tu cotización?*

Escribe *OK* para crearla y enviarte la copia formal, o dime qué quieres *modificar*.
_(ej: email ana@nuevo.com)_`);

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR COTIZACIÓN FORMAL EVENTOS]
Cliente ve resumen completo (pedido + totales + contacto). CONTEXTO DE FORMATO: Dispensador/Muro, instalación.
Debe escribir *OK* / *1* Confirmar, o corregir (ej. "email ana@nuevo.com").
1. No inventes precios distintos al resumen mostrado.
2. Si corrige un dato, confirma y vuelve a mostrar resumen.
3. NUNCA crees la cotización web hasta confirmación explícita.
4. Para cambiar cócteles: *corregir* o nombrar el ajuste.`;

export const EVENTOS_CONFIRMAR_ENVIO = defineState({
  id: 'EVENTOS_CONFIRMAR_ENVIO',
  promptQuestion: (session) => getEventosQuoteSummary(session),
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Simulador: tras OK preguntamos 1️⃣ real / 2️⃣ simulada (antes de tocar el menú OK/corregir)
    if (isAwaitingCliApiMode(session)) {
      const choice = parseCliApiModeChoice(messageText);
      if (!choice) {
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_ENVIO',
          customReply: getCliApiSubmitAskReply(),
          flowProgress: true
        };
      }
      applyCliApiModeChoice(session, choice);
      return submitEventosQuoteConfirmed(session);
    }

    // Cambiar menú/cócteles → elección de menú con carrito actual
    if (wantsToChangeEventosOrder(messageText)) {
      const formatKey = getEventFormatKey(session.eventoFormato);
      const cart = formatEventCartSummary(session.orderBuilder?.products || {}, formatKey);
      const example = getEventCocktailOrderExample(formatKey);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply:
          `Claro, ajustemos el menú. Actualmente tienes:\n\n${cart || '_(vacío)_'}\n\n` +
          `*¿Qué deseas cambiar?*
_(ej: ${example} / quita un sabor / agrega otro)_`
      };
    }

    const hasNewInfo = applyEventosContactDataFromMessage(messageText, session);
    const missing = getMissingEventosContactFields(session);

    if (missing.length) {
      session.eventosContactPhase = null;
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        customReply: askForMissingEventosContact(missing, session),
        flowProgress: hasNewInfo
      };
    }

    if (hasNewInfo) {
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_ENVIO',
        customReplies: getEventosQuoteSummary(session),
        flowProgress: true
      };
    }

    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR', 'CORREGIR'],
      keywordRules: rulesConfirmarOCorregirDatos(),
      labelHints: {
        CONFIRMAR: 'Opción 1 / los datos están bien; quiere crear la cotización (1, 1️⃣, ok, sí, dale).',
        CORREGIR: 'Opción 2 / quiere cambiar algún dato pero aún no dijo el valor nuevo (2, 2️⃣, cambiar, modificar).'
      }
    });

    if (intent === 'CONFIRMAR') {
      // test:local en modo ask → menú real vs simulada (no choca con el OK del cliente)
      if (shouldAskCliApiModeOnConfirm()) {
        beginCliApiModeAsk(session);
        return {
          success: true,
          nextState: 'EVENTOS_CONFIRMAR_ENVIO',
          customReply: getCliApiSubmitAskReply(),
          flowProgress: true
        };
      }
      return submitEventosQuoteConfirmed(session);
    }

    if (intent === 'CORREGIR') {
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_ENVIO',
        customReply:
          `*¿Qué dato quieres cambiar?*
_(ej: email ana@nuevo.com, son 80 invitados o es en Providencia)_

_(si quieres cambiar los *cócteles*, dime qué agregar o quitar)_`,
        flowProgress: true
      };
    }

    return { success: false };
  }
});
