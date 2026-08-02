// ==============================================================================
// OBJETIVO: Paso BARRILES_DATOS_CONTACTO — datos para crear la compra en la web.
// Pedimos nombre, apellido, email (y fecha/comuna si faltan). WhatsApp del JID.
// Al completar → BARRILES_CONFIRMAR_COMPRA (resumen) → API.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { ensureContactBucket, getEmailTypoSuggestion } from '../../../logic/cot-contact.js';
import {
  ensureClientDataBucket,
  applyBarrilesDataFromMessage,
  getMissingBarrilesFields,
  askForMissingBarriles
} from '../../../logic/cot-barriles-contact.js';
import { getBarrilesPurchaseSummary } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE CONTACTO PARA COMPRA DE BARRILES]
El cliente ya aprobó el resumen y quiere generar la compra online.
1. Pide solo lo que falte: nombre, apellido, email, dirección de despacho, y si faltan: fecha o comuna.
2. El WhatsApp ya lo tenemos del chat; no lo pidas salvo que el cliente lo corrija.
3. NUNCA inventes precios nuevos; la compra formal la crea el sistema web.
4. Si la fecha es solo un mes (ej. "septiembre"), pide el día tentativo.
5. Dirección: calle y número (ej. "Los Alerces 123, Depto 456").
6. Al completar, mostraremos un resumen para confirmar antes de crear la compra.`;

export const BARRILES_DATOS_CONTACTO = defineState({
  id: 'BARRILES_DATOS_CONTACTO',
  promptQuestion: (session) => {
    ensureContactBucket(session);
    ensureClientDataBucket(session);
    const missing = getMissingBarrilesFields(session);
    const intro =
      `Para generar tu *compra online* (detalle + copia en tu correo), necesito unos últimos datos.\n` +
      `_Antes de crear la compra revisaremos juntos que todo esté bien._`;
    return `${intro}\n\n${askForMissingBarriles(missing, session)}`;
  },
  shortQuestion: (session) => {
    ensureContactBucket(session);
    ensureClientDataBucket(session);
    return askForMissingBarriles(getMissingBarrilesFields(session), session);
  },
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureContactBucket(session);
    ensureClientDataBucket(session);

    // flowProgress=true solo si el mensaje aportó un dato nuevo (anti-loop en engine)
    const hasNewInfo = applyBarrilesDataFromMessage(messageText, session);

    const missing = getMissingBarrilesFields(session);
    if (missing.length) {
      let ask = askForMissingBarriles(missing, session);
      // Typo de email (gmial → gmail): sugerimos corrección en vez de aceptar
      const typo = getEmailTypoSuggestion(messageText);
      if (typo && missing.includes('email')) {
        ask =
          `Detecté *${typo.typed}*. ¿Quisiste decir *${typo.suggestion}*?\n` +
          `Escríbelo de nuevo (o confirma el correo correcto) para generar la compra.\n\n${ask}`;
      }
      return {
        success: true,
        nextState: 'BARRILES_DATOS_CONTACTO',
        customReply: ask,
        flowProgress: hasNewInfo
      };
    }

    return {
      success: true,
      nextState: 'BARRILES_CONFIRMAR_COMPRA',
      customReplies: getBarrilesPurchaseSummary(session)
    };
  }
});
