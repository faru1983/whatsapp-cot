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
import { applyEventDataFromMessage, extractGuestsFromMessage, asksEventServiceFormatQuestion, asksCoverageAreaQuestion } from '../../../logic/eventos-helpers.js';
import { isLikelyThirdPartyBotReply } from '../../../logic/interruptions.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';

// Bienvenida al entrar al flujo.
// Si ya vieron el menú del router (assistantIntroduced), no repetimos la presentación.
const WELCOME_DIRECT = `*Servicio para Eventos* — estación de coctelería autoservicio para tu celebración.

Puedes cotizar fácil y rápido en la web:
👉 *www.cocktailsontap.cl/eventos*

Si prefieres seguir por aquí, cuéntame: *qué celebras*, cuántos *invitados*, *fecha* y *comuna*.

Ejemplo: _"Matrimonio, 50 invitados, 15 de mayo, Las Condes"_`;

const WELCOME_WITH_INTRO = `Soy el *asistente virtual* de *Cocktails on Tap* y te guiaré con la información del *Servicio para Eventos* (estación de coctelería autoservicio para tu celebración).

Puedes cotizar fácil y rápido en la web:
👉 *www.cocktailsontap.cl/eventos*

Si prefieres seguir por aquí, cuéntame: *qué celebras*, cuántos *invitados*, *fecha* y *comuna*.

Ejemplo: _"Matrimonio, 50 invitados, 15 de mayo, Las Condes"_`;

/**
 * welcomeForSession: Copy de entrada según si el asistente ya se presentó en el menú.
 *
 * @param {object} session
 * @returns {string}
 */
function welcomeForSession(session) {
  return session?.assistantIntroduced ? WELCOME_DIRECT : WELCOME_WITH_INTRO;
}

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DEL EVENTO (entrada)]
Eres el asistente virtual de Cocktails on Tap. El cliente acaba de entrar a Servicio para Eventos. Debe dar datos (celebración, invitados, fecha, comuna) o tiene dudas.
0. Si el asistente ya se presentó en el menú anterior, NO digas "hola" ni vuelvas a presentarte.
1. Responde su duda de forma breve y amigable.
2. REGLA DE COBERTURA: Si el cliente pregunta si vamos a su comuna o ciudad (ej: "van a la serena?"), debes responder afirmativamente indicando: "Sí, trabajamos en toda la Región Metropolitana y La Serena/Coquimbo."
3. REGLA DE LOGÍSTICA: La instalación y logística la coordina el equipo; Dispensador gratis, Muro $50.000. NUNCA inventes tarifas de envío.
4. NUNCA cotices ni calcules precios finales todavía.
5. Puedes mencionar la web www.cocktailsontap.cl/eventos si pregunta precios o prefiere cotizar solo; no lo presentes como menú obligatorio web vs chat.
6. Al finalizar, si aún no hay cantidad de invitados, pídela. Celebración, fecha y comuna son opcionales: no insistas si no las dio.`;

/**
 * shortQuestionForSession: Pregunta corta según si ya hay invitados en sesión.
 *
 * @param {object} session - Sesión del cliente
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (!session.guests) {
    return withAssistantFooter(`¿Cuántos *invitados* serán aproximadamente?`);
  }
  return withAssistantFooter(`¿Me confirmas los datos del evento para seguir?`);
}

/**
 * messageLooksLikeGuests: ¿El mensaje trae un número que parece cantidad de invitados?
 * (Evita confundir el día de una fecha con invitados.)
 *
 * @param {string} messageText
 * @returns {boolean}
 */
function messageLooksLikeGuests(messageText) {
  return extractGuestsFromMessage(messageText) !== null;
}

export const EVENTOS_RECOGIDA_DATOS = defineState({
  id: 'EVENTOS_RECOGIDA_DATOS',
  texts: welcomeForSession,
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

    // Pregunta de cobertura (¿van a X?) → FAQ, no extraer comuna del mensaje
    if (asksCoverageAreaQuestion(messageText) && !session.guests && !messageLooksLikeGuests(messageText)) {
      return { success: false };
    }

    // Mensaje de otro bot/negocio (IA hablando con IA): re-preguntar sin extraer datos
    if (isLikelyThirdPartyBotReply(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Parece que ese mensaje no trae datos de tu evento 😊\n\n¿Me compartes *celebración*, *invitados*, *fecha* y *comuna*?\nEjemplo: _"Matrimonio, 50 invitados, 15 de mayo, Las Condes"_`,
        flowProgress: true
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
        customReply: `Precios en https://cocktailsontap.cl/eventos 🍸\n\nPara seguir aquí, ¿cuántos *invitados* serán aprox?`,
        flowProgress: true
      };
    }

    // Duda sobre dispensador/muro o "solo barriles" → copy fijo (evita leak de razonamiento FAQ/IA)
    if (asksEventServiceFormatQuestion(messageText) && !guestsJustParsed) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `En *Servicio para Eventos* los cócteles van en barril y los sirves con nuestra estación (*Dispensador Portátil* o *Muro de Coctelería*): instalación, hielo, vasos y accesorios incluidos. 🍸

Si buscas solo llevar barriles a tu casa, es nuestro servicio de *Barriles Desechables* (5L).

Para recomendarte el formato ideal, ¿cuántos *invitados* serán aproximadamente?`,
        flowProgress: true
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
        customReply: `${ack}Para recomendarte el formato, ¿cuántos *invitados* serán aproximadamente?`,
        flowProgress: true
      };
    }

    // No entendimos nada nuevo → engine: FAQ → IA → re-pregunta
    return { success: false };
  }
});
