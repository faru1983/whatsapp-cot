// ==============================================================================
// OBJETIVO: Clasificador IA para pasos de DECISIÓN (cajita 2).
// Cuando las keywords no alcanzan, la IA elige UNA etiqueta permitida
// (typos, sinónimos, frases naturales). NO busca FAQ ni genera respuesta al cliente.
// La llamada al modelo vive en llm.js; este archivo es la puerta clara de NLU.
// ==============================================================================
export { classifyStepIntent } from '../core/llm.js';

/**
 * lastBotText: Último mensaje del bot en el historial (contexto para el clasificador).
 * Así la IA sabe qué se preguntó, no solo el texto corto del paso.
 *
 * @param {object} session - Sesión actual
 * @returns {string}
 */
export function lastBotText(session) {
  const turns = session?.history?.turns;
  if (!Array.isArray(turns) || turns.length === 0) return '';
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'model' && turns[i]?.text) return String(turns[i].text);
  }
  return '';
}
