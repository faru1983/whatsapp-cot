// ==============================================================================
// OBJETIVO: Resolver intenciones de pasos de DECISIÓN (menú corto / sí-no).
// Keywords primero; si fallan, classifyStepIntent (IA) con etiquetas permitidas.
// NO usar en pasos de datos (fecha, comuna, cócteles, litraje).
// Usado por barriles.js y eventos.js.
// ==============================================================================
import { classifyStepIntent } from '../core/llm.js';

/**
 * lastBotText: Último mensaje del bot en el historial (contexto para NLU).
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

/**
 * resolveDecisionIntent: Keywords primero; si fallan, clasificador IA del paso.
 * Solo para menús cortos / sí-no. NO usar en recogida de fecha, comuna o cócteles.
 *
 * @param {object} opts
 * @param {string} opts.messageText - Mensaje del cliente
 * @param {object} opts.session - Sesión
 * @param {string} opts.stepQuestion - Pregunta del paso
 * @param {string[]} opts.allowedLabels - Etiquetas válidas
 * @param {() => string|null} opts.keywordGuess - Devuelve etiqueta por regex o null
 * @param {Record<string, string>} [opts.labelHints] - Significado de cada etiqueta para la IA
 * @returns {Promise<string|null>} Etiqueta o null
 */
export async function resolveDecisionIntent({
  messageText,
  session,
  stepQuestion,
  allowedLabels,
  keywordGuess,
  labelHints
}) {
  // 1) Reglas programáticas (rápido, sin costo de IA)
  const fromKeywords = keywordGuess();
  if (fromKeywords) return fromKeywords;

  // 2) Filtro NLU: ¿respondió al paso aunque con otras palabras / typo?
  const fromAi = await classifyStepIntent({
    userMessage: messageText,
    stepQuestion,
    allowedLabels,
    lastBotMessage: lastBotText(session),
    labelHints
  });
  return fromAi;
}
