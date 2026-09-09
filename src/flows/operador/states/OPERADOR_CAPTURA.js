// ==============================================================================
// OBJETIVO: Paso OPERADOR_CAPTURA — recibe datos en cualquier orden.
// Mergea en operatorDraft, lista faltantes o pasa a confirmar si está completo.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { buildOperatorMenuText, isOperatorCancelCommand } from '../../../logic/operator-menu.js';
import {
  ingestOperatorMessage,
  formatMissingFieldsMessage,
  formatOperatorDoubtsMessage,
  formatOperatorSummary,
  clearOperatorDraft
} from '../../../logic/operator-draft.js';

export const OPERADOR_CAPTURA = defineState({
  id: 'OPERADOR_CAPTURA',
  promptQuestion: (session) => {
    const kind = session.operatorKind === 'barriles'
      ? 'venta barriles'
      : session.operatorKind === 'event_reserva'
        ? 'reserva de evento'
        : 'cotización evento';
    return `Capturando datos para *${kind}*. Envía el bloque en cualquier orden.`;
  },
  shortQuestion: 'Envía los datos, o */menu* / *cancelar* para anular.',
  aiPrompt: `[SISTEMA - OPERADOR CAPTURA] Extrae campos del bloque. No inventar.`,

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

    if (!session.operatorKind) {
      return {
        success: true,
        nextState: 'OPERADOR_MENU',
        customReply: buildOperatorMenuText()
      };
    }

    const result = await ingestOperatorMessage(session, trimmed);

    if (result.doubts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: formatOperatorDoubtsMessage(result.doubts)
      };
    }

    if (!result.complete) {
      const missingMsg = formatMissingFieldsMessage(result.missing, session.operatorKind);
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: missingMsg || 'Aún faltan datos. Revisa el checklist e intenta de nuevo.'
      };
    }

    return {
      success: true,
      nextState: 'OPERADOR_CONFIRMAR',
      customReply: formatOperatorSummary(session)
    };
  }
});
