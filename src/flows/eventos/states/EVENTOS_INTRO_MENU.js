// ==============================================================================
// OBJETIVO: Paso EVENTOS_INTRO_MENU — tras tipo + invitados, ¿cotiza o tiene duda?
// Menú 1️⃣ cotización / 2️⃣ duda (estilo Barriles): keywords → NLU si falla.
// Cotización → carta + ELECCION_MENU. Duda → pide texto → SOS + mute.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  buildMenuEntryReplies
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { buildAdminSosBody } from '../../../views/templates.js';
import {
  eventosIntroMenuQuestion,
  buildEventosAskDoubtReply,
  EVENTOS_COTIZAR_SYNONYMS,
  EVENTOS_DUDA_SYNONYMS
} from '../../../logic/eventos-intro.js';

const MENU_Q = eventosIntroMenuQuestion();
const SHORT_Q = withAssistantFooter(MENU_Q);

const AI_PROMPT = `[SISTEMA - ESTADO: INTRO MENÚ DE EVENTO]
El cliente ya eligió Dispensador o Muro y nos dio tipo de evento e invitados.
Debe elegir UNA opción:
1️⃣ Quiero hacer una cotización — o 2️⃣ Tengo una duda.
1. Si no eligió opción clara, pide el *número* de la opción.
2. Responde dudas breves sobre el formato (instalación, qué incluye) sin inventar precios de cócteles.
3. NUNCA armes el pedido ni cotices totales todavía.
4. Al final, recuérdale el menú 1️⃣ / 2️⃣.`;

/**
 * shortQuestionForSession: Re-pregunta según fase (menú o espera de duda).
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (session?.eventosAwaitingDoubt) {
    return withAssistantFooter('Escríbeme tu duda y te conectamos con el equipo.');
  }
  return SHORT_Q;
}

export const EVENTOS_INTRO_MENU = defineState({
  id: 'EVENTOS_INTRO_MENU',
  promptQuestion: () => SHORT_Q,
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // ------------------------------------------------------------------
    // Fase duda: ya pedimos el texto; este mensaje ES la pregunta → SOS + mute
    // ------------------------------------------------------------------
    if (session.eventosAwaitingDoubt) {
      const doubtText = String(messageText || '').trim();
      session.eventosAwaitingDoubt = false;
      session.eventosDoubtText = doubtText;
      // Sin customReply: mute silencioso; el humano responde la duda
      return {
        success: true,
        nextState: 'CERRADO',
        mute: true,
        notifyAdmin: {
          type: 'SOS',
          title: 'DUDA EVENTOS',
          body: buildAdminSosBody({
            reason: `Eligió opción 2 / duda en intro eventos. Pregunta: ${doubtText || '(vacía)'}`,
            stateId: 'EVENTOS_INTRO_MENU',
            lastMessage: doubtText
          })
        }
      };
    }

    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['COTIZAR', 'DUDA'],
      keywordRules: rulesMenuUnoDos({
        labelUno: 'COTIZAR',
        labelDos: 'DUDA',
        extraUno: EVENTOS_COTIZAR_SYNONYMS,
        extraDos: EVENTOS_DUDA_SYNONYMS
      }),
      labelHints: {
        COTIZAR: 'Opción 1 / quiere hacer una cotización o ver la carta (1, 1️⃣, cotizar, cotización, ver precios).',
        DUDA: 'Opción 2 / tiene una duda o quiere hablar con el equipo (2, 2️⃣, duda, consulta, pregunta).'
      }
    });

    // 2️⃣ Duda → pedir el texto; el siguiente mensaje dispara SOS + mute
    if (intent === 'DUDA') {
      session.eventosAwaitingDoubt = true;
      return {
        success: true,
        nextState: 'EVENTOS_INTRO_MENU',
        customReply: buildEventosAskDoubtReply(),
        flowProgress: true
      };
    }

    // 1️⃣ Cotización → carta + litros/rendimiento + pregunta de cócteles
    if (intent === 'COTIZAR') {
      const formatKey = getEventFormatKey(session.eventoFormato);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: buildMenuEntryReplies(session, formatKey),
        flowProgress: true
      };
    }

    return { success: false };
  }
});
