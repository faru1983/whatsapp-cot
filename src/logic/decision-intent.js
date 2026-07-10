// ==============================================================================
// OBJETIVO: Orquestar la decisión de un paso de menú / sí-no.
// Orden: (1) keywords → (2) clasificador IA. Si ambos fallan → null
// (el engine activará FAQ / respuesta / re-pregunta: cajita 3).
// NO usar en pasos de datos (fecha, comuna, cócteles, litraje).
// Usado por barriles.js, eventos.js y futuros flujos.
// ==============================================================================
import { matchKeywordIntent } from './keyword-intent.js';
import { classifyStepIntent, lastBotText } from './nlu-intent.js';
import { testLog } from '../core/debug-log.js';

/**
 * isDecisionNoise: ¿El mensaje es solo cortesía / ruido, sin elegir opción?
 * Ej.: "gracias", "hola", "ok" solos. NO son una decisión de menú.
 * Si es ruido, no llamamos al NLU (la IA a veces inventa una etiqueta).
 *
 * Importante: se evalúa DESPUÉS de keywords. Así un "ok"/"dale" que sí
 * matchea en reglas de confirmar (cajita 1) sigue funcionando.
 *
 * @param {string} messageText - Lo que escribió el cliente
 * @returns {boolean} true si no debemos clasificar con IA
 */
export function isDecisionNoise(messageText) {
  const trimmed = String(messageText ?? '').trim();
  if (!trimmed) return true;
  // Misma idea que el filtro de saludo/ruido del engine (FAQ omitido)
  return /^(hola|holi|buenas|buen\s*d[ií]a|buenas\s*tardes|buenas\s*noches|hey|hi|hello|ok|okay|dale|gracias|thank(s)?|ya|listo|de\s+nada|genial|super|súper)[\s!.?]*$/i.test(trimmed);
}

/**
 * resolveDecisionIntent: Keywords primero; si fallan, clasificador IA del paso.
 * Solo para menús cortos / sí-no. NO usar en recogida de fecha, comuna o cócteles.
 *
 * Puedes pasar:
 * - keywordRules: lista declarativa { label, test } (recomendado, reutilizable)
 * - keywordGuess: función custom que devuelve etiqueta o null (casos raros)
 *
 * @param {object} opts
 * @param {string} opts.messageText - Mensaje del cliente
 * @param {object} opts.session - Sesión
 * @param {string} opts.stepQuestion - Pregunta del paso
 * @param {string[]} opts.allowedLabels - Etiquetas válidas
 * @param {Array<{ label: string, test: Function }>} [opts.keywordRules] - Reglas de palabras
 * @param {() => string|null} [opts.keywordGuess] - Alternativa custom a keywordRules
 * @param {Record<string, string>} [opts.labelHints] - Significado de cada etiqueta para la IA
 * @returns {Promise<string|null>} Etiqueta o null
 */
export async function resolveDecisionIntent({
  messageText,
  session,
  stepQuestion,
  allowedLabels,
  keywordRules,
  keywordGuess,
  labelHints
}) {
  const labelsHint = Array.isArray(allowedLabels) ? allowedLabels.join('|') : '';

  // --- Cajita 1: palabras clave (rápido, sin costo de IA) ---
  let fromKeywords = null;
  if (Array.isArray(keywordRules) && keywordRules.length > 0) {
    fromKeywords = matchKeywordIntent(messageText, keywordRules);
  } else if (typeof keywordGuess === 'function') {
    fromKeywords = keywordGuess();
  }

  if (fromKeywords) {
    testLog(`decisión: keywords → ${fromKeywords} (opciones: ${labelsHint})`);
    return fromKeywords;
  }

  // --- Ruido / cortesía sin elección → no llamar NLU (evita alucinaciones) ---
  // Ej.: "gracias" no debe volverse EVENTOS solo porque el último mensaje habló de eventos.
  if (isDecisionNoise(messageText)) {
    testLog(`decisión: ruido/cortesía ("${String(messageText).trim()}") → sin NLU → fallback engine`);
    return null;
  }

  // --- Cajita 2: clasificador NLU (typos / sinónimos / frases naturales) ---
  testLog(`decisión: keywords sin match → NLU (opciones: ${labelsHint})`);
  const fromAi = await classifyStepIntent({
    userMessage: messageText,
    stepQuestion,
    allowedLabels,
    lastBotMessage: lastBotText(session),
    labelHints
  });

  if (fromAi) {
    testLog(`decisión: NLU → ${fromAi}`);
  } else {
    testLog(`decisión: NLU sin certeza → fallback engine (FAQ/IA/re-pregunta)`);
  }

  return fromAi;
}

// Re-export útil si un flujo solo necesita keywords sin IA
export { matchKeywordIntent } from './keyword-intent.js';
export { classifyStepIntent, lastBotText } from './nlu-intent.js';
