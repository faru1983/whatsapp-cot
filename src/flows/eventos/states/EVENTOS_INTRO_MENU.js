// ==============================================================================
// OBJETIVO: Paso EVENTOS_INTRO_MENU — tras p/p, cálculo de volumen + Ver Precios / duda.
// 1️⃣ pide favoritos (sin carta de precios). 2️⃣ duda → SOS + mute.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import { getEventFormatKey, tryApplyEventosIntroPriorCorrection } from '../../../logic/eventos-helpers.js';
import { buildAdminSosBody } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  eventosIntroMenuQuestion,
  buildEventosAskDoubtReply,
  EVENTOS_COTIZAR_SYNONYMS,
  EVENTOS_DUDA_SYNONYMS
} from '../../../logic/eventos-intro.js';
import { buildFlavorPickEntryReplies, buildVolumeRecommendation, buildStyleEntryReplies, wrapEventFlavorMenuEntry } from '../../../logic/eventos-style-pack.js';

const MENU_Q = eventosIntroMenuQuestion();
const SHORT_Q = withAssistantFooter(MENU_Q);

const AI_PROMPT = `[SISTEMA - ESTADO: INTRO MENÚ DE EVENTO]
El cliente ya eligió formato (Dispensador o Muro), tipo, invitados y cócteles por persona.
Usa el CONTEXTO DE FORMATO inyectado: litrajes, mínimo (10L Dispensador / 30L Muro) e instalación.
Menú: 1️⃣ Ver Precios y Cotizar → lista de sabores (sin precios) | 2️⃣ Tengo una duda → equipo humano.
1. Si no eligió opción clara, pide el número 1️⃣ o 2️⃣.
2. Si corrige invitados/tipo, confirma, actualiza litros y vuelve al menú.
3. Dudas breves de formato (instalación, qué incluye) sin inventar precios de cócteles.
4. NUNCA armes pedido ni cotices totales aquí.`;

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

    // 1️⃣ Cotizar → menú de sabores (sin imagen de precios; esa va si pregunta precios)
    if (intent === 'COTIZAR') {
      const formatKey = getEventFormatKey(session.eventoFormato);
      const per = Number(session.eventosDrinksPerGuest) || 0;
      if (per >= 1) {
        return wrapEventFlavorMenuEntry(session, formatKey, per, messageText);
      }
      return {
        success: true,
        nextState: 'EVENTOS_ESTILO_MENU',
        customReplies: buildStyleEntryReplies(session, formatKey),
        flowProgress: true
      };
    }

    return { success: false };
  }
});
