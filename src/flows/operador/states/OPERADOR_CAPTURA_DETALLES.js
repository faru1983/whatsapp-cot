// ==============================================================================
// OBJETIVO: Paso OPERADOR_CAPTURA_DETALLES — Paso 2/3 del flujo operador (Detalles evento/despacho).
// Solicita y valida: N° invitados, comuna, fecha, dirección y hora de inicio según corresponda.
// Muestra lo captado y pide lo que falta si el envío fue parcial.
// Cuando los detalles están completos, avanza al Paso 3 (OPERADOR_CAPTURA_PRODUCTOS).
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
  formatMissingDetailsMessage,
  formatDetailsConfirmation,
  formatMissingFieldsMessage,
  getMissingDetailsFields,
  getMissingProductFields,
  buildOperatorProductsRequestCopy,
  formatOperatorSummary,
  formatOperatorDoubtsMessage,
  isOperatorConfirmOk,
  parseOperatorDraftLocal,
  clearOperatorDraft
} from '../../../logic/operator-draft.js';

export const OPERADOR_CAPTURA_DETALLES = defineState({
  id: 'OPERADOR_CAPTURA_DETALLES',
  promptQuestion: (session) => {
    const kind = session.operatorKind;
    if (kind === 'barriles') return 'Indícame la dirección de despacho, comuna y fecha de entrega.';
    if (kind === 'event_reserva') return 'Indícame la dirección del evento, invitados, fecha y hora de inicio.';
    return 'Indícame la cantidad de invitados, comuna y fecha del evento.';
  },
  shortQuestion: 'Envía los detalles del evento/pedido, o */menu* / *cancelar* para anular (o */salir* para cerrar).',
  aiPrompt: `[SISTEMA - OPERADOR DETALLES] Extrae invitados, comuna, fecha, dirección y hora de inicio. No inventar.`,

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

    // 1) Si ya captamos los detalles y estamos esperando confirmación del operador:
    if (session.operatorDraft?.detailsPendingConfirm) {
      if (isOperatorConfirmOk(trimmed)) {
        session.operatorDraft.detailsPendingConfirm = false;
        session.operatorDraft.detailsConfirmed = true;
        return {
          success: true,
          nextState: 'OPERADOR_CAPTURA_PRODUCTOS',
          customReply: buildOperatorProductsRequestCopy(session.operatorKind, session)
        };
      }

      // Si no escribió OK, ¿envió productos o formato directamente?
      const testProd = parseOperatorDraftLocal(trimmed, session.operatorKind, session);
      const hasProdInMsg = (testProd.patch.products && testProd.patch.products.length > 0) || testProd.patch.eventoFormato;
      if (hasProdInMsg) {
        session.operatorDraft.detailsPendingConfirm = false;
        session.operatorDraft.detailsConfirmed = true;
        await ingestOperatorMessage(session, trimmed, { stage: 'products' });
        const missingProd = getMissingProductFields(session);
        if (missingProd.length) {
          return {
            success: true,
            nextState: 'OPERADOR_CAPTURA_PRODUCTOS',
            customReply: formatMissingFieldsMessage(missingProd, session.operatorKind)
          };
        }
        return {
          success: true,
          nextState: 'OPERADOR_CONFIRMAR',
          customReply: formatOperatorSummary(session)
        };
      }

      // De lo contrario es una corrección a los detalles del evento
      await ingestOperatorMessage(session, trimmed, { stage: 'details' });
      const missingDetails = getMissingDetailsFields(session);
      if (missingDetails.length) {
        session.operatorDraft.detailsPendingConfirm = false;
        return {
          success: true,
          nextState: 'OPERADOR_CAPTURA_DETALLES',
          customReply: formatMissingDetailsMessage(session)
        };
      }
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA_DETALLES',
        customReply: formatDetailsConfirmation(session)
      };
    }

    // 2) Procesar mensaje: extract local + AI enfocado en detalles
    const result = await ingestOperatorMessage(session, trimmed, { stage: 'details' });

    if (result.doubts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA_DETALLES',
        customReply: formatOperatorDoubtsMessage(result.doubts)
      };
    }

    const missingDetails = getMissingDetailsFields(session);
    if (missingDetails.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CAPTURA_DETALLES',
        customReply: formatMissingDetailsMessage(session)
      };
    }

    // Si ya venían también los productos en el mismo mensaje -> resumen final
    const missingProducts = getMissingProductFields(session);
    if (!missingProducts.length) {
      return {
        success: true,
        nextState: 'OPERADOR_CONFIRMAR',
        customReply: formatOperatorSummary(session)
      };
    }

    // Detalles completos -> mostrar datos captados y preguntar confirmación
    session.operatorDraft.detailsPendingConfirm = true;
    return {
      success: true,
      nextState: 'OPERADOR_CAPTURA_DETALLES',
      customReply: formatDetailsConfirmation(session)
    };
  }
});
