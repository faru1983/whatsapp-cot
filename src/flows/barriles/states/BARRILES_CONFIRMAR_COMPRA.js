// ==============================================================================
// OBJETIVO: Paso BARRILES_CONFIRMAR_COMPRA — resumen final + confirmar antes de la API.
// El cliente revisa contacto, entrega y pedido; solo entonces creamos la compra web.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getBarrilesPurchaseSummary } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { formatMenuBlock, withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  applyBarrilesDataFromMessage,
  getMissingBarrilesFields,
  askForMissingBarriles,
  submitBarrilesSaleConfirmed,
  wantsToChangeBarrilesOrder
} from '../../../logic/cot-barriles-contact.js';

const MENU_BLOCK = formatMenuBlock(['Confirmar', 'Corregir']);

const SHORT_Q = withAssistantFooter(`¿Todo bien?

${MENU_BLOCK}

Si quieres corregir, escribe el dato directo.`);

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR COMPRA DE BARRILES]
El cliente ya dio todos los datos y recibió un resumen (nombre, email, fecha, comuna, dirección, pedido).
Debe elegir 1️⃣ Confirmar, 2️⃣ Corregir, o escribir el dato nuevo (ej. "dirección Los Alerces 99").
1. Responde dudas breves sin inventar precios.
2. Si corrige un dato, confirma el cambio y vuelve a pedir confirmación.
3. NUNCA crees la compra web hasta que confirme (opción 1 / ok).
4. Si quiere cambiar cócteles, indícale que puede escribirlo o elegir 2️⃣ Corregir.`;

export const BARRILES_CONFIRMAR_COMPRA = defineState({
  id: 'BARRILES_CONFIRMAR_COMPRA',
  promptQuestion: (session) => getBarrilesPurchaseSummary(session),
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Cambiar cócteles/pedido → router de modificación
    if (wantsToChangeBarrilesOrder(messageText)) {
      return {
        success: true,
        nextState: 'BARRILES_ROUTER_MODIFICACION',
        customReply: `Claro, ajustemos el pedido. ¿Qué quieres cambiar de los cócteles o la entrega?`
      };
    }

    const hasNewInfo = applyBarrilesDataFromMessage(messageText, session);
    const missing = getMissingBarrilesFields(session);

    // Si al corregir le falta algo obligatorio, volvemos a pedirlo
    if (missing.length) {
      return {
        success: true,
        nextState: 'BARRILES_DATOS_CONTACTO',
        customReply: askForMissingBarriles(missing, session),
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
      return submitBarrilesSaleConfirmed(session);
    }

    if (intent === 'CORREGIR') {
      return {
        success: true,
        nextState: 'BARRILES_CONFIRMAR_COMPRA',
        customReply:
          `Claro, ¿qué dato quieres cambiar? Puedes escribirlo directo (ej: "email ana@nuevo.com", "dirección Los Alerces 99" o "Providencia").\n\n` +
          `Si quieres cambiar los *cócteles*, dime qué agregar o quitar.`,
        flowProgress: true
      };
    }

    return { success: false };
  }
});
