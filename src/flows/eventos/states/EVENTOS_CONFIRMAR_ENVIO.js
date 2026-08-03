// ==============================================================================
// OBJETIVO: Paso EVENTOS_CONFIRMAR_ENVIO — resumen final + confirmar antes de la API.
// El cliente revisa contacto, evento y pedido; solo entonces creamos la cotización web.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventosEnvioSummary } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { formatMenuBlock, withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  applyEventosContactDataFromMessage,
  getMissingEventosContactFields,
  askForMissingEventosContact,
  submitEventosQuoteConfirmed,
  wantsToChangeEventosOrder
} from '../../../logic/cot-eventos-contact.js';
import {
  formatEventCartSummary,
  getEventFormatKey
} from '../../../logic/eventos-helpers.js';

const MENU_BLOCK = formatMenuBlock(['Confirmar', 'Corregir']);

const SHORT_Q = withAssistantFooter(`¿Todo bien?

${MENU_BLOCK}

Si quieres corregir, escribe el dato directo.`);

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR ENVÍO DE COTIZACIÓN EVENTOS]
El cliente ya dio todos los datos y recibió un resumen (contacto, evento, pedido).
Debe escribir *1* Confirmar, *2* Corregir, o el dato nuevo (ej. "email ana@nuevo.com").
1. Responde dudas breves sin inventar precios.
2. Si corrige un dato, confirma el cambio y vuelve a pedir confirmación.
3. NUNCA crees la cotización web hasta que confirme (opción 1 / ok).
4. Si quiere cambiar cócteles, indícale que puede escribirlo o escribir *2* Corregir.`;

export const EVENTOS_CONFIRMAR_ENVIO = defineState({
  id: 'EVENTOS_CONFIRMAR_ENVIO',
  promptQuestion: (session) => getEventosEnvioSummary(session),
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Cambiar menú/cócteles → elección de menú con carrito actual
    if (wantsToChangeEventosOrder(messageText)) {
      const formatKey = getEventFormatKey(session.eventoFormato);
      const cart = formatEventCartSummary(session.orderBuilder?.products || {}, formatKey);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReply:
          `Claro, ajustemos el menú. Actualmente tienes:\n\n${cart || '_(vacío)_'}\n\n` +
          `¿Qué deseas agregar o eliminar? (ej: "agrega Mojito 10L" o "quita el aperol")`
      };
    }

    const hasNewInfo = applyEventosContactDataFromMessage(messageText, session);
    const missing = getMissingEventosContactFields(session);

    if (missing.length) {
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
        customReplies: getEventosEnvioSummary(session),
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
      return submitEventosQuoteConfirmed(session);
    }

    if (intent === 'CORREGIR') {
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_ENVIO',
        customReply:
          `Claro, ¿qué dato quieres cambiar? Puedes escribirlo directo (ej: "email ana@nuevo.com", "son 80 invitados" o "es en Providencia").\n\n` +
          `Si quieres cambiar los *cócteles*, dime qué agregar o quitar.`,
        flowProgress: true
      };
    }

    return { success: false };
  }
});
