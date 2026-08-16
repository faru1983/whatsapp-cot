// ==============================================================================
// OBJETIVO: Paso EVENTOS_ESTILO_MENU — tras “quiero cotizar”.
// Solo pide cócteles por persona (pregunta abierta). Luego salta a ELECCION_MENU
// con catálogo por categoría + elección libre (selección sugerida opcional).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import {
  getEventFormatKey,
  tryApplyEventosIntroPriorCorrection
} from '../../../logic/eventos-helpers.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  buildPerPersonAsk,
  buildFlavorPickQuestion,
  buildFlavorCatalogBlock,
  buildFlavorPickEntryReplies,
  resolveDrinksPerPersonChoice,
  getEventosEstiloPhase,
  calculateEventBaseline,
  wrapEventFlavorMenuEntry,
  needsHighPerPersonConfirmation,
  buildHighPerPersonConfirmCopy,
  confirmsHighPerPersonChoice,
  parsePerPersonChoice
} from '../../../logic/eventos-style-pack.js';

/**
 * shortQuestionForSession: Re-pregunta de p/p (o sabores si ya avanzó).
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (getEventosEstiloPhase(session) === 'per_person') {
    return withAssistantFooter(buildPerPersonAsk());
  }
  // Pregunta de sabores sin pie HUMANO (la lista ya se mostró al entrar)
  return buildFlavorPickQuestion();
}

const AI_PROMPT = `[SISTEMA - ESTADO: ARMAR COTIZACIÓN DE EVENTO]
Cliente quiere cotizar. Usa CONTEXTO DE FORMATO (Dispensador/Muro, litrajes, mínimo, instalación).
1) Pregunta abierta: cócteles por persona (2 complemento, 3+ barra).
2) Luego sabores (catálogo) o *sugerida*. No inventes precios ni litros fuera del formato elegido.`;

export const EVENTOS_ESTILO_MENU = defineState({
  id: 'EVENTOS_ESTILO_MENU',
  promptQuestion: (session) => shortQuestionForSession(session),
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const formatKey = getEventFormatKey(session.eventoFormato);
    const phase = getEventosEstiloPhase(session);

    // ------------------------------------------------------------------
    // Corrección mid-flow: invitados / tipo
    // ------------------------------------------------------------------
    const priorFix = tryApplyEventosIntroPriorCorrection(messageText, session);
    if (priorFix) {
      if (phase === 'per_person') {
        return {
          success: true,
          nextState: 'EVENTOS_ESTILO_MENU',
          customReplies: [priorFix.ack, withAssistantFooter(buildPerPersonAsk())],
          flowProgress: true
        };
      }
      // Ya tenía p/p: rearmar entrada a sabores en ELECCION
      const per = Number(session.eventosDrinksPerGuest) || 2;
      const replies = buildFlavorPickEntryReplies(session, formatKey, per);
      if (priorFix.field === 'invitados') {
        const baseline = calculateEventBaseline(session.guests, formatKey, per);
        return {
          success: true,
          nextState: 'EVENTOS_ELECCION_MENU',
          customReplies: [
            `${priorFix.ack}\n\nCon *${baseline.guests}* invitados y *${baseline.drinksPerGuest} p/p*: ${baseline.mathLine}.

${buildFlavorCatalogBlock(formatKey)}`,
            replies[1]
          ],
          flowProgress: true
        };
      }
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          `${priorFix.ack}\n\n${replies[0]}`,
          replies[1]
        ],
        flowProgress: true
      };
    }

    // ------------------------------------------------------------------
    // Sesión legacy: ya tiene p/p pero quedó en ESTILO → mandar a sabores
    // ------------------------------------------------------------------
    if (phase === 'done') {
      const per = Number(session.eventosDrinksPerGuest) || 2;
      return wrapEventFlavorMenuEntry(session, formatKey, per, messageText);
    }

    // Confirmación p/p alto (>3)
    if (session.eventosPendingPerPersonConfirm) {
      const pending = Number(session.eventosPendingPerPersonConfirm);
      if (confirmsHighPerPersonChoice(messageText, pending)) {
        session.eventosDrinksPerGuest = pending;
        session.eventosPerPersonConfirmed = true;
        delete session.eventosPendingPerPersonConfirm;
        return wrapEventFlavorMenuEntry(session, formatKey, pending, messageText);
      }
      const alt = parsePerPersonChoice(messageText)
        || (await resolveDrinksPerPersonChoice(messageText, session))?.per;
      if (alt) {
        if (needsHighPerPersonConfirmation(alt)) {
          session.eventosPendingPerPersonConfirm = alt;
          return {
            success: true,
            nextState: 'EVENTOS_ESTILO_MENU',
            customReply: buildHighPerPersonConfirmCopy(session, formatKey, alt),
            flowProgress: true
          };
        }
        session.eventosDrinksPerGuest = alt;
        session.eventosPerPersonConfirmed = true;
        delete session.eventosPendingPerPersonConfirm;
        return wrapEventFlavorMenuEntry(session, formatKey, alt, messageText);
      }
      return {
        success: true,
        nextState: 'EVENTOS_ESTILO_MENU',
        customReply: buildHighPerPersonConfirmCopy(session, formatKey, pending),
        flowProgress: true
      };
    }

    // Cócteles por persona (pregunta abierta) → ELECCION_MENU
    const choice = await resolveDrinksPerPersonChoice(messageText, session);
    if (choice?.per) {
      if (needsHighPerPersonConfirmation(choice.per)) {
        session.eventosPendingPerPersonConfirm = choice.per;
        return {
          success: true,
          nextState: 'EVENTOS_ESTILO_MENU',
          customReply: buildHighPerPersonConfirmCopy(session, formatKey, choice.per),
          flowProgress: true
        };
      }
      session.eventosDrinksPerGuest = choice.per;
      session.eventosPerPersonConfirmed = true;
      return wrapEventFlavorMenuEntry(session, formatKey, choice.per, messageText);
    }

    return { success: false };
  }
});
