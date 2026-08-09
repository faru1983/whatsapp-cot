// ==============================================================================
// OBJETIVO: Paso EVENTOS_ELECCION_FORMATO — puerta de entrada Dispensador vs Muro.
// Se usa cuando el cliente eligió Eventos sin traer formato (menú / “evento”).
// Al elegir, envía intro fase A (imagen + tipo de evento) → RECOGIDA_DATOS.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesDispensadorOMuro } from '../../../logic/keyword-intent.js';
import {
  withAssistantFooter,
  formatMenuBlock,
  MENU_WRITE_CTA
} from '../../../logic/flow-rails.js';
import {
  getEventFormatChoiceCaption,
  buildEventFormatChoiceReplies,
  enterEventosWithFormat
} from '../../../logic/eventos-intro.js';

const MENU_BLOCK = formatMenuBlock(['Dispensador', 'Muro']);

// Re-pregunta corta (si dudó o eligió "ambos")
const SHORT_Q = withAssistantFooter(`${MENU_WRITE_CTA}

${MENU_BLOCK}`);

// Respuesta fija si pide los dos formatos a la vez (no cotizamos ambos en el bot)
const REPLY_AMBOS = `Idealmente cotizamos *uno* de los dos servicios (*Dispensador* o *Muro*).

Si tienes un evento especial que requiera *ambos*, podemos evaluarlo con el equipo: escribe *HUMANO*.

Si prefieres seguir acá, ${MENU_WRITE_CTA.toLowerCase()}

${MENU_BLOCK}`;

const AI_PROMPT = `[SISTEMA - ESTADO: ELEGIR FORMATO DE EVENTO]
El cliente está en Servicio para Eventos y debe elegir Dispensador Portátil o Muro de Coctelería.
NUNCA ofrezcas Barriles Desechables ni digas que hay "3 formatos" incluyendo desechable.
1. Responde su duda de forma breve y amigable.
2. REGLA DE LOGÍSTICA: Instalación Dispensador = gratis; Muro = $50.000. NUNCA inventes tarifas de envío.
3. Orientación: Dispensador = eventos de cualquier tamaño (mín. 10L); Muro = grandes/masivos (mín. 30L).
4. Precios/carta: di que dependen del formato, menciona https://www.cocktailsontap.cl/eventos y pide elegir *1* o *2*. No cotices totales aún.
5. Si pide AMBOS formatos: explica que el bot cotiza uno a la vez; para ambos puede escribir HUMANO o elegir Dispensador/Muro.
6. Al finalizar, recuérdale que escriba *1* *Dispensador* o *2* *Muro*.`;

export const EVENTOS_ELECCION_FORMATO = defineState({
  id: 'EVENTOS_ELECCION_FORMATO',
  // Primera entrada ya trae imagen+caption desde el router; esto es fallback/re-entry
  texts: () => buildEventFormatChoiceReplies(),
  promptQuestion: () => getEventFormatChoiceCaption(),
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
        DISPENSADOR: 'Elige opción 1 / Dispensador Portátil (instalación gratis, mínimo 10L, eventos de cualquier tamaño). También: "1", "1️⃣", "uno".',
        MURO: 'Elige opción 2 / Muro de Coctelería (instalación con costo, mínimo 30L, eventos grandes/masivos). También: "2", "2️⃣", "dos".',
        AMBOS: 'Quiere los dos formatos a la vez (ambos, las 2, los 2, 1 y 2, dispensador y muro).'
      }
    });

    // Quiere ambos → explicación fija; sigue en este paso.
    // Sin flowProgress: repetir "ambos" cuenta strike (anti-loop → HUMANO).
    if (intent === 'AMBOS') {
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_FORMATO',
        customReply: REPLY_AMBOS
      };
    }

    if (intent === 'MURO' || intent === 'DISPENSADOR') {
      const formatKey = intent === 'MURO' ? 'muro' : 'dispensador';
      return enterEventosWithFormat(session, formatKey);
    }

    return { success: false };
  }
});
