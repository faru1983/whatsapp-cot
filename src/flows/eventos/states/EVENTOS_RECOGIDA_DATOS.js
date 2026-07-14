// ==============================================================================
// OBJETIVO: Paso EVENTOS_RECOGIDA_DATOS — entrada del flujo Eventos + datos.
// Pedimos celebración, invitados, fecha y comuna altiro: eso filtra clientes
// interesados vs mirones. Solo invitados es obligatorio para avanzar.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventDataSummary, getBrowseOnlyGoodbye } from '../../../views/templates.js';
import {
  asksPriceOrCatalog,
  wantsBrowseOnlyClose
} from '../../../logic/interruptions.js';
import { matchKeywordIntent, rulesWebVsChat } from '../../../logic/keyword-intent.js';
import { applyEventDataFromMessage } from '../../../logic/eventos-helpers.js';

// Bienvenida en 2 burbujas: primero el servicio + web; luego pedimos los datos
const WELCOME_TEXTS = [
  `👋 *Servicio para Eventos* — estación de coctelería autoservicio para tu celebración.

Puedes cotizar fácil y rápido en la web 👉 *www.cocktailsontap.cl/eventos*`,
  `Si prefieres seguir por aquí, cuéntame: *qué celebras*, cuántos *invitados*, *fecha* y *comuna*.

Ejemplo: _"Matrimonio, 50 invitados, 15 de mayo, Las Condes"_`
];

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DEL EVENTO (entrada)]
El cliente acaba de entrar a Servicio para Eventos. Debe dar datos (celebración, invitados, fecha, comuna) o tiene dudas.
1. Responde su duda de forma breve y amigable.
2. REGLA DE LOGÍSTICA: La instalación y logística la coordina el equipo; Dispensador gratis, Muro $50.000. NUNCA inventes tarifas de envío.
3. NUNCA cotices ni calcules precios finales todavía.
4. Puedes mencionar la web www.cocktailsontap.cl/eventos si pregunta precios o prefiere cotizar solo; no lo presentes como menú obligatorio web vs chat.
5. Al finalizar, si aún no hay cantidad de invitados, pídela. Celebración, fecha y comuna son opcionales: no insistas si no las dio.`;

/**
 * shortQuestionForSession: Pregunta corta según si ya hay invitados en sesión.
 *
 * @param {object} session - Sesión del cliente
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (!session.guests) {
    return `¿Cuántos *invitados* serán aproximadamente?`;
  }
  return `¿Me confirmas los datos del evento para seguir?`;
}

/**
 * messageLooksLikeGuests: ¿El mensaje trae un número que parece cantidad de invitados?
 * (Evita confundir el día de una fecha con invitados.)
 *
 * @param {string} messageText
 * @returns {boolean}
 */
function messageLooksLikeGuests(messageText) {
  const clean = String(messageText || '').replace(
    /\b\d+\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi,
    ''
  );
  return /\b(\d+)\s*(personas|invitados|pax|inv)?\b/i.test(clean);
}

export const EVENTOS_RECOGIDA_DATOS = defineState({
  id: 'EVENTOS_RECOGIDA_DATOS',
  texts: WELCOME_TEXTS,
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // "NO"/"SOS" puro → success:false para que el engine haga handoff humano
    if (/^(no|sos)$/i.test(String(messageText || '').trim())) {
      return { success: false };
    }

    // Mirón / después / Instagram → despedida + mute (filtro de interés)
    if (wantsBrowseOnlyClose(messageText)
        && !/^(no|nop|nope|nah)$/i.test(String(messageText || '').trim())) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    // Quiere ir a la web (sin estar dando datos) → link + cierre suave
    const webLabel = matchKeywordIntent(messageText, rulesWebVsChat().filter((r) => r.label === 'WEB'));
    if (webLabel === 'WEB' && !session.guests && !messageLooksLikeGuests(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: `¡Listo! Cotiza aquí: https://cocktailsontap.cl/eventos\nSi surge una duda, escríbeme. 🥂`,
        mute: true
      };
    }

    // Extraemos lo que venga (puede ser 1 dato o varios)
    const hasNewInfo = applyEventDataFromMessage(messageText, session);
    const guestsJustParsed = messageLooksLikeGuests(messageText);

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

    // No entendimos nada nuevo → engine: FAQ → IA → re-pregunta
    return { success: false };
  }
});
