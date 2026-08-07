// ==============================================================================
// OBJETIVO: Paso EVENTOS_DATOS_CONTACTO — datos para crear la cotización en la web.
// Pedimos lo que falte (fecha/comuna/invitados + nombre, apellido, email).
// WhatsApp sale del JID. Al completar → EVENTOS_CONFIRMAR_ENVIO (resumen) → API.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { ensureContactBucket, getEmailTypoSuggestion } from '../../../logic/cot-contact.js';
import {
  applyEventosContactDataFromMessage,
  getMissingEventosContactFields,
  askForMissingEventosContact
} from '../../../logic/cot-eventos-contact.js';
import { getEventosEnvioSummary, getEventosContactIntroAsk } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE CONTACTO PARA COTIZACIÓN WEB]
El cliente ya aprobó el resumen. Pedimos nombre y correo (copia formal), y si faltan: fecha, comuna o invitados.
1. Pide solo lo que falte. WhatsApp ya lo tenemos del chat.
2. NUNCA inventes precios nuevos; la cotización formal la crea el sistema web.
3. Si la fecha es solo un mes (ej. "septiembre"), pide el día tentativo.
4. Al completar, confirmamos los datos de contacto (OK) antes de crear la cotización.`;

export const EVENTOS_DATOS_CONTACTO = defineState({
  id: 'EVENTOS_DATOS_CONTACTO',
  promptQuestion: (session) => {
    ensureContactBucket(session);
    const missing = getMissingEventosContactFields(session);
    // Si faltan nombre/email (entrada típica), usamos el intro corto unificado
    const needsPerson = missing.some((m) => ['nombre', 'apellido', 'email'].includes(m));
    if (needsPerson && missing.every((m) => ['nombre', 'apellido', 'email'].includes(m))) {
      return getEventosContactIntroAsk();
    }
    return askForMissingEventosContact(missing, session);
  },
  shortQuestion: (session) => {
    ensureContactBucket(session);
    return askForMissingEventosContact(getMissingEventosContactFields(session), session);
  },
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureContactBucket(session);

    // flowProgress=true solo si el mensaje aportó un dato nuevo (anti-loop en engine)
    const hasNewInfo = applyEventosContactDataFromMessage(messageText, session);

    const missing = getMissingEventosContactFields(session);
    if (missing.length) {
      let ask = askForMissingEventosContact(missing, session);
      const typo = getEmailTypoSuggestion(messageText);
      if (typo && missing.includes('email')) {
        ask =
          `Detecté *${typo.typed}*. ¿Quisiste decir *${typo.suggestion}*?\n` +
          `Escríbelo de nuevo (o confirma el correo correcto) para la cotización formal.\n\n${ask}`;
      }
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        customReply: ask,
        flowProgress: hasNewInfo
      };
    }

    return {
      success: true,
      nextState: 'EVENTOS_CONFIRMAR_ENVIO',
      customReplies: getEventosEnvioSummary(session)
    };
  }
});
