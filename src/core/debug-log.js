// ==============================================================================
// OBJETIVO: Logs de depuración solo para el simulador local (npm run test:local).
// En WhatsApp real (index.js) quedan apagados para no ensuciar la consola.
// Lo usan engine.js, decision-intent.js, keyword-intent.js y llm.js.
// ==============================================================================
import process from 'node:process';

/**
 * enableTestDebug: Enciende los logs [TEST] (lo llama engine.js al arrancar el CLI).
 */
export function enableTestDebug() {
  process.env.COT_TEST_DEBUG = '1';
}

/**
 * isTestDebug: true solo cuando el simulador local está activo.
 *
 * @returns {boolean}
 */
export function isTestDebug() {
  return process.env.COT_TEST_DEBUG === '1';
}

/**
 * testLog: Imprime una o más líneas con prefijo [TEST].
 * Silencioso fuera del simulador.
 *
 * @param {string} message - Texto (puede ser multilínea)
 */
export function testLog(message) {
  if (!isTestDebug()) return;
  for (const line of String(message).split('\n')) {
    console.log(`[TEST] ${line}`);
  }
}
