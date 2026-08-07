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
import { getBarrilesPurchaseSummary, getBarrilesContactIntroAsk } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE CONTACTO PARA COMPRA DE BARRILES]
El cliente ya aprobó el resumen. Pedimos nombre y correo (copia), dirección, y si faltan fecha/comuna.
1. Pide solo lo que falte. WhatsApp ya lo tenemos del chat.
2. NUNCA inventes precios nuevos.
3. Si la fecha es solo un mes, pide el día tentativo.
4. Dirección: calle y número (ej. "Los Alerces 123").
5. Al completar, confirmamos los datos (OK) antes de crear la compra.`;

export const BARRILES_DATOS_CONTACTO = defineState({
  id: 'BARRILES_DATOS_CONTACTO',
  promptQuestion: (session) => {
    ensureContactBucket(session);
    ensureClientDataBucket(session);
    const missing = getMissingBarrilesFields(session);
    const needsPerson = missing.some((m) => ['nombre', 'apellido', 'email'].includes(m));
    const onlyPerson = missing.every((m) => ['nombre', 'apellido', 'email'].includes(m));
    if (needsPerson && onlyPerson) {
      return getBarrilesContactIntroAsk();
    }
    return askForMissingBarriles(missing, session);
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
