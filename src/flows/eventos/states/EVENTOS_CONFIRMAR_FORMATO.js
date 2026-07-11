// ==============================================================================
// OBJETIVO: Paso EVENTOS_CONFIRMAR_FORMATO — pitch + ok / cambiar formato.
// Decisión corta → keywords + NLU. NO es paso de datos.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventFormatPitch } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarFormatoEvento } from '../../../logic/keyword-intent.js';
import {
  getEventFormatKey,
  ensureEventOrderBuilder,
  buildMenuEntryReplies
} from '../../../logic/eventos-helpers.js';

const SHORT_Q = `¿Continuamos con este formato? Escribe *ok* o dime si prefieres el otro.`;

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR FORMATO DE EVENTO]
El cliente ya eligió Dispensador o Muro y recibió el pitch (qué incluye el servicio).
Ahora debe confirmar con "ok" para ver la carta, o pedir el otro formato.
1. Responde dudas breves sobre el formato (hielo, vasos, instalación, tiempo).
2. REGLA: Instalación Dispensador = $0. Instalación Muro = $50.000. NUNCA inventes tarifas.
3. NUNCA muestres la carta completa ni cotices precios de cócteles todavía.
4. Al finalizar, pregunta si quiere continuar con ese formato (escribir ok) o preferir el otro.`;

export const EVENTOS_CONFIRMAR_FORMATO = defineState({
  id: 'EVENTOS_CONFIRMAR_FORMATO',
  promptQuestion: (session) => getEventFormatPitch(getEventFormatKey(session.eventoFormato)),
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const currentKey = getEventFormatKey(session.eventoFormato);

    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONTINUAR', 'CAMBIAR_MURO', 'CAMBIAR_DISPENSADOR'],
      keywordRules: rulesConfirmarFormatoEvento(currentKey),
      labelHints: {
        CONTINUAR: 'Confirma el formato actual y quiere ver la carta de cócteles (ok, sí, dale, adelante).',
        CAMBIAR_MURO: 'Quiere cambiar al Muro de Coctelería en lugar del Dispensador.',
        CAMBIAR_DISPENSADOR: 'Quiere cambiar al Dispensador Portátil en lugar del Muro.'
      }
    });

    // Quiere el otro formato → actualizamos y reenviamos el pitch
    if (intent === 'CAMBIAR_MURO' || intent === 'CAMBIAR_DISPENSADOR') {
      session.eventoFormato = intent === 'CAMBIAR_MURO' ? 'Muro de Coctelería' : 'Dispensador Portátil';
      const formatKey = getEventFormatKey(session.eventoFormato);
      ensureEventOrderBuilder(session, formatKey);
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_FORMATO',
        customReplies: getEventFormatPitch(formatKey)
      };
    }

    // Confirma → carta + sugerencia de litros + pregunta de cócteles
    if (intent === 'CONTINUAR') {
      const formatKey = getEventFormatKey(session.eventoFormato);
      ensureEventOrderBuilder(session, formatKey);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_MENU',
        customReplies: buildMenuEntryReplies(session, formatKey)
      };
    }

    return { success: false };
  }
});
