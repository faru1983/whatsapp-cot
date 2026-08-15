// ==============================================================================
// OBJETIVO: Paso EVENTOS_INTRO_MENU — tras p/p, recomendación + Ver Precios / duda.
// 1️⃣ envía catálogo de precios y pasa a sabores. 2️⃣ duda → SOS + mute.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import { getEventFormatKey, getEventPriceListImage, tryApplyEventosIntroPriorCorrection } from '../../../logic/eventos-helpers.js';
import { buildAdminSosBody } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  eventosIntroMenuQuestion,
  buildEventosAskDoubtReply,
  EVENTOS_COTIZAR_SYNONYMS,
  EVENTOS_DUDA_SYNONYMS
} from '../../../logic/eventos-intro.js';
import { buildFlavorPickEntryReplies, buildVolumeRecommendation, buildStyleEntryReplies } from '../../../logic/eventos-style-pack.js';

const MENU_Q = eventosIntroMenuQuestion();
const SHORT_Q = withAssistantFooter(MENU_Q);

const AI_PROMPT = `[SISTEMA - ESTADO: INTRO MENÚ DE EVENTO]
El cliente ya eligió Dispensador o Muro y nos dio tipo de evento e invitados.
Debe elegir UNA opción:
1️⃣ Ver Precios y Cotizar — o 2️⃣ Tengo una duda.
1. Si no eligió opción clara, pide el *número* de la opción.
2. Si corrige invitados o tipo, confirma el cambio, actualiza la recomendación de litros y vuelve a mostrar el menú 1️⃣/2️⃣.
3. Responde dudas breves sobre el formato (instalación, qué incluye) sin inventar precios de cócteles.
4. NUNCA armes el pedido ni cotices totales todavía. El catálogo de precios se envía al elegir 1️⃣.
5. Al final, recuérdale el menú 1️⃣ / 2️⃣.`;

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

    // ------------------------------------------------------------------
    // Corrección mid-flow: invitados o tipo (sin salir del intro)
    // ------------------------------------------------------------------
    const priorFix = tryApplyEventosIntroPriorCorrection(messageText, session);
    if (priorFix) {
      const formatKey = getEventFormatKey(session.eventoFormato);
      if (priorFix.field === 'invitados') {
        const per = Number(session.eventosDrinksPerGuest) || 2;
        const rec = buildVolumeRecommendation(session, formatKey, per);
        return {
          success: true,
          nextState: 'EVENTOS_INTRO_MENU',
          customReplies: [
            `${priorFix.ack}\n\n${rec}`,
            MENU_Q
          ],
          flowProgress: true
        };
      }
      return {
        success: true,
        nextState: 'EVENTOS_INTRO_MENU',
        customReplies: [`${priorFix.ack}\n\n${MENU_Q}`],
        flowProgress: true
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
        COTIZAR: 'Opción 1 / Ver Precios y Cotizar (1, 1️⃣, cotizar, cotización, ver precios).',
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

    // 1️⃣ Ver Precios y Cotizar → catálogo de precios + sabores (p/p ya está)
    if (intent === 'COTIZAR') {
      const formatKey = getEventFormatKey(session.eventoFormato);
      const per = Number(session.eventosDrinksPerGuest) || 0;
      const catalogImg = getEventPriceListImage(
        formatKey,
        'Para tu referencia te dejo el *catálogo de cócteles* 👆'
      );
      if (per >= 1) {
        const flavorReplies = buildFlavorPickEntryReplies(session, formatKey, per);
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReplies: [catalogImg, ...flavorReplies],
          flowProgress: true
        };
      }
      return {
        success: true,
        nextState: 'EVENTOS_ESTILO_MENU',
        customReplies: [catalogImg, ...buildStyleEntryReplies(session, formatKey)],
        flowProgress: true
      };
    }

    return { success: false };
  }
});
