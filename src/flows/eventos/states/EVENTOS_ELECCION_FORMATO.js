// ==============================================================================
// OBJETIVO: Paso EVENTOS_ELECCION_FORMATO — Dispensador vs Muro.
// Al elegir, enviamos el pitch de lo incluido y pedimos ok para ver la carta.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventFormatPitch } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesDispensadorOMuro } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  ensureEventOrderBuilder
} from '../../../logic/eventos-helpers.js';
import { img, vid } from '../../../logic/media.js';

const SHORT_Q = `¿Qué formato prefieres: *1* (*Dispensador*) o *2* (*Muro*)?`;

const ASK_INTRO = `¿Quieres ver los *cócteles* disponibles y *precios*? Escribe *sí* o *ok* para continuar.`;

// Respuesta fija si pide los dos formatos a la vez (no cotizamos ambos en el bot)
const REPLY_AMBOS = `Idealmente cotizamos *uno* de los dos servicios (*Dispensador* o *Muro*).

Si tienes un evento especial que requiera *ambos*, podemos evaluarlo con el equipo: escribe *HUMANO*.

Si prefieres seguir acá, elige *1* (*Dispensador*) o *2* (*Muro*).`;

const AI_PROMPT = `[SISTEMA - ESTADO: PREGUNTAS SOBRE FORMATO DE EVENTO]
El cliente ya recibió la recomendación de formato (Dispensador Portátil o Muro de Coctelería) pero tiene dudas en lugar de elegir.
1. Responde su duda de forma breve y amigable.
2. REGLA DE LOGÍSTICA: Instalación Dispensador = gratis; Muro = $50.000. NUNCA inventes tarifas de envío.
3. NUNCA cotices ni calcules precios finales todavía.
4. Si pide AMBOS formatos: explica que el bot cotiza uno a la vez; para ambos puede escribir HUMANO o elegir Dispensador/Muro.
5. Al finalizar, recuérdale elegir entre *Dispensador Portátil* o *Muro de Coctelería*.`;

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
      allowedLabels: ['DISPENSADOR', 'MURO', 'AMBOS'],
      keywordRules: rulesDispensadorOMuro(),
      labelHints: {
        DISPENSADOR: 'Elige opción 1 / Dispensador Portátil (instalación gratis, mínimo 10L). También: "1", "uno", "primera".',
        MURO: 'Elige opción 2 / Muro de Coctelería (instalación con costo, mínimo 30L). También: "2", "dos", "segunda".',
        AMBOS: 'Quiere los dos formatos a la vez (ambos, las 2, los 2, 1 y 2, dispensador y muro).'
      }
    });

    // Quiere ambos → explicación fija; sigue en este paso (sin strike, sin forzar opción)
    if (intent === 'AMBOS') {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_FORMATO',
        customReply: REPLY_AMBOS
      };
    }

    if (intent === 'MURO' || intent === 'DISPENSADOR') {
      session.eventoFormato = intent === 'MURO' ? 'Muro de Coctelería' : 'Dispensador Portátil';
      const formatKey = getEventFormatKey(session.eventoFormato);
      ensureEventOrderBuilder(session, formatKey);

      // Pitch con media: Dispensador = foto, Muro = video; la carta va en INTRO_MENU
      const pitch = getEventFormatPitch(formatKey);
      const pitchPart = formatKey === 'dispensador'
        ? img('eventos_dispensador1.webp', pitch)
        : vid('eventos_muro.mp4', pitch);

      return {
        success: true,
        nextState: 'EVENTOS_INTRO_MENU',
        customReplies: [
          pitchPart,
          ASK_INTRO
        ]
      };
    }

    return { success: false };
  }
});
