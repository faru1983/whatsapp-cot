// ==============================================================================
// OBJETIVO: Paso OPERADOR_MENU — panel /menu con acciones 1, 2 y 3.
// Solo admins o self-chat llegan aquí vía operatorMode en el engine.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { buildOperatorMenuText, isOperatorCancelCommand } from '../../../logic/operator-menu.js';
import {
  setOperatorKind,
  buildOperatorDataRequestCopy,
  clearOperatorDraft
} from '../../../logic/operator-draft.js';
import { matchesMenuOption } from '../../../logic/keyword-intent.js';

export const OPERADOR_MENU = defineState({
  id: 'OPERADOR_MENU',
  promptQuestion: () => buildOperatorMenuText(),
  shortQuestion: 'Escribe *1*, *2* o *3*, o */menu*.',
  aiPrompt: `[SISTEMA - OPERADOR] Panel interno. 1 cotización draft / 2 venta barriles / 3 reserva confirmada. No inventar datos.`,

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

    // 1️⃣ Reservar evento confirmado
    if (matchesMenuOption(trimmed, 1) || /\breserva\b/i.test(trimmed)) {
      setOperatorKind(session, 'event_reserva');
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: buildOperatorDataRequestCopy('event_reserva')
      };
    }

    // 2️⃣ Venta barriles desechables
    if (matchesMenuOption(trimmed, 2) || /\bventa\b|\bbarriles?\b|\bdesechable/i.test(trimmed)) {
      setOperatorKind(session, 'barriles');
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: buildOperatorDataRequestCopy('barriles')
      };
    }

    // 3️⃣ Cotizar evento (draft sin confirmar)
    if (matchesMenuOption(trimmed, 3) || /\bcotizaci[oó]n\b/i.test(trimmed) || /\bevento\b/i.test(trimmed)) {
      setOperatorKind(session, 'event');
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: buildOperatorDataRequestCopy('event')
      };
    }

    return {
      success: true,
      nextState: 'OPERADOR_MENU',
      customReply: `No reconocí la opción.\n\n${buildOperatorMenuText()}`
    };
  }
});
