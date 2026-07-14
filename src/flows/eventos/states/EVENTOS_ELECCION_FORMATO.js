// ==============================================================================
// OBJETIVO: Paso EVENTOS_ELECCION_FORMATO — Dispensador vs Muro.
// Al elegir, enviamos pitch corto + carta y pasamos directo a menú (sin segundo ok).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventFormatPitch } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesDispensadorOMuro } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  ensureEventOrderBuilder,
  buildMenuEntryReplies
} from '../../../logic/eventos-helpers.js';

const SHORT_Q = `¿Qué formato prefieres, *Dispensador* o *Muro*?`;

const AI_PROMPT = `[SISTEMA - ESTADO: PREGUNTAS SOBRE FORMATO DE EVENTO]
El cliente ya recibió la recomendación de formato (Dispensador Portátil o Muro de Coctelería) pero tiene dudas en lugar de elegir.
1. Responde su duda de forma breve y amigable.
2. REGLA DE LOGÍSTICA: Instalación Dispensador = gratis; Muro = $50.000. NUNCA inventes tarifas de envío.
3. NUNCA cotices ni calcules precios finales todavía.
4. Al finalizar, recuérdale elegir entre *Dispensador Portátil* o *Muro de Coctelería*.`;

export const EVENTOS_ELECCION_FORMATO = defineState({
  id: 'EVENTOS_ELECCION_FORMATO',
  promptQuestion: () => `Por favor, confírmame si prefieres el *Dispensador Portátil* o el *Muro de Coctelería* para continuar.`,
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['DISPENSADOR', 'MURO'],
      keywordRules: rulesDispensadorOMuro(),
      labelHints: {
        DISPENSADOR: 'Elige opción 1 / Dispensador Portátil (instalación gratis, mínimo 10L). También: "1", "uno", "primera".',
        MURO: 'Elige opción 2 / Muro de Coctelería (instalación con costo, mínimo 30L). También: "2", "dos", "segunda".'
      }
    });

    if (intent === 'MURO' || intent === 'DISPENSADOR') {
      session.eventoFormato = intent === 'MURO' ? 'Muro de Coctelería' : 'Dispensador Portátil';
      const formatKey = getEventFormatKey(session.eventoFormato);
      ensureEventOrderBuilder(session, formatKey);

      // Pitch de lo incluido + carta/precios → menú de cócteles (sin pedir otro ok)
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: [
          getEventFormatPitch(formatKey),
          ...buildMenuEntryReplies(session, formatKey)
        ]
      };
    }

    return { success: false };
  }
});
