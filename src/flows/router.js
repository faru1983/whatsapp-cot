import { WELCOME_SECONDARY_FILTER, SHORT_INTENT_QUESTION, MENSAJE_AMBAS } from '../views/templates.js';
import { STATE_PROMPTS } from '../views/prompts.js';
import { matchKeywordIntent, rulesRouterIntencion, rulesWebVsChat } from '../logic/keyword-intent.js';
import { resolveDecisionIntent } from '../logic/decision-intent.js';

// ==============================================================================
// OBJETIVO: Estado inicial del bot (punto de entrada de la conversación).
// Cuando un cliente escribe por primera vez, el bot no sabe si quiere barriles
// o eventos. Este archivo define ese primer paso y redirige al flujo correcto.
// Lo usa engine.js a través de statesMap en flows/index.js.
//
// Embudo típico: Instagram → WhatsApp con "Desechable" o "Evento" prellenado.
// La minoría saluda o escribe una pregunta libre; ahí usamos la bienvenida
// cálida + la pregunta con los nombres oficiales del producto.
//
// Intención inicial (antes de "ambas"): solo keywords (cajita 1).
// Si no hay match → engine: FAQ/IA (cajita 3). Es un paso abierto.
//
// Después de mostrar el resumen "ambas": sí usamos keywords → NLU
// (web vs barriles vs eventos), porque ya es una decisión de menú corta.
// ==============================================================================

/** Pregunta post-ambas: web o que le cuenten de un producto (para NLU). */
const PREGUNTA_POST_AMBAS =
  '¿Prefieres revisar la página web o quieres que te cuente más sobre Barriles Desechables o el Servicio para Eventos?';

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
    // Cajita 1: palabras clave → BARRILES / EVENTOS / AMBAS
    const intent = matchKeywordIntent(messageText, rulesRouterIntencion(), {
      log: true,
      logContext: 'router'
    });

    // --- Rama 1: el cliente quiere barriles desechables ---
    if (intent === 'BARRILES') {
      session.userIntent = 'BARRILES'; // Guardamos la intención para fallbacks futuros
      return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
    }

    // --- Rama 2: el cliente quiere servicio para eventos ---
    if (intent === 'EVENTOS') {
      session.userIntent = 'EVENTOS';
      return { success: true, nextState: 'EVENTOS_FILTRO_CANAL' };
    }

    // --- Rama 3: primera vez que dice "ambas" → mostramos resumen educativo ---
    if (intent === 'AMBAS' && !session.hasAskedAmbas) {
      session.hasAskedAmbas = true; // Marcamos que ya vimos el resumen
      return {
        success: true,
        nextState: 'ESPERANDO_INTENCION', // Nos quedamos aquí para que elija una sola opción
        // 3 burbujas: barriles → eventos → pregunta (web o producto)
        customReplies: MENSAJE_AMBAS
      };
    }

    // --- Rama 4: después del resumen "ambas" → decisión web / barriles / eventos ---
    // Keywords primero; si fallan (ej. "lo veré"), el clasificador NLU elige.
    if (session.hasAskedAmbas) {
      // Solo la regla WEB de canal + BARRILES/EVENTOS del router (sin AMBAS otra vez)
      const postAmbasRules = [
        ...rulesWebVsChat().filter((r) => r.label === 'WEB'),
        ...rulesRouterIntencion().filter((r) => r.label === 'BARRILES' || r.label === 'EVENTOS')
      ];

      const choice = await resolveDecisionIntent({
        messageText,
        session,
        stepQuestion: PREGUNTA_POST_AMBAS,
        allowedLabels: ['WEB', 'BARRILES', 'EVENTOS'],
        keywordRules: postAmbasRules,
        labelHints: {
          // Hints cortos y semánticos: listar muchas frases o negar "gracias"/"ok"
          // aquí puede sesgar al NLU (a veces asocia la palabra aunque diga NO).
          // El ruido ("gracias", "ok") ya se corta en isDecisionNoise antes del NLU.
          WEB: 'Quiere ir a la página web / link / sitio (no seguir cotizando por este chat).',
          BARRILES: 'Quiere saber más o cotizar Barriles Desechables por este chat.',
          EVENTOS: 'Quiere saber más o cotizar Servicio para Eventos por este chat.'
        }
      });

      if (choice === 'WEB') {
        // mute: true silencia el bot para no interferir con la navegación en la web
        return {
          success: true,
          nextState: 'CERRADO',
          customReply: `¡Perfecto! Si tienes alguna duda me avisas. 🍹`,
          mute: true
        };
      }
      // NLU puede detectar barriles/eventos con typos o frases naturales
      if (choice === 'BARRILES') {
        session.userIntent = 'BARRILES';
        return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
      }
      if (choice === 'EVENTOS') {
        session.userIntent = 'EVENTOS';
        return { success: true, nextState: 'EVENTOS_FILTRO_CANAL' };
      }
    }

    // No detectamos intención clara → engine.js activará FAQ o IA como fallback
    return { success: false };
  }
};
