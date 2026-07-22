// ==============================================================================
// OBJETIVO: Paso EVENTOS_INTRO_MENU — tras el pitch del formato, confirmar
// para ver carta de cócteles/precios + hint de litros/rendimiento.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesContinuarSiOOk } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  buildMenuEntryReplies
} from '../../../logic/eventos-helpers.js';

const SHORT_Q = `¿Quieres ver los cócteles disponibles y precios? Escribe *OK* para continuar.`;

const AI_PROMPT = `[SISTEMA - ESTADO: INTRO MENÚ DE EVENTO]
El cliente ya eligió Dispensador o Muro y recibió el pitch de lo incluido.
Debe confirmar (sí / ok / seguimos) para ver la carta de precios y armar el pedido.
1. Responde dudas breves sobre el formato (instalación, qué incluye) sin inventar precios de cócteles.
2. NUNCA armes el pedido ni cotices totales todavía.
3. Al final, recuérdale escribir *sí* o *ok* para ver cócteles y precios.`;

export const EVENTOS_INTRO_MENU = defineState({
  id: 'EVENTOS_INTRO_MENU',
  promptQuestion: () => SHORT_Q,
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR'],
      keywordRules: rulesContinuarSiOOk(),
      labelHints: {
        CONFIRMAR: 'Quiere ver la carta / seguir (sí, ok, dale, seguimos, ver precios, ver cócteles).'
      }
    });

    // Confirmó → carta + litros/rendimiento + pregunta de cócteles
    if (intent === 'CONFIRMAR') {
      const formatKey = getEventFormatKey(session.eventoFormato);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: buildMenuEntryReplies(session, formatKey)
      };
    }

    return { success: false };
  }
});
