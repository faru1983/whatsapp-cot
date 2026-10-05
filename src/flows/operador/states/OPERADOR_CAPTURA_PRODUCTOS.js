// ==============================================================================
// OBJETIVO: Paso OPERADOR_CAPTURA_PRODUCTOS — Paso 3/3 del flujo operador (Cócteles y Formato).
// Recibe cócteles y formato (Dispensador / Muro) del evento.
// Usa getMissingProductFields. Cuando está completo => OPERADOR_CONFIRMAR (resumen final).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import {
  buildOperatorMenuText,
  isOperatorCancelCommand,
  isOperatorExitCommand,
  buildOperatorExitReply
} from '../../../logic/operator-menu.js';
import {
  ingestOperatorMessage,
  formatMissingFieldsMessage,
  formatOperatorDoubtsMessage,
  formatOperatorSummary,
  getMissingProductFields,
  buildOperatorProductsRequestCopy,
  clearOperatorDraft
} from '../../../logic/operator-draft.js';

export const OPERADOR_CAPTURA_PRODUCTOS = defineState({
  id: 'OPERADOR_CAPTURA_PRODUCTOS',
  promptQuestion: (session) => buildOperatorProductsRequestCopy(session.operatorKind, session),
  shortQuestion: 'Envía cócteles/formato, o */menu* / *cancelar* para anular (o */salir* para cerrar).',
  aiPrompt: '[SISTEMA - OPERADOR PRODUCTOS] Extrae cócteles y formato. No inventar.',

  async validateAndProcess(messageText, session) {
    const trimmed = String(messageText || '').trim();

    if (isOperatorExitCommand(trimmed)) {
      clearOperatorDraft(session);
      session.operatorMode = false;
      session.currentState = null;
      return {
        success: true,
        customReply: buildOperatorExitReply()
      };
    }

    if (isOperatorCancelCommand(trimmed)) {
      clearOperatorDraft(session);
      session.operatorMode = true;
      return {
        success: true,
        nextState: 'OPERADOR_MENU',
        customReply: buildOperatorMenuText()
      };
    }

    if (!session.operatorKind) {
      return {
        success: true,
        nextState: 'OPERADOR_MENU',
        customReply: buildOperatorMenuText()
      };
    }

    // Procesar mensaje: extract local + AI enfocado en productos/formato
    const result = await ingestOperatorMessage(session, trimmed, { stage: 'products' });

    if (result.doubts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA_PRODUCTOS',
        customReply: formatOperatorDoubtsMessage(result.doubts)
      };
    }

    const missingProducts = getMissingProductFields(session);
    if (missingProducts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA_PRODUCTOS',
        customReply: formatMissingFieldsMessage(missingProducts, session.operatorKind)
      };
    }

    // Paso 3 completo => resumen final antes de confirmar
    return {
      success: true,
      nextState: 'OPERADOR_CONFIRMAR',
      customReply: formatOperatorSummary(session)
    };
  }
});