// ==============================================================================
// OBJETIVO: Paso EVENTOS_RECOGIDA_DATOS — celebración, invitados, fecha, comuna.
// El cliente puede mandar todo junto o de a uno; solo invitados es obligatorio.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventDataSummary, getBrowseOnlyGoodbye } from '../../../views/templates.js';
import { asksPriceOrCatalog, isOnlyBrowsing, wantsInstagramOrSocial } from '../../../logic/interruptions.js';
import { applyEventDataFromMessage } from '../../../logic/eventos-helpers.js';

const AI_PROMPT = `[SISTEMA - ESTADO: PREGUNTAS SOBRE DATOS O LOGÍSTICA DE EVENTOS]
El cliente está dando datos del evento de a poco (celebración, invitados, fecha, comuna) o tiene dudas.
1. Responde su duda de forma breve y amigable.
2. REGLA DE LOGÍSTICA: La instalación y logística de eventos la coordina el equipo, y para el Dispensador es gratis, y para el Muro cuesta $50.000. NUNCA inventes tarifas de envío adicionales.
3. NUNCA cotices ni calcules precios finales todavía.
4. Al finalizar, si aún no hay cantidad de invitados, pídela. Celebración, fecha y comuna son opcionales: no insistas si no las dio.`;

/**
 * shortQuestionForSession: Pregunta corta según si ya hay invitados en sesión.
 *
 * @param {object} session - Sesión del cliente
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (!session.guests) return `¿Cuántos invitados serán aproximadamente?`;
  return `¿Me confirmas los datos del evento para seguir?`;
}

export const EVENTOS_RECOGIDA_DATOS = defineState({
  id: 'EVENTOS_RECOGIDA_DATOS',
  promptQuestion: () => [
    `Para armar una cotización personalizada, cuéntame: *qué celebras*, cuántos *invitados*, *fecha* y *comuna*.`,
    `Ejemplo: _"matrimonio, 50 invitados, 15 de mayo, Las Condes"_`
  ],
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // "NO"/"SOS" puro → success:false para que el engine haga handoff humano
    // (no parsear como comuna; no tratarlo como "solo mirando")
    if (/^(no|sos)$/i.test(String(messageText || '').trim())) {
      return { success: false };
    }

    // Solo mira / Instagram → despedida (antes de parsear)
    if (isOnlyBrowsing(messageText) || wantsInstagramOrSocial(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    // Extraemos lo que venga (puede ser 1 dato o varios)
    const hasNewInfo = applyEventDataFromMessage(messageText, session);
    const guestsJustParsed = /\b(\d+)\s*(personas|invitados|pax|inv)?\b/i.test(
      messageText.replace(/\b\d+\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi, '')
    );

    // Pregunta de precios sin datos → web corta, seguimos pidiendo invitados
    const isAskingForPriceWithoutData = asksPriceOrCatalog(messageText)
      && !session.guests
      && !guestsJustParsed;
    if (isAskingForPriceWithoutData) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Precios en https://cocktailsontap.cl/eventos 🍸\n\nPara seguir aquí, ¿cuántos *invitados* serán aprox?`
      };
    }

    // Con invitados → resumen para confirmar (ok) antes de recomendar formato
    if (session.guests) {
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_DATOS',
        customReplies: getEventDataSummary(session)
      };
    }

    // Parcial sin invitados (ej. solo "cumpleaños") → pedir SOLO invitados
    if (hasNewInfo) {
      const got = [];
      if (session.celebrationType) got.push(`celebración: *${session.celebrationType}*`);
      if (session.date) got.push(`fecha: *${session.date}*`);
      if (session.location) got.push(`comuna: *${session.location}*`);

      const ack = got.length > 0
        ? `Perfecto, anoté ${got.join(', ')}. `
        : `Perfecto. `;

      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `${ack}Para recomendarte el formato, ¿cuántos *invitados* serán aproximadamente?`
      };
    }

    // No entendimos nada nuevo → engine: FAQ → IA → re-pregunta (y SOS si escribió "NO")
    return { success: false };
  }
});
