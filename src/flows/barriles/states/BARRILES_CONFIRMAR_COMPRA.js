// ==============================================================================
// OBJETIVO: Paso BARRILES_CONFIRMAR_COMPRA — resumen final + confirmar antes de la API.
// El cliente revisa contacto, entrega y pedido; solo entonces creamos la compra web.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getBarrilesPurchaseSummary } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  applyBarrilesDataFromMessage,
  getMissingBarrilesFields,
  askBarrilesPedidoPhase,
  resolveBarrilesPedidoPhase,
  submitBarrilesSaleConfirmed,
  wantsToChangeBarrilesOrder
} from '../../../logic/cot-barriles-contact.js';
import {
  applyCliApiModeChoice,
  beginCliApiModeAsk,
  getCliApiSubmitAskReply,
  isAwaitingCliApiMode,
  parseCliApiModeChoice,
  shouldAskCliApiModeOnConfirm
} from '../../../logic/cot-api.js';

const SHORT_Q = withAssistantFooter(`*¿Todo bien con tu pedido?*

Escribe *OK* para generarlo, o dime qué quieres *modificar*.
_(ej: cambia la fecha, agrega 1 sangría)_`);

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR PEDIDO DE BARRILES]
El cliente ve el carrito final (datos + productos + totales). Debe escribir *OK* / *1*, o indicar qué modificar.
1. Responde dudas breves sin inventar precios (usa el resumen ya mostrado).
2. Si corrige un dato o cócteles, confirma el cambio y reenvía el resumen.
3. NUNCA crees la compra web hasta que confirme (ok / opción 1).
4. Si quiere cambiar cócteles, puede escribirlo o ir al menú de modificación.`;

export const BARRILES_CONFIRMAR_COMPRA = defineState({
  id: 'BARRILES_CONFIRMAR_COMPRA',
  promptQuestion: (session) => getBarrilesPurchaseSummary(session),
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Simulador: tras OK preguntamos 1️⃣ real / 2️⃣ simulada
    if (isAwaitingCliApiMode(session)) {
      const choice = parseCliApiModeChoice(messageText);
      if (!choice) {
        return {
          success: true,
          nextState: 'BARRILES_CONFIRMAR_COMPRA',
          customReply: getCliApiSubmitAskReply(),
          flowProgress: true
        };
      }
      applyCliApiModeChoice(session, choice);
      return submitBarrilesSaleConfirmed(session);
    }

    // Cambiar cócteles/pedido → router de modificación
    if (wantsToChangeBarrilesOrder(messageText)) {
      return {
        success: true,
        nextState: 'BARRILES_ROUTER_MODIFICACION',
        customReply: `Claro, ajustemos el pedido.

*¿Qué quieres cambiar de los cócteles o la entrega?*
_(ej: agrega 1 mojito o es en Providencia)_`
      };
    }

    const hasNewInfo = applyBarrilesDataFromMessage(messageText, session);
    const missing = getMissingBarrilesFields(session);

    // Si al corregir le falta algo obligatorio, volvemos al checkout por fases
    if (missing.length) {
      const phase = resolveBarrilesPedidoPhase(session);
      session.barrilesPedidoPhase = phase;
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_DATOS',
        customReply: askBarrilesPedidoPhase(phase, session),
        flowProgress: hasNewInfo
      };
    }

    // Corrigió algo → reenviamos el resumen actualizado
    if (hasNewInfo) {
      return {
        success: true,
        nextState: 'BARRILES_CONFIRMAR_COMPRA',
        customReplies: getBarrilesPurchaseSummary(session),
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
        CONFIRMAR: 'Opción 1 / los datos están bien; quiere crear la compra (1, 1️⃣, ok, sí, dale).',
        CORREGIR: 'Opción 2 / quiere cambiar algún dato pero aún no dijo el valor nuevo (2, 2️⃣, cambiar, modificar).'
      }
    });

    if (intent === 'CONFIRMAR') {
      if (shouldAskCliApiModeOnConfirm()) {
        beginCliApiModeAsk(session);
        return {
          success: true,
          nextState: 'BARRILES_CONFIRMAR_COMPRA',
          customReply: getCliApiSubmitAskReply(),
          flowProgress: true
        };
      }
      return submitBarrilesSaleConfirmed(session);
    }

    if (intent === 'CORREGIR') {
      return {
        success: true,
        nextState: 'BARRILES_CONFIRMAR_COMPRA',
        customReply:
          `*¿Qué quieres modificar del pedido?*
_(ej: email ana@nuevo.com, dirección Los Alerces 99, la comuna es Providencia, o agrega 1 mojito)_`,
        flowProgress: true
      };
    }

    return { success: false };
  }
});
