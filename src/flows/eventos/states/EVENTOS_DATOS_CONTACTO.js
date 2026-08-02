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
import { getEventosEnvioSummary } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE CONTACTO PARA COTIZACIÓN WEB]
El cliente ya aprobó el resumen. Ahora pedimos datos para la cotización formal (detalle + copia al correo).
1. Pide solo lo que falte: nombre, apellido, email, y si faltan: fecha, comuna o invitados.
2. El WhatsApp ya lo tenemos del chat; no lo pidas salvo que el cliente lo corrija.
3. NUNCA inventes precios nuevos; la cotización formal la crea el sistema web.
4. Si la fecha es solo un mes (ej. "septiembre"), pide el día tentativo.
5. Al completar, mostraremos un resumen para confirmar antes de crear la cotización.`;

export const EVENTOS_DATOS_CONTACTO = defineState({
  id: 'EVENTOS_DATOS_CONTACTO',
  promptQuestion: (session) => {
    ensureContactBucket(session);
    const missing = getMissingEventosContactFields(session);
    const intro =
      `Para dejarte la *cotización formal* (detalle completo + copia en tu correo), necesito unos últimos datos.\n` +
      `_Antes de crearla revisaremos juntos que todo esté bien._`;
    return `${intro}\n\n${askForMissingEventosContact(missing, session)}`;
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
