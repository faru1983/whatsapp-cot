import { WELCOME_SECONDARY_FILTER, SHORT_INTENT_QUESTION, MENSAJE_AMBAS } from '../views/templates.js';
import { STATE_PROMPTS } from '../views/prompts.js';

// ==============================================================================
// OBJETIVO: Estado inicial del bot (punto de entrada de la conversación).
// Cuando un cliente escribe por primera vez, el bot no sabe si quiere barriles
// o eventos. Este archivo define ese primer paso y redirige al flujo correcto.
// Lo usa engine.js a través de statesMap en flows/index.js.
//
// Embudo típico: Instagram → WhatsApp con "Desechable" o "Evento" prellenado.
// La minoría saluda o escribe una pregunta libre; ahí usamos la bienvenida
// cálida + la pregunta con los nombres oficiales del producto.
// ==============================================================================

/**
 * ESPERANDO_INTENCION: Primer estado de la máquina de estados.
 * Cada estado es un objeto con propiedades que engine.js lee de forma uniforme.
 */
export const ESPERANDO_INTENCION = {
  // Identificador único; debe coincidir con la clave en statesMap
  id: 'ESPERANDO_INTENCION',

  /**
   * promptQuestion: Texto que el bot envía al entrar en este estado.
   * Si el cliente ya pidió "ambas" opciones, usamos la pregunta corta
   * (ya vio el resumen y solo falta que elija un camino).
   *
   * @param {object} session - Datos guardados del cliente en SQLite
   * @returns {string} Mensaje de WhatsApp para el cliente
   */
  promptQuestion(session) {
    return session.hasAskedAmbas
      ? SHORT_INTENT_QUESTION
      : WELCOME_SECONDARY_FILTER;
  },

  // Versión corta: la usa engine.js al re-preguntar tras FAQ/LLM (sin repetir la bienvenida)
  shortQuestion: SHORT_INTENT_QUESTION,

  // Instrucciones extra para la IA cuando no entiende la respuesta del cliente
  aiContextPrompt: STATE_PROMPTS.ESPERANDO_INTENCION,

  /**
   * validateAndProcess: Corazón de cada estado. Lee el mensaje del cliente,
   * decide si la respuesta es válida y hacia qué estado saltar.
   *
   * @param {string} messageText - Lo que escribió el cliente
   * @param {object} session - Sesión mutable (se guarda al final en engine.js)
   * @returns {Promise<object>} Resultado con success, nextState, customReply, etc.
   */
  async validateAndProcess(messageText, session) {
    // Pasamos todo a minúsculas para comparar palabras clave sin importar mayúsculas
    const lowerMessage = messageText.toLowerCase();

    // Expresiones regulares (regex): patrones de texto para detectar intención
    // Incluye variantes del anuncio IG ("Desechable"/"Evento") y lenguaje natural (matrimonio, etc.)
    const choosesBarriles = /\b(barril desechable|barriles desechables|barril portable|barril portables|barriles portable|barriles portables|desechable|desechables|bidon|bidones)\b/i.test(lowerMessage);
    const choosesEventos = /\b(servicio para eventos|evento|eventos|dispensador portatil|dispensador portátil|muro|matrimonio|matrimonios|cumplea[nñ]os)\b/i.test(lowerMessage);
    const choosesAmbas = /\b(ambas|ambos|los dos|los 2|las dos|las 2)\b/i.test(lowerMessage);

    // --- Rama 1: el cliente quiere barriles desechables ---
    if (choosesBarriles) {
      session.userIntent = 'BARRILES'; // Guardamos la intención para fallbacks futuros
      return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
    }

    // --- Rama 2: el cliente quiere servicio para eventos ---
    if (choosesEventos) {
      session.userIntent = 'EVENTOS';
      return { success: true, nextState: 'EVENTOS_FILTRO_CANAL' };
    }

    // --- Rama 3: primera vez que dice "ambas" → mostramos resumen educativo ---
    if (choosesAmbas && !session.hasAskedAmbas) {
      session.hasAskedAmbas = true; // Marcamos que ya vimos el resumen
      return {
        success: true,
        nextState: 'ESPERANDO_INTENCION', // Nos quedamos aquí para que elija una sola opción
        customReply: MENSAJE_AMBAS
      };
    }

    // --- Rama 4: después del resumen, si prefiere ir a la web, cerramos el chat ---
    if (session.hasAskedAmbas) {
      const wantsWeb = /web|link|enlace|veo|reviso|pagina|pag|sitio/i.test(lowerMessage)
        && !/chat|whatsapp|ok|aqui|sigamos|por aqui|por aca|aca/i.test(lowerMessage);

      if (wantsWeb) {
        // mute: true silencia el bot para no interferir con la navegación en la web
        return {
          success: true,
          nextState: 'CERRADO',
          customReply: `¡Perfecto! Si tienes alguna duda me avisas. 🍹`,
          mute: true
        };
      }
    }

    // No detectamos intención clara → engine.js activará FAQ o IA como fallback
    return { success: false };
  }
};
