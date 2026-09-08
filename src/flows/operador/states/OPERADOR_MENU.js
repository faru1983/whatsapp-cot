// ==============================================================================
// OBJETIVO: Paso OPERADOR_MENU — panel /menu con acciones 1 y 2.
// Solo admins o self-chat llegan aquí vía operatorMode en el engine.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { buildOperatorMenuText } from '../../../logic/operator-menu.js';
import {
  setOperatorKind,
  buildOperatorDataRequestCopy,
  clearOperatorDraft
} from '../../../logic/operator-draft.js';
import { matchesMenuOption } from '../../../logic/keyword-intent.js';

export const OPERADOR_MENU = defineState({
  id: 'OPERADOR_MENU',
  promptQuestion: () => buildOperatorMenuText(),
  shortQuestion: 'Escribe *1* o *2*, o */menu*.',
  aiPrompt: `[SISTEMA - OPERADOR] Panel interno. Solo menú 1 cotización / 2 venta. No inventar datos.`,

  async validateAndProcess(messageText, session) {
    const trimmed = String(messageText || '').trim();
    const lower = trimmed.toLowerCase();

    if (lower === '/menu' || lower === 'menu') {
      clearOperatorDraft(session);
      session.operatorMode = true;
      return {
        success: true,
        nextState: 'OPERADOR_MENU',
        customReply: buildOperatorMenuText()
      };
    }

    if (matchesMenuOption(trimmed, 1) || /\bcotizaci[oó]n\b|\bevento\b/i.test(trimmed)) {
      setOperatorKind(session, 'event');
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: buildOperatorDataRequestCopy('event')
      };
    }

    if (matchesMenuOption(trimmed, 2) || /\bventa\b|\bbarriles?\b|\bdesechable/i.test(trimmed)) {
      setOperatorKind(session, 'barriles');
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: buildOperatorDataRequestCopy('barriles')
      };
    }

    return {
      success: true,
      nextState: 'OPERADOR_MENU',
      customReply: `No reconocí la opción.\n\n${buildOperatorMenuText()}`
    };
  }
});
