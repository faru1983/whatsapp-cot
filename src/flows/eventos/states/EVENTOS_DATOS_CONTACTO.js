// ==============================================================================
// OBJETIVO: Paso EVENTOS_DATOS_CONTACTO — datos uno a uno para cotización formal.
// Orden: fecha → comuna → (invitados si faltan) → nombre/apellido → email → resumen.
// Espejo del checkout Barriles (sin dirección). Dispensador y Muro usan el mismo paso.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { ensureContactBucket, getEmailTypoSuggestion } from '../../../logic/cot-contact.js';
import { toIsoDateFromBotText } from '../../../logic/cot-event-quote.js';
import {
  resolveEventosContactPhase,
  askEventosContactPhase,
  buildEventosContactIntro,
  tryApplyEventosContactPriorCorrection,
  applyEventosContactPhaseFromMessage
} from '../../../logic/cot-eventos-contact.js';
import { getEventosQuoteSummary } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS PARA COTIZACIÓN FORMAL (uno a uno)]
El cliente ya armó cócteles. Pedimos fecha → comuna → nombre → email → resumen.
Usa CONTEXTO DE FORMATO (Dispensador/Muro): no inventes precios; la cotización formal es el resumen final.
1. Pide SOLO el dato de la fase actual.
2. Si la fecha es solo un mes, pide el día tentativo.
3. Si corrige un dato anterior, acéptalo y vuelve a la fase pendiente.
4. Dudas de instalación/logística: Dispensador gratis, Muro ~$50.000 (ya en resumen si aplica).`;

/**
 * shortQuestionForPhase: Re-pregunta corta según la fase pendiente.
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForPhase(session) {
  const phase = session.eventosContactPhase || resolveEventosContactPhase(session);
  return withAssistantFooter(askEventosContactPhase(phase, session));
}

/**
 * goConfirm: Pasa a CONFIRMAR_ENVIO con el resumen completo (cotización + contacto).
 *
 * @param {object} session
 * @returns {object}
 */
function goConfirm(session) {
  session.eventosContactPhase = 'confirm';
  return {
    success: true,
    nextState: 'EVENTOS_CONFIRMAR_ENVIO',
    customReplies: getEventosQuoteSummary(session),
    flowProgress: true
  };
}

/**
 * advanceAfterSave: Recalcula fase y pregunta lo siguiente (o confirma).
 *
 * @param {object} session
 * @param {string} [prefix] - Texto previo (ej. ack de corrección)
 * @returns {object}
 */
function advanceAfterSave(session, prefix = '') {
  const phase = resolveEventosContactPhase(session);
  session.eventosContactPhase = phase;
  if (phase === 'confirm') return goConfirm(session);
  const ask = askEventosContactPhase(phase, session);
  return {
    success: true,
    nextState: 'EVENTOS_DATOS_CONTACTO',
    customReply: prefix ? `${prefix}\n\n${ask}` : ask,
    flowProgress: true
  };
}

/**
 * reaskPhase: Re-pregunta la fase actual sin avance (anti-loop vía flowProgress=false).
 *
 * @param {object} session
 * @param {string} phase
 * @param {string} [prefix]
 * @returns {object}
 */
function reaskPhase(session, phase, prefix = '') {
  const ask = askEventosContactPhase(phase, session);
  return {
    success: true,
    nextState: 'EVENTOS_DATOS_CONTACTO',
    customReply: prefix ? `${prefix}\n\n${ask}` : ask,
    flowProgress: false
  };
}

export const EVENTOS_DATOS_CONTACTO = defineState({
  id: 'EVENTOS_DATOS_CONTACTO',
  texts: (session) => [buildEventosContactIntro(session)],
  shortQuestion: (session) => shortQuestionForPhase(session),
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureContactBucket(session);

    const phase = session.eventosContactPhase || resolveEventosContactPhase(session);
    session.eventosContactPhase = phase;
    const trimmed = String(messageText || '').trim();

    // Ya completo → resumen formal
    if (phase === 'confirm') return goConfirm(session);

    // Corrección de un dato ya pedido (ej. fecha mientras pedimos nombre)
    const priorFix = tryApplyEventosContactPriorCorrection(trimmed, session, phase);
    if (priorFix) {
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        customReply: `${priorFix.ack}\n\n${askEventosContactPhase(phase, session)}`,
        flowProgress: true
      };
    }

    const hasNewInfo = applyEventosContactPhaseFromMessage(messageText, session, phase);

    // Tipografía de email: sugerir dominio común si parece typo
    if (phase === 'email') {
      const typo = getEmailTypoSuggestion(messageText);
      const stillMissingEmail = resolveEventosContactPhase(session) === 'email';
      if (typo && stillMissingEmail) {
        return reaskPhase(
          session,
          'email',
          `Detecté *${typo.typed}*. ¿Quisiste decir *${typo.suggestion}*?\n` +
            `Escríbelo de nuevo (o confirma el correo correcto).`
        );
      }
    }

    // Fecha parcial (solo mes): progreso, pero seguimos en fase fecha pidiendo el día
    if (phase === 'fecha' && hasNewInfo && !toIsoDateFromBotText(session.date)) {
      return {
        success: true,
        nextState: 'EVENTOS_DATOS_CONTACTO',
        customReply: askEventosContactPhase('fecha', session),
        flowProgress: true
      };
    }

    // Nombre incompleto (solo nombre, falta apellido)
    if (phase === 'nombre') {
      const first = String(session.contact?.firstName || '').trim();
      const last = String(session.contact?.lastName || '').trim();
      if (hasNewInfo && first && !last) {
        return {
          success: true,
          nextState: 'EVENTOS_DATOS_CONTACTO',
          customReply: `Gracias *${first}*.\n\n*¿Me confirmas tu apellido?*\n_(ej: Pérez)_`,
          flowProgress: true
        };
      }
    }

    if (!hasNewInfo && resolveEventosContactPhase(session) === phase) {
      // Igual que Barriles: success + flowProgress false → strikes anti-loop en engine
      return reaskPhase(session, phase);
    }

    return advanceAfterSave(session);
  }
});
