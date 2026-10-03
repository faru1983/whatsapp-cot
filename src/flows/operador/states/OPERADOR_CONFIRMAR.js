// ==============================================================================
// OBJETIVO: Paso OPERADOR_CONFIRMAR — resumen final (datos + cócteles) + OK → API.
// Corresponde al Paso 2B del flujo admin: confirmar antes de enviar.
// Correcciones de productos → OPERADOR_CAPTURA_PRODUCTOS.
// Correcciones de datos → OPERADOR_CAPTURA (vuelve al inicio).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { buildOperatorMenuText, isOperatorCancelCommand } from '../../../logic/operator-menu.js';
import {
  ingestOperatorMessage,
  formatOperatorSummary,
  formatMissingFieldsMessage,
  formatOperatorDoubtsMessage,
  getMissingProductFields,
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
  shortQuestion: 'Escribe *OK* para enviar, qué cambiar, o */menu* / *cancelar* para anular.',
  aiPrompt: `[SISTEMA - OPERADOR CONFIRMAR] Resumen final. Solo OK para enviar o correcciones puntuales.`,

  async validateAndProcess(messageText, session) {
    const trimmed = String(messageText || '').trim();

    if (isOperatorCancelCommand(trimmed)) {
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

    // Corrección en lenguaje natural → merge y decidir a qué estado volver
    const result = await ingestOperatorMessage(session, trimmed);

    if (result.doubts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CONFIRMAR',
        customReply: `${formatOperatorDoubtsMessage(result.doubts)}\n\n${formatOperatorSummary(session)}`
      };
    }

    // Si faltan productos → volver a captura de productos
    const missingProducts = getMissingProductFields(session);
    if (missingProducts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA_PRODUCTOS',
        customReply: `${formatMissingFieldsMessage(missingProducts, session.operatorKind)}\n\n${formatOperatorSummary(session)}`
      };
    }

    return {
      success: true,
      nextState: 'OPERADOR_CONFIRMAR',
      customReply: `Actualicé el borrador.\n\n${formatOperatorSummary(session)}`
    };
  }
});
