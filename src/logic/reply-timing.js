// ==============================================================================
// OBJETIVO: Pausas entre respuestas del bot (más naturales en WhatsApp).
// afterUser: espera antes del primer mensaje tras procesar al cliente.
// betweenBubbles: espera entre burbujas de un mismo turno (texto / imagen / menú).
// En WhatsApp real mostramos "escribiendo…" durante la espera.
// ==============================================================================

/**
 * sleepMs: Espera N milisegundos. Si ms ≤ 0, no hace nada.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * showTyping: Marca el chat como "escribiendo…" (Baileys). Fallo silencioso.
 *
 * @param {object|null} sock - Socket WhatsApp (null en CLI)
 * @param {string|null} jid - Destinatario
 * @returns {Promise<void>}
 */
async function showTyping(sock, jid) {
  if (!sock || !jid || typeof sock.sendPresenceUpdate !== 'function') return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (err) {
    // No bloqueamos el envío si la presencia falla
    console.warn('presence composing falló:', err?.message || err);
  }
}

/**
 * waitBeforeFirstReply: Pausa tras responder el usuario, antes de la 1ª burbuja.
 *
 * @param {object|null} sock
 * @param {string|null} jid
 * @param {{ afterUserMs?: number }} timing - Desde loadBotConfig().replyTiming
 * @returns {Promise<void>}
 */
export async function waitBeforeFirstReply(sock, jid, timing) {
  const ms = Number(timing?.afterUserMs) || 0;
  if (ms <= 0) return;
  await showTyping(sock, jid);
  await sleepMs(ms);
}

/**
 * waitBetweenBubbles: Pausa entre burbuja N-1 y N (solo si index > 0).
 *
 * @param {object|null} sock
 * @param {string|null} jid
 * @param {{ betweenBubblesMs?: number }} timing
 * @param {number} index - Índice de la burbuja que vamos a enviar (0 = primera)
 * @returns {Promise<void>}
 */
export async function waitBetweenBubbles(sock, jid, timing, index) {
  if (!index || index <= 0) return;
  const ms = Number(timing?.betweenBubblesMs) || 0;
  if (ms <= 0) return;
  await showTyping(sock, jid);
  await sleepMs(ms);
}
