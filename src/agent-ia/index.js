// ==============================================================================
// OBJETIVO: Orquestador Principal del Nuevo Agente Autónomo con IA (V2).
// Maneja sesiones SQLite, memoria conversacional, MUTE y bucle con LLM.
// ==============================================================================

import { getSession, saveSession, resetSession } from '../core/db.js';
import { runAiAgentTurn, parseReplyToBubbles } from './llm-runner.js';
import { executeAgentTool } from './tools/tool-handlers.js';
import { analyzeMessageContext, isPaymentConfirmationText } from './context-analyzer.js';
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

    // Petición explícita de humano: silencio absoluto hacia el cliente y alerta inmediata a admin
    if (/^(humano|asesor|vendedor|operador|hablar con alguien|persona real|sos)$/i.test(cleanText)) {
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      if (alertAdmin) {
        await alertAdmin({
          type: 'SOS',
          title: 'CLIENTE PIDIÓ ATENCIÓN HUMANA',
          body: `El cliente escribió: "${cleanText}".\n\n🤫 *El bot se silenció automáticamente (MUTE). Responde directamente desde WhatsApp.*`
        });
      }
      session.history.turns.push({ role: 'user', text: cleanText });
      saveSession(sessionId, session);
      return null;
    }

    // Confirmación de pago / comprobante de transferencia (ej: compra de barril desechable o web)
    if (isPaymentConfirmationText(cleanText)) {
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      session.paymentConfirmationReceived = true;
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      const reply = '¡Muchas gracias! Revisamos y te confirmamos enseguida 🍹';
      session.history.turns.push({ role: 'model', text: reply });
      session.lastOutboundAt = Date.now();

      if (alertAdmin) {
        await alertAdmin({
          type: 'SUCCESS',
          title: 'COMPROBANTE DE PAGO RECIBIDO (BARRIL/COMPRA)',
          body: `💰 *Nuevo comprobante de pago recibido*\n\n💬 *Mensaje cliente:* "${cleanText}"\n\n✅ *El bot respondió:* "${reply}"\n\n🤫 *El bot quedó silenciado (MUTE) para que verifiques la transferencia en la cuenta y confirmes el pedido directamente desde WhatsApp.*`
        });
      }

      saveSession(sessionId, session);
      return reply;
    }

    // =========================================================================
    // 2. ANÁLISIS DE CONTEXTO Y LLAMADA AL MOTOR IA
    // =========================================================================
    const contextMeta = analyzeMessageContext(session, cleanText);

    if (contextMeta.detectedGuests) session.guests = contextMeta.detectedGuests;
    if (contextMeta.detectedCelebration) session.celebrationType = contextMeta.detectedCelebration;
    if (contextMeta.detectedDrinksPerPerson) session.drinksPerGuest = contextMeta.detectedDrinksPerPerson;
    if (contextMeta.detectedDate) session.eventDate = contextMeta.detectedDate;
    if (contextMeta.detectedCommune) session.commune = contextMeta.detectedCommune;

    // Preparar historial de turnos recientes (máximo 12 turnos)
    const rawTurns = session?.history?.turns || [];
    const conversationTurns = rawTurns.slice(-12);

    // Intercepción determinista: si el bot acaba de preguntar por la carta y el cliente responde afirmativamente
    const lastBotTurn = [...rawTurns].reverse().find((t) => t.role === 'model');
    const askedForCatalog = Boolean(
      lastBotTurn &&
      /¿Te gustaría que te comparta la carta/i.test(lastBotTurn.text)
    );
    const isAffirmativeForCatalog = askedForCatalog && /^(?:s[ií]|si por favor|s[ií] porfa|dale|bueno|claro|por favor|m[aá]ndala|comp[aá]rtela|env[ií]ala|ok|de acuerdo|obvio|me gustar[ií]a|porfa|yapo|ya po)\b/i.test(cleanText.trim());

    if (isAffirmativeForCatalog) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      const toolResult = await executeAgentTool('send_cocktails_catalog', {}, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });

      const bubbles = parseReplyToBubbles(toolResult.formattedCatalogText, session);
      const textForHistory = Array.isArray(bubbles)
        ? bubbles.map((p) => (typeof p === 'string' ? p : `[IMG:${p.file}]`)).join('\n\n')
        : bubbles;

      session.history.turns.push({ role: 'model', text: textForHistory });
      session.lastOutboundAt = Date.now();
      saveSession(sessionId, session);
      return bubbles || null;
    }

    try {
      const { replyText, toolCallsMade } = await runAiAgentTurn(conversationTurns, cleanText, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });

      // Registrar turno del usuario y del bot (permite entregar respuesta única si allowSingleReply está activo)
      session.history.turns.push({ role: 'user', text: cleanText });
      const canDeliverReply = Boolean(replyText && (!session.isMuted || session.allowSingleReply));
      if (canDeliverReply) {
        const textForHistory = Array.isArray(replyText)
          ? replyText.map((p) => (typeof p === 'string' ? p : `[IMG:${p.file}]`)).join('\n\n')
          : replyText;
        session.history.turns.push({ role: 'model', text: textForHistory });
        session.lastOutboundAt = Date.now();
      }

      delete session.allowSingleReply;
      saveSession(sessionId, session);
      return canDeliverReply ? (replyText || null) : null;

    } catch (err) {
      console.error('[Agent-IA] Error en ejecución:', err.message);
      
      // Fallback de seguridad en caso de falla de API externa: silenciar y alertar en silencio
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      if (alertAdmin) {
        await alertAdmin({
          type: 'SOS',
          title: 'ERROR EN MOTOR IA (AGENTE SILENCIADO)',
          body: `Ocurrió un error al contactar el LLM (${err.message}). El bot se silenció automáticamente para no fallar ante el cliente. Atiende directamente desde WhatsApp.`
        });
      }
      saveSession(sessionId, session);
      // REGLA SUPREMA: NUNCA avisar al usuario de errores ni traspasos. Retornar null (silencio absoluto).
      return null;
    }
  });
}
