// ==============================================================================
// OBJETIVO: Paso OPERADOR_CAPTURA — Paso 1/3 del flujo operador (Datos de Contacto).
// Solicita y valida: Nombre y Apellido, E-mail, Celular / WhatsApp (+569...).
// Muestra lo captado y pide lo que falta si el envío fue parcial.
// Cuando el contacto está completo, avanza al Paso 2 (OPERADOR_CAPTURA_DETALLES).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { buildOperatorMenuText, isOperatorCancelCommand } from '../../../logic/operator-menu.js';
import {
  ingestOperatorMessage,
  formatMissingContactMessage,
  formatContactConfirmation,
  formatMissingDetailsMessage,
  formatDetailsConfirmation,
  getMissingContactFields,
  getMissingDetailsFields,
  getMissingProductFields,
  buildOperatorDetailsRequestCopy,
  buildOperatorProductsRequestCopy,
  formatOperatorSummary,
  formatOperatorDoubtsMessage,
  isOperatorConfirmOk,
  parseOperatorDraftLocal,
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
    return `Indícame los datos de contacto del cliente para *${kind}*.`;
  },
  shortQuestion: 'Envía los datos de contacto, o */menu* / *cancelar* para anular.',
  aiPrompt: `[SISTEMA - OPERADOR CONTACTO] Extrae nombre, apellido, email y teléfono móvil chileno (+569...). No inventar.`,

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

    // 1) Si ya captamos el contacto y estamos esperando confirmación del operador:
    if (session.operatorDraft?.contactPendingConfirm) {
      if (isOperatorConfirmOk(trimmed)) {
        session.operatorDraft.contactPendingConfirm = false;
        session.operatorDraft.contactConfirmed = true;
        return {
          success: true,
          nextState: 'OPERADOR_CAPTURA_DETALLES',
          customReply: buildOperatorDetailsRequestCopy(session.operatorKind, session)
        };
      }

      // Si no escribió OK, ¿envió detalles del evento directamente?
      const testDet = parseOperatorDraftLocal(trimmed, session.operatorKind, session);
      const hasDetailsInMsg = testDet.patch.guests || testDet.patch.comuna || testDet.patch.date || testDet.patch.address;
      if (hasDetailsInMsg) {
        session.operatorDraft.contactPendingConfirm = false;
        session.operatorDraft.contactConfirmed = true;
        await ingestOperatorMessage(session, trimmed, { stage: 'details' });
        const missingDet = getMissingDetailsFields(session);
        if (missingDet.length) {
          return {
            success: true,
            nextState: 'OPERADOR_CAPTURA_DETALLES',
            customReply: formatMissingDetailsMessage(session)
          };
        }
        session.operatorDraft.detailsPendingConfirm = true;
        return {
          success: true,
          nextState: 'OPERADOR_CAPTURA_DETALLES',
          customReply: formatDetailsConfirmation(session)
        };
      }

      // De lo contrario es una corrección a los datos de contacto
      await ingestOperatorMessage(session, trimmed, { stage: 'contact' });
      const missingContact = getMissingContactFields(session);
      if (missingContact.length) {
        session.operatorDraft.contactPendingConfirm = false;
        return {
          success: true,
          nextState: 'OPERADOR_CAPTURA',
          customReply: formatMissingContactMessage(session)
        };
      }
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: formatContactConfirmation(session)
      };
    }

    // 2) Procesar mensaje: extract local + AI enfocado en contacto
    const result = await ingestOperatorMessage(session, trimmed, { stage: 'contact' });

    if (result.doubts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: formatOperatorDoubtsMessage(result.doubts)
      };
    }

    const missingContact = getMissingContactFields(session);
    if (missingContact.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA',
        customReply: formatMissingContactMessage(session)
      };
    }

    // Contacto completo: verificar si vino TODO de una vez (contacto + detalles + productos)
    const missingDetails = getMissingDetailsFields(session);
    const missingProducts = getMissingProductFields(session);
    if (!missingDetails.length && !missingProducts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CONFIRMAR',
        customReply: formatOperatorSummary(session)
      };
    }

    // Contacto completo -> mostrar datos captados y preguntar confirmación
    session.operatorDraft.contactPendingConfirm = true;
    return {
      success: true,
      nextState: 'OPERADOR_CAPTURA',
      customReply: formatContactConfirmation(session)
    };
  }
});
