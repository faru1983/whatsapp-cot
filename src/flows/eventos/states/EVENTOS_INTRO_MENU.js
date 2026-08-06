// ==============================================================================
// OBJETIVO: Paso EVENTOS_INTRO_MENU — tras el pitch del formato, menú para
// ver carta de cócteles/precios (1️⃣) o hablar con humano (2️⃣).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesContinuarSiOOk } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  buildMenuEntryReplies
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';
import { buildAdminSosBody } from '../../../views/templates.js';

const MENU_BLOCK = formatMenuBlock(['Ver carta y precios', 'Hablar con Humano']);

const SHORT_Q = withAssistantFooter(`*¿Quieres ver los cócteles disponibles y precios?*

${MENU_BLOCK}`);

const AI_PROMPT = `[SISTEMA - ESTADO: INTRO MENÚ DE EVENTO]
El cliente ya eligió Dispensador o Muro y recibió el pitch de lo incluido.
Debe escribir *1* para ver la carta de precios, o *2* / HUMANO para una persona.
1. Responde dudas breves sobre el formato (instalación, qué incluye) sin inventar precios de cócteles.
2. NUNCA armes el pedido ni cotices totales todavía.
3. Al final, recuérdale el menú 1️⃣ / 2️⃣.`;

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
      allowedLabels: ['CONFIRMAR', 'HUMANO'],
      keywordRules: rulesContinuarSiOOk(),
      labelHints: {
        CONFIRMAR: 'Opción 1 / quiere ver la carta / seguir (1, 1️⃣, sí, ok, dale, ver precios).',
        HUMANO: 'Opción 2 / quiere hablar con una persona del equipo.'
      }
    });

    if (intent === 'HUMANO') {
      return {
        success: true,
        nextState: 'CERRADO',
        mute: true,
        notifyAdmin: {
          type: 'SOS',
          title: 'PIDIÓ HUMANO',
          body: buildAdminSosBody({
            reason: 'Eligió opción 2 / hablar con humano en intro menú eventos.',
            stateId: 'EVENTOS_INTRO_MENU'
          })
        },
        customReply: `Te comunico con alguien del equipo. ¡Ya te escriben! 🙌`
      };
    }

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
