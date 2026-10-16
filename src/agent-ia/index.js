// ==============================================================================
// OBJETIVO: Orquestador Principal del Nuevo Agente Autónomo con IA (V2).
// Maneja sesiones SQLite, memoria conversacional, MUTE y bucle con LLM.
// ==============================================================================

import { getSession, saveSession, resetSession } from '../core/db.js';
import { runAiAgentTurn } from './llm-runner.js';
import { analyzeMessageContext } from './context-analyzer.js';
import { jidToE164 } from '../logic/cot-event-quote.js';
import { syncCrmCuriousAsync, syncCrmNameAsync } from '../logic/cot-crm-sync.js';

// Cola de promesas por sessionId para evitar carreras
const sessionQueues = new Map();

function withSessionLock(sessionId, work) {
  const previous = sessionQueues.get(sessionId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  sessionQueues.set(sessionId, current.then(() => {}, () => {}));
  return current;
}

/**
 * processAiAgentMessage: Procesa un mensaje entrante usando el nuevo Agente IA.
 * 
 * @param {string} sessionId - JID o identificador único del chat
 * @param {string} messageText - Texto enviado por el cliente
 * @param {object} options - Callbacks de envío { sendAdminAlert, applyBusinessLabel, clientPhoneE164, pushName }
 * @returns {Promise<string|null>} Respuesta generada para WhatsApp o null si está en Mute
 */
export async function processAiAgentMessage(sessionId, messageText, options = {}) {
  return withSessionLock(sessionId, async () => {
    const alertAdmin = typeof options.sendAdminAlert === 'function' ? options.sendAdminAlert : null;
    const applyBusinessLabel = typeof options.applyBusinessLabel === 'function' ? options.applyBusinessLabel : null;

    let session = getSession(sessionId);
    session.sessionId = sessionId;

    const phone = options.clientPhoneE164 || session.clientPhoneE164 || jidToE164(sessionId);
    if (phone) session.clientPhoneE164 = phone;

    const pushName = String(options.pushName || '').trim();
    if (pushName) session.clientPushName = pushName;

    // Sync Curious CRM inicial
    if (session.clientPhoneE164 && !session.crmCuriousSynced) {
      syncCrmCuriousAsync(session);
    } else if (session.clientPhoneE164 && pushName && !session.crmNameSynced) {
      syncCrmNameAsync(session);
    }

    const cleanText = String(messageText || '').trim();

    // =========================================================================
    // 1. GESTIÓN DE SILENCIO (MUTE) Y COMANDOS DE CONTROL
    // =========================================================================
    if (session.isMuted) {
      if (cleanText === '/unmute' || cleanText === '/reset') {
        session.isMuted = false;
        if (cleanText === '/reset') {
          resetSession(sessionId);
          return '🔄 Sesión reiniciada. El agente IA ya no recuerda la conversación anterior.';
        }
        saveSession(sessionId, session);
        return '✅ Agente IA reactivado.';
      }
      return null;
    }

    if (cleanText === '/reset') {
      resetSession(sessionId);
      return '🔄 Sesión reiniciada. El agente IA ya no recuerda la conversación anterior.';
    }

    if (cleanText === '/mute') {
      session.isMuted = true;
      saveSession(sessionId, session);
      return '🤫 Agente IA silenciado. Usa /unmute para reactivar.';
    }

    session.lastInboundAt = Date.now();

    // Petición explícita de humano
    if (/^(humano|asesor|vendedor|operador|hablar con alguien|persona real|sos)$/i.test(cleanText)) {
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      if (alertAdmin) {
        await alertAdmin({
          type: 'SOS',
          title: 'CLIENTE PIDIÓ ATENCIÓN HUMANA',
          body: `El cliente escribió: "${cleanText}".\n\n🤫 *El bot se silenció automáticamente para que un asesor responda.*`
        });
      }
      session.history.turns.push({ role: 'user', text: cleanText });
      const humanReply = '¡Por supuesto! Te comunico de inmediato con un asesor del equipo para que te ayude con todos los detalles. 🙌';
      session.history.turns.push({ role: 'model', text: humanReply });
      session.lastOutboundAt = Date.now();
      saveSession(sessionId, session);
      return humanReply;
    }

    // =========================================================================
    // 2. ANÁLISIS DE CONTEXTO Y LLAMADA AL MOTOR IA
    // =========================================================================
    const contextMeta = analyzeMessageContext(session, cleanText);

    if (contextMeta.detectedGuests) session.guests = contextMeta.detectedGuests;
    if (contextMeta.detectedCelebration) session.celebrationType = contextMeta.detectedCelebration;
    if (contextMeta.detectedDrinksPerPerson) session.drinksPerGuest = contextMeta.detectedDrinksPerPerson;

    // Preparar historial de turnos recientes (máximo 12 turnos)
    const rawTurns = session?.history?.turns || [];
    const conversationTurns = rawTurns.slice(-12);

    try {
      const { replyText, toolCallsMade } = await runAiAgentTurn(conversationTurns, cleanText, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });

      // Registrar turno del usuario y del bot
      session.history.turns.push({ role: 'user', text: cleanText });
      if (replyText) {
        session.history.turns.push({ role: 'model', text: replyText });
        session.lastOutboundAt = Date.now();
      }

      saveSession(sessionId, session);
      return replyText || null;

    } catch (err) {
      console.error('[Agent-IA] Error en ejecución:', err.message);
      
      // Fallback de seguridad en caso de falla de API externa: silenciar y alertar
      session.isMuted = true;
      if (alertAdmin) {
        await alertAdmin({
          type: 'SOS',
          title: 'ERROR EN MOTOR IA (AGENTE SILENCIADO)',
          body: `Ocurrió un error al contactar el LLM (${err.message}). El bot se silenció para no fallar ante el cliente.`
        });
      }
      saveSession(sessionId, session);
      return '¡Hola! Estamos revisando tu solicitud y un asesor del equipo te escribirá enseguida para responderte.';
    }
  });
}
