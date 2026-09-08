// ==============================================================================
// OBJETIVO: Paso OPERADOR_CONFIRMAR — resumen + OK o correcciones en lenguaje natural.
// Tras OK ejecuta POST a la API (si /cotapi on).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { buildOperatorMenuText } from '../../../logic/operator-menu.js';
import {
  ingestOperatorMessage,
  formatOperatorSummary,
  formatMissingFieldsMessage,
  formatOperatorDoubtsMessage,
  submitOperatorQuote,
  beginOperatorApiModeAskIfNeeded,
  clearOperatorDraft
} from '../../../logic/operator-draft.js';
import {
  applyCliApiModeChoice,
  getCliApiSubmitAskReply,
  isAwaitingCliApiMode,
  parseCliApiModeChoice
} from '../../../logic/cot-api.js';

export const OPERADOR_CONFIRMAR = defineState({
  id: 'OPERADOR_CONFIRMAR',
  promptQuestion: (session) => formatOperatorSummary(session),
  shortQuestion: 'Escribe *OK* para crear en la web o indica qué cambiar.',
  aiPrompt: `[SISTEMA - OPERADOR CONFIRMAR] Solo OK para enviar o correcciones puntuales.`,

  async validateAndProcess(messageText, session) {
    const trimmed = String(messageText || '').trim();
    const lower = trimmed.toLowerCase();

    if (lower === '/menu' || lower === 'menu' || lower === 'cancelar') {
      clearOperatorDraft(session);
      session.operatorMode = true;
      return {
        success: true,
        nextState: 'OPERADOR_MENU',
        customReply: buildOperatorMenuText()
      };
    }

    if (isAwaitingCliApiMode(session)) {
      const choice = parseCliApiModeChoice(trimmed);
      if (!choice) {
        return {
          success: true,
          nextState: 'OPERADOR_CONFIRMAR',
          customReply: getCliApiSubmitAskReply()
        };
      }
      applyCliApiModeChoice(session, choice);
      return submitOperatorQuote(session);
    }

    const decision = resolveDecisionIntent(trimmed, rulesConfirmarOCorregirDatos());
    const isOk = decision === 'ok' || decision === 'confirmar' || /^ok$/i.test(trimmed);

    if (isOk) {
      const apiAsk = beginOperatorApiModeAskIfNeeded(session);
      if (apiAsk) return apiAsk;
      return submitOperatorQuote(session);
    }

    // Corrección en lenguaje natural → merge y nuevo resumen
    const result = await ingestOperatorMessage(session, trimmed);

    if (result.doubts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CONFIRMAR',
        customReply: `${formatOperatorDoubtsMessage(result.doubts)}\n\n${formatOperatorSummary(session)}`
      };
    }

    if (!result.complete) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: `${formatMissingFieldsMessage(result.missing)}\n\n${formatOperatorSummary(session)}`
      };
    }

    return {
      success: true,
      nextState: 'OPERADOR_CONFIRMAR',
      customReply: `Actualicé el borrador.\n\n${formatOperatorSummary(session)}`
    };
  }
});
