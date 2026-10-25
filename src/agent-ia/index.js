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

    // Proteger guests: solo actualizar si no existe o si el nuevo mensaje trae mención explícita de personas/invitados
    const explicitGuestMention = /\b(?:personas?|invitados?|adultos?|amigos?|pax|pers\.?)\b/i.test(cleanText);
    if (contextMeta.detectedGuests) {
      if (!session.guests || explicitGuestMention) {
        session.guests = contextMeta.detectedGuests;
      }
    }
    if (contextMeta.detectedCelebration) session.celebrationType = contextMeta.detectedCelebration;
    if (contextMeta.detectedDrinksPerPerson) {
      session.drinksPerGuest = contextMeta.detectedDrinksPerPerson;
      session.drinksPerPerson = contextMeta.detectedDrinksPerPerson;
    }
    if (contextMeta.detectedDate) session.eventDate = contextMeta.detectedDate;
    if (contextMeta.detectedCommune) session.commune = contextMeta.detectedCommune;

    // Preparar historial de turnos recientes (máximo 12 turnos)
    const rawTurns = session?.history?.turns || [];
    const conversationTurns = rawTurns.slice(-12);

    // =========================================================================
    // 3. RIELES DE CONTROL INICIAL (FUERA DE RM / MENOS DE 10L CASA)
    // =========================================================================
    const lastBotTurn = [...rawTurns].reverse().find((t) => t.role === 'model');
    const lastBotText = lastBotTurn?.text || '';

    // Riel Regiones: Fuera de la Región Metropolitana -> link web y MUTE silencioso
    if (contextMeta.detectedOutOfRM) {
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      const reply = `¡Gracias por escribirnos! 🍹 Nuestro servicio de *Bar Móvil Autoservicio* con montaje está disponible exclusivamente en la *Región Metropolitana*.

¡Pero no te quedes sin tus cócteles! Para regiones contamos con *cócteles listos para servir en barriles desechables de 5L (~25 tragos)* con envío a domicilio 📦.

Puedes ver todos los sabores, valores y comprarlos directo aquí:
👉 https://cocktailsontap.cl/barriles`;

      const parsed = parseReplyToBubbles(reply, session);
      session.history.turns.push({ role: 'model', text: reply });
      session.lastOutboundAt = Date.now();
      saveSession(sessionId, session);
      return parsed;
    }

    // Riel Consulta por menos de 10L / 1 solo barril para la casa en RM (< 10L sin evento)
    const isExplicitSmallQuery = /\b(?:1|un|solo)\s*barril\b|\b5\s*l(?:itros?)?\s*(?:para|sin|solo)\b|\bpara\s+(?:la|mi)\s+casa\b/i.test(cleanText);
    if (isExplicitSmallQuery && !session.proposalDelivered && !session.cartSummary) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      const reply = `¡Hola! 🍹 Te cuento que nuestro servicio de *Bar Móvil Autoservicio* con estación, dispensadores, hielo, garnish y vasos incluidos parte desde los *10L (50 cócteles)* — ¡incluso puedes combinar 2 sabores en barriles de 5L!

Si buscas únicamente *1 barril desechable de 5L (~25 tragos)* para disfrutar en casa sin montaje de bar, puedes ver los sabores disponibles y comprarlo directamente en nuestra web:
👉 https://cocktailsontap.cl/barriles

Si prefieres el servicio de Bar Móvil para tu evento: *¿Para cuántos invitados lo tienes pensado y en qué fecha?*`;

      const parsed = parseReplyToBubbles(reply, session);
      session.history.turns.push({ role: 'model', text: reply });
      session.lastOutboundAt = Date.now();
      saveSession(sessionId, session);
      return parsed;
    }

    // =========================================================================
    // 4. MOTOR CONVERSACIONAL 100% IA (CON BASE DE CONOCIMIENTO Y TOOLS)
    // El LLM procesa siempre la conversación con contexto enriquecido,
    // tono de vendedor entretenido y herramientas oficiales.
    // =========================================================================
    try {
      const { replyText, toolCallsMade } = await runAiAgentTurn(conversationTurns, cleanText, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });

      // Si hubo respuesta o tools, reiniciamos el contador de estancamiento
      session.stageStallCount = 0;

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
