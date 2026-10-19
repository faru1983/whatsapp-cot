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

    // Proteger guests: solo actualizar si no existe o si el nuevo mensaje trae mención explícita o número grande (>= 10)
    if (contextMeta.detectedGuests) {
      if (!session.guests || contextMeta.detectedGuests >= 10) {
        session.guests = contextMeta.detectedGuests;
      }
    }
    if (contextMeta.detectedCelebration) session.celebrationType = contextMeta.detectedCelebration;
    if (contextMeta.detectedDrinksPerPerson) session.drinksPerGuest = contextMeta.detectedDrinksPerPerson;
    if (contextMeta.detectedDate) session.eventDate = contextMeta.detectedDate;
    if (contextMeta.detectedCommune) session.commune = contextMeta.detectedCommune;

    // Preparar historial de turnos recientes (máximo 12 turnos)
    const rawTurns = session?.history?.turns || [];
    const conversationTurns = rawTurns.slice(-12);

    // =========================================================================
    // 3. STATE-GUARDED SPINE: TRANSICIONES DETERMINISTAS BLINDADAS
    // Si el usuario avanza de forma clara, resolvemos sin depender de la creatividad del LLM.
    // =========================================================================
    const lastBotTurn = [...rawTurns].reverse().find((t) => t.role === 'model');
    const lastBotText = lastBotTurn?.text || '';

    // Caso A: Cliente responde afirmativamente al ofrecimiento de la carta de variedades
    const askedForCatalog = /¿Te gustaría que te comparta la carta/i.test(lastBotText);
    const wantsCatalog = /^(?:s[ií]|si por favor|s[ií] porfa|dale|bueno|claro|por favor|m[aá]ndala|comp[aá]rtela|env[ií]ala|ok|de acuerdo|obvio|me gustar[ií]a|porfa|yapo|ya po)\b/i.test(cleanText.trim()) ||
      /m[aá]ndame la carta|ver la carta|enviar carta|qu[eé] tragos tienen|qu[eé] variedades/i.test(cleanText);

    if ((askedForCatalog && wantsCatalog) || (session.proposalDelivered && wantsCatalog)) {
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
      session.stageStallCount = 0;
      saveSession(sessionId, session);
      return bubbles || null;
    }

    // Caso B: El cliente menciona cócteles / sabores detectados para armar su barra
    if (contextMeta.detectedCocktails && contextMeta.detectedCocktails.items?.length > 0) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      const toolResult = await executeAgentTool('build_custom_cart_quote', { items: contextMeta.detectedCocktails.items }, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });

      const bubbles = parseReplyToBubbles(toolResult.formattedCartText, session);
      const textForHistory = Array.isArray(bubbles)
        ? bubbles.map((p) => (typeof p === 'string' ? p : `[IMG:${p.file}]`)).join('\n\n')
        : bubbles;

      session.history.turns.push({ role: 'model', text: textForHistory });
      session.lastOutboundAt = Date.now();
      session.stageStallCount = 0;
      saveSession(sessionId, session);
      return bubbles || null;
    }

    // Caso C: El cliente confirma el carrito ("sí", "perfecto así", "me parece bien")
    const askedCartValidation = /¿Te parece bien esta selección o te gustaría ajustar alguna variedad\?/i.test(lastBotText);
    const confirmsCart = /^(?:s[ií]|perfecto|me parece bien|as[ií] tal cual|as[ií] est[aá] bien|excelente|de acuerdo|dale|ok)\b/i.test(cleanText.trim());

    if (askedCartValidation && confirmsCart) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      // Si ya conocemos la fecha (por ejemplo la dijo en el primer mensaje), escalamos de inmediato
      if (session.eventDate) {
        await executeAgentTool('silent_admin_escalation', {
          clientQuestion: `Fecha ya conocida: ${session.eventDate}`,
          context: `Cliente confirmó selección de cócteles. Fecha: ${session.eventDate}`
        }, {
          session,
          sessionId,
          alertAdmin,
          applyBusinessLabel,
          contextMeta
        });
        saveSession(sessionId, session);
        return null;
      }

      // Si no tenemos la fecha aún, la preguntamos una sola vez con entusiasmo
      const askDateReply = `¡Excelente elección! 🥂 Con esto ya tenemos tu barra armada.\n\n*¿Para qué fecha estás cotizando tu evento, así revisamos la disponibilidad de inmediato en el calendario?*`;
      session.history.turns.push({ role: 'model', text: askDateReply });
      session.lastOutboundAt = Date.now();
      session.stageStallCount = 0;
      saveSession(sessionId, session);
      return askDateReply;
    }

    // Caso D: Si el bot preguntó la fecha tras confirmar el carrito y el cliente responde la fecha
    const askedEventDate = /¿Para qué fecha estás cotizando tu evento/i.test(lastBotText);
    if (askedEventDate && (contextMeta.detectedDate || cleanText.length > 2)) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      await executeAgentTool('silent_admin_escalation', {
        clientQuestion: cleanText,
        context: `Fecha entregada: ${contextMeta.detectedDate || cleanText}`
      }, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });
      saveSession(sessionId, session);
      return null;
    }

    // Caso E: Si tenemos guests y drinksPerGuest definidos pero aún no se entrega la propuesta y no hay duda lateral
    const hasLateralQuestion = /¿|\?|qu[eé] incluye|c[oó]mo funciona|d[oó]nde|horario|precio/i.test(cleanText);
    if (session.guests && session.drinksPerGuest && !session.proposalDelivered && !hasLateralQuestion) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      const toolResult = await executeAgentTool('calculate_event_estimate', {
        guests: session.guests,
        drinksPerPerson: session.drinksPerGuest
      }, {
        session,
        sessionId,
        alertAdmin,
        applyBusinessLabel,
        contextMeta
      });

      const bubbles = parseReplyToBubbles(toolResult.formattedProposalText, session);
      const textForHistory = Array.isArray(bubbles)
        ? bubbles.map((p) => (typeof p === 'string' ? p : `[IMG:${p.file}]`)).join('\n\n')
        : bubbles;

      session.history.turns.push({ role: 'model', text: textForHistory });
      session.lastOutboundAt = Date.now();
      session.stageStallCount = 0;
      saveSession(sessionId, session);
      return bubbles || null;
    }

    // Caso F: Si el cliente entregó fecha y/o ubicación en su mensaje inicial pero aún no da invitados
    const turnsCount = rawTurns.length;
    if (turnsCount <= 1 && (contextMeta.detectedDate || contextMeta.detectedCommune || contextMeta.rawSector) && !session.guests && !hasLateralQuestion) {
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      let locationLabel = session.commune || contextMeta.rawSector || '';
      let dateLabel = session.eventDate || '';
      let introDetail = '';
      if (dateLabel && locationLabel) introDetail = ` para el *${dateLabel}* en *${locationLabel}*`;
      else if (dateLabel) introDetail = ` para el *${dateLabel}*`;
      else if (locationLabel) introDetail = ` en *${locationLabel}*`;

      const directReply = `¡Qué genial! 🍹 Anotamos tu evento${introDetail}.\n\nPara armarte una propuesta a la medida:\n\n*¿Cuántos invitados aprox. esperan para su celebración?*`;
      session.history.turns.push({ role: 'model', text: directReply });
      session.lastOutboundAt = Date.now();
      session.stageStallCount = 0;
      saveSession(sessionId, session);
      return directReply;
    }

    // =========================================================================
    // 4. CONTADOR DE ESTANCAMIENTO (2-STRIKE STALL COUNTER)
    // =========================================================================
    session.stageStallCount = (session.stageStallCount || 0) + 1;
    if (session.stageStallCount >= 3) {
      console.warn(`[STALL GUARD] Conversación estancada (${session.stageStallCount} intentos). Silenciando y alertando.`);
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      session.history = session.history || { turns: [] };
      session.history.turns.push({ role: 'user', text: cleanText });

      if (alertAdmin) {
        await alertAdmin({
          type: 'SOS',
          title: 'CONVERSACIÓN DETENIDA (STALL GUARD ACTIVADO)',
          body: `El cliente no ha avanzado en los últimos 3 mensajes (último: "${cleanText}").\n\n🤫 *El bot se silenció automáticamente en MUTE para que continúes tú directamente desde WhatsApp sin incomodar al cliente.*`
        });
      }
      saveSession(sessionId, session);
      return null;
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
