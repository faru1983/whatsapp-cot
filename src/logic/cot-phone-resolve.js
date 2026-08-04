// ==============================================================================
// OBJETIVO: Resolver teléfono E.164 desde JID de sesión o mensaje Baileys (@lid / PN).
// ==============================================================================
import { jidToE164 } from './cot-event-quote.js';

/**
 * resolveClientPhoneE164: Obtiene +569… desde sessionId PN o mapping LID de Baileys.
 *
 * @param {{ message?: object, sock?: object, sessionId?: string }} ctx
 * @returns {Promise<string>} E.164 o cadena vacía
 */
export async function resolveClientPhoneE164(ctx = {}) {
  const { message, sock, sessionId } = ctx;
  const key = message?.key || {};
  let mappedPn = null;

  try {
    if (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@lid')) {
      mappedPn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid) || null;
    }
  } catch {
    // ignore mapping errors
  }

  const realJid =
    key.remoteJidAlt ||
    key.senderPn ||
    mappedPn ||
    (typeof sessionId === 'string' && sessionId.endsWith('@s.whatsapp.net') ? sessionId : null) ||
    key.participantAlt ||
    key.participant ||
    sessionId ||
    '';

  if (String(realJid).endsWith('@lid')) {
    return '';
  }

  return jidToE164(realJid);
}
