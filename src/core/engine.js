// ==============================================================================
// OBJETIVO: Lógica Central (Cerebro de Estados).
// Este archivo procesa todos los mensajes entrantes, manejando la máquina de 
// estados de forma declarativa. Importa los estados desde /states.
// ==============================================================================
import readline from 'node:readline';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { generateResponse, responderFAQ } from './llm.js';
import { loadBotConfig } from './config.js';
import { getSession, saveSession, resetSession } from './db.js';

import { statesMap } from '../flows/index.js';
import { readPrompt } from '../views/prompts.js';
import { buildFaqCatalogContext } from '../logic/utils.js';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

// Configuración cargada una vez al arrancar (incluye umbrales SECURITY_* del .env)
const botConfig = loadBotConfig();
const { maxConsecutiveErrors, maxIntentSwitches } = botConfig.security;

let sendAdminAlert = null;
export function setAdminAlertFunction(fn) {
  sendAdminAlert = fn;
}

/**
 * cliLog: Feedback uniforme del simulador local (npm run test:local).
 * En WhatsApp real estos mensajes no existen; solo ayudan a depurar en consola.
 * Formato fijo: [TEST] mensaje
 *
 * @param {string} message - Texto del aviso (puede ser multilínea)
 */
function cliLog(message) {
  if (!isMainModule) return;
  for (const line of String(message).split('\n')) {
    console.log(`[TEST] ${line}`);
  }
}

/**
 * normalizeForQuestionMatch: Deja el texto comparable (minúsculas, sin acentos ni markdown).
 * Sirve para detectar si el LLM ya escribió la pregunta del paso.
 *
 * @param {string} str - Texto a normalizar
 * @returns {string}
 */
function normalizeForQuestionMatch(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * replyAlreadyAsksQuestion: true si la respuesta ya incluye la pregunta del estado.
 * Evita el patrón redundante: saludo del LLM + la misma pregunta pegada por el engine.
 *
 * @param {string} replyText - Texto generado (LLM o FAQ)
 * @param {string} question - shortQuestion / promptQuestion del estado
 * @returns {boolean}
 */
function replyAlreadyAsksQuestion(replyText, question) {
  if (!replyText || !question) return false;

  const normReply = normalizeForQuestionMatch(replyText);
  const normQ = normalizeForQuestionMatch(question);

  // Coincidencia exacta de la pregunta completa
  if (normReply.includes(normQ)) return true;

  // Coincidencia parcial: el inicio distintivo de la pregunta
  const core = normQ.replace(/^[^a-z0-9]+/, '').slice(0, 45);
  if (core.length >= 18 && normReply.includes(core)) return true;

  // Caso filtro inicial: si el LLM ya preguntó Barriles Desechables vs Servicio para Eventos
  const asksBarrilesPath = /barriles desechables/.test(normReply);
  const asksEventosPath = /servicio para eventos/.test(normReply);
  const questionIsIntentFilter = /barriles desechables/.test(normQ) && /servicio para eventos|evento/.test(normQ);
  if (questionIsIntentFilter && asksBarrilesPath && asksEventosPath) return true;

  return false;
}

/**
 * appendStepQuestionIfNeeded: Anexa la pregunta del paso solo si aún no está en el texto.
 * Así FAQ y dudas reales siguen encaminando, pero "hola" no repite la misma pregunta.
 *
 * @param {string} body - Cuerpo de la respuesta
 * @param {string} question - Pregunta del estado actual
 * @returns {string}
 */
function appendStepQuestionIfNeeded(body, question) {
  if (!question) return body;
  if (replyAlreadyAsksQuestion(body, question)) return body;
  return `${body}\n\n${question}`;
}

export async function processMessage(sessionId, messageText) {
  let session = getSession(sessionId);

  // ==============================================================================
  // 1. SILENCIO (MUTE) Y COMANDOS DEL SISTEMA
  // ==============================================================================
  if (session.isMuted) {
    if (messageText.trim() === '/unmute' || messageText.trim() === '/reset') {
      session.isMuted = false;
      if (messageText.trim() === '/reset') {
        resetSession(sessionId);
        return "🔄 Sesión reiniciada. El bot ya no recuerda lo que hablaron.";
      }
      saveSession(sessionId, session);
      return "✅ Bot reactivado.";
    }
    // Sin respuesta: el CLI mostrará el aviso [TEST] de mute
    return null;
  }

  if (messageText.trim() === '/reset') {
    resetSession(sessionId);
    return "🔄 Sesión reiniciada. El bot ya no recuerda lo que hablaron.";
  }
  if (messageText.trim() === '/mute') {
    session.isMuted = true;
    saveSession(sessionId, session);
    return "🤫 Bot silenciado. Usa /unmute para reactivar.";
  }

  // Inicialización de la sesión si es cliente nuevo
  if (!session.currentState) {
    session.currentState = 'ESPERANDO_INTENCION';
  }

  session.history.turns.push({ role: 'user', text: messageText });

  const currentStateId = session.currentState;
  let currentState = statesMap[currentStateId];

  if (!currentState) {
    const fallbackState =
      session.userIntent === 'BARRILES'
        ? 'BARRILES_FILTRO_CANAL'
        : session.userIntent === 'EVENTOS'
          ? 'EVENTOS_FILTRO_CANAL'
          : 'ESPERANDO_INTENCION';

    cliLog(`WARN: estado desconocido "${currentStateId}" → redirigiendo a ${fallbackState}`);
    session.currentState = fallbackState;
    currentState = statesMap[fallbackState];

    if (!currentState) {
      console.error(`[ERROR] No se pudo resolver fallback para estado inválido: ${currentStateId}.`);
      resetSession(sessionId);
      return "Ha ocurrido un error interno de estado. Se ha reiniciado la sesión.";
    }
  }

  // ==============================================================================
  // 2. CAPA DE SEGURIDAD BÁSICA (Cambios de intención)
  // ==============================================================================
  if (currentStateId !== 'ESPERANDO_INTENCION' && currentStateId !== 'CERRADO') {
    const earlyStates = [
      'BARRILES_FILTRO_CANAL',
      'BARRILES_OFRECER_CATALOGO',
      'BARRILES_OFRECER_COTIZACION',
      'BARRILES_RECOGIDA_PRODUCTOS',
      'EVENTOS_FILTRO_CANAL',
      'EVENTOS_RECOGIDA_DATOS'
    ];
    
    if (earlyStates.includes(currentStateId)) {
      const isCurrentlyEventos = currentStateId.startsWith('EVENTOS_');
      const isCurrentlyBarriles = currentStateId.startsWith('BARRILES_');
      
      const wantsBarriles = /(desechable|barril desechable|para la casa|para el hogar|llevarse)/i.test(messageText);
      const wantsEventos = /(servicio para eventos|para un evento|evento|para mi matrimonio|dispensador port[aá]til|muro de cocteler[ií]a)/i.test(messageText) && !/sin evento/i.test(messageText);

      let switchIntent = false;
      if (isCurrentlyEventos && wantsBarriles && !wantsEventos) switchIntent = 'BARRILES';
      else if (isCurrentlyBarriles && wantsEventos && !wantsBarriles) switchIntent = 'EVENTOS';

      if (switchIntent) {
        session.intentSwitchCount = (session.intentSwitchCount || 0) + 1;
        
        if (session.intentSwitchCount >= maxIntentSwitches) {
          cliLog(`SEGURIDAD: demasiados cambios de intención (>= ${maxIntentSwitches}). Silenciando.`);
          session.isMuted = true;
          if (sendAdminAlert) {
            sendAdminAlert({
              type: 'SOS',
              message: `⚠️ *El cliente necesita asistencia*\nNúmero: ${sessionId}\n\nHa cambiado de opinión entre Barriles y Eventos demasiadas veces (Indecisión extrema).`
            });
          }
          saveSession(sessionId, session);
          return null;
        }

        cliLog(`SWITCH: cliente cambia intención → ${switchIntent}`);
        session.userIntent = switchIntent;
        session.currentState = switchIntent === 'BARRILES' ? 'BARRILES_FILTRO_CANAL' : 'EVENTOS_FILTRO_CANAL';
        session.consecutiveErrors = 0;
        
        const newState = statesMap[session.currentState];
        const reply = typeof newState.promptQuestion === 'function' ? newState.promptQuestion(session) : newState.promptQuestion;
        
        session.history.turns.push({ role: 'model', text: reply });
        saveSession(sessionId, session);
        return reply;
      }
    }
  }

  // ==============================================================================
  // 3. EJECUCIÓN DEL ESTADO ACTUAL (Máquina Declarativa)
  // ==============================================================================
  let processResult;
  try {
    processResult = await currentState.validateAndProcess(messageText, session);
  } catch (error) {
    console.error(`[ERROR] en estado ${currentStateId}:`, error);
    processResult = { success: false };
  }

  let reply = "";

  if (processResult.success) {
    session.consecutiveErrors = 0; // Se resetean los strikes
    
    if (processResult.shouldReset) {
      resetSession(sessionId);
      if (processResult.customReply) {
        return processResult.customReply;
      }
      return null;
    }
    
    if (processResult.nextState && processResult.nextState !== currentStateId) {
       session.currentState = processResult.nextState;
    }
    
    if (processResult.mute) {
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      // El aviso visible al usuario del test lo imprime cliChat (formato [TEST] unificado)
    }

    if (processResult.notifyAdmin && sendAdminAlert) {
      sendAdminAlert(processResult.notifyAdmin);
    }

    // customReplies: varios mensajes separados (ej. carta + pregunta de cotizar)
    // customReply: un solo mensaje (compatibilidad con el resto del flujo)
    if (Array.isArray(processResult.customReplies) && processResult.customReplies.length > 0) {
      const parts = processResult.customReplies.filter((p) => typeof p === 'string' && p.trim());
      for (const part of parts) {
        session.history.turns.push({ role: 'model', text: part });
      }
      saveSession(sessionId, session);
      // Devolvemos array para que index.js / CLI envíen cada bloque por separado
      return parts.length === 1 ? parts[0] : parts;
    }

    if (processResult.customReply) {
      reply = processResult.customReply;
    } else if (processResult.nextState) {
      const nextStateObj = statesMap[processResult.nextState];
      if (nextStateObj && !processResult.mute) {
         reply = typeof nextStateObj.promptQuestion === 'function' ? nextStateObj.promptQuestion(session) : nextStateObj.promptQuestion;
         
         // Si el nuevo estado no tiene un prompt estático (retorna vacío), pero tiene aiContextPrompt,
         // generamos el prompt inicial dinámicamente con la IA.
         if (!reply && nextStateObj.aiContextPrompt) {
           let systemInstruction = readPrompt();
           systemInstruction = `${systemInstruction}\n\n${nextStateObj.aiContextPrompt}`;
           systemInstruction = `${systemInstruction}\n\n[DATOS CONOCIDOS DE LA SESIÓN DE WHATSAPP]:
- Tipo de compra actual: ${session.userIntent || 'No definido'}
- Nombre del cliente: ${session.orderBuilder?.clientData?.name || session.userName || 'No informado'}`;

           if (session.eventoFormato) {
             systemInstruction += `\n- Formato de Evento: ${session.eventoFormato}`;
           }

           const contents = session.history.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] }));
           const config = { temperature: 0.7, maxOutputTokens: 300 };
           cliLog('IA: generando respuesta del siguiente estado...');
           const generated = await generateResponse(config, systemInstruction, contents);
           reply = generated || "";
         }
      }
    }

    if (reply) {
      session.history.turns.push({ role: 'model', text: reply });
      saveSession(sessionId, session);
      return reply;
    }

    saveSession(sessionId, session);
    return null;

  } else {
    // ==============================================================================
    // 4. RED DE SEGURIDAD GLOBAL: SOPORTE Y FAQS
    // ==============================================================================
    session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;

    const questionText = typeof currentState.promptQuestion === 'function' ? currentState.promptQuestion(session) : currentState.promptQuestion;
    const shortQ = typeof currentState.shortQuestion === 'function' ? currentState.shortQuestion(session) : currentState.shortQuestion;
    // Preferimos la pregunta corta para no re-pegar el prompt largo del estado
    const finalQuestion = shortQ || questionText;

    const buildNoInfoReply = () =>
      `Disculpa, por ahora no tengo esa información. 😔\n\nPor favor indícame: _${finalQuestion}_\no escribe *NO* para que alguien de nuestro equipo te contacte.`;

    // 4.0 SOS explícito: el cliente pide hablar con un humano
    const SOS_EXCLUDED_STATES = ['BARRILES_RECOGIDA_DATOS'];
    const trimmedMessage = messageText.trim();
    const wantsExplicitSOS = /^(no|sos)$/i.test(trimmedMessage) && !SOS_EXCLUDED_STATES.includes(currentStateId);
    const wantsHumanHelp = /hablar con|necesito (un )?(asesor|humano)|persona real|equipo comercial|contactar.*equipo/i.test(messageText);

    if (wantsExplicitSOS || wantsHumanHelp) {
      cliLog(`SOS: cliente pidió humano en estado ${currentStateId}.`);
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();

      if (sendAdminAlert) {
        sendAdminAlert({
          type: 'SOS',
          message: `⚠️ *El cliente necesita asistencia*\nNúmero: ${sessionId}\n\nSolicitó hablar con el equipo en el paso "${currentStateId}".\nÚltimo mensaje: "${messageText}"`
        });
      }
      reply = `Disculpa, no te entendí. Te comunicaré con alguien de nuestro equipo para que te ayude directamente. ¡Ya te escriben! 🙌`;
      session.history.turns.push({ role: 'model', text: reply });
      saveSession(sessionId, session);
      return reply;
    }

    // 4.1 Límite de Strikes (Anti-loop) — umbral configurable en SECURITY_MAX_CONSECUTIVE_ERRORS
    if (session.consecutiveErrors >= maxConsecutiveErrors) {
      cliLog(`SEGURIDAD: anti-loop (${session.consecutiveErrors}/${maxConsecutiveErrors}). Silenciando.`);
      session.isMuted = true;
      session.silenciado_timestamp = Date.now();
      
      if (sendAdminAlert) {
        sendAdminAlert({
          type: 'SOS',
          message: `⚠️ *El cliente necesita asistencia*\nNúmero: ${sessionId}\n\nHa dado múltiples respuestas incomprensibles en el paso "${currentStateId}".\nÚltimo mensaje: "${messageText}"`
        });
      }
      saveSession(sessionId, session);
      return null;
    }

    // 4.2 Buscar en faq.json (también usa IA para decidir si aplica y redactar)
    // Saludos / ruido corto no son FAQ: vamos directo al LLM del estado (más natural)
    const isGreetingOrNoise = /^(hola|holi|buenas|buen\s*d[ií]a|buenas\s*tardes|buenas\s*noches|hey|hi|hello|ok|okay|dale|gracias|thank(s)?|ya|listo)[\s!.?]*$/i.test(trimmedMessage);

    let faqResponse = "NO_FAQ";
    if (isGreetingOrNoise) {
      cliLog('FAQ: omitido (saludo/ruido) → fallback IA generativa');
    } else {
      cliLog('FAQ: consultando faq.json + catálogo/despachos (datos.json) con IA...');
      const faqData = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'db', 'faq.json'), 'utf8'));
      faqResponse = await responderFAQ(messageText, faqData);
    }

    if (faqResponse !== "NO_FAQ") {
      // FAQ respondió: re-preguntamos el paso solo si la FAQ no lo hizo ya
      cliLog('FAQ: match encontrado → respondiendo desde FAQ/datos oficiales');
      reply = appendStepQuestionIfNeeded(faqResponse, finalQuestion);
    } else {
      // 4.3 Delegar a la Inteligencia Artificial (LLM Generativo)
      if (!isGreetingOrNoise) {
        cliLog('FAQ: sin match (NO_FAQ) → fallback IA generativa');
      }
      let systemInstruction = readPrompt();
      if (currentState.aiContextPrompt) {
        systemInstruction = `${systemInstruction}\n\n${currentState.aiContextPrompt}`;
      }

      // Misma fuente oficial que el FAQ: evita inventar ingredientes/precios en el fallback
      systemInstruction = `${systemInstruction}\n\n${buildFaqCatalogContext()}
REGLA FALLBACK: Si hablas de ingredientes, precios o despacho RM, usa SOLO DATOS OFICIALES de arriba. No inventes ni completes fichas.`;

      systemInstruction = `${systemInstruction}\n\n[DATOS CONOCIDOS DE LA SESIÓN DE WHATSAPP]:
- Tipo de compra actual: ${session.userIntent || 'No definido'}
- Nombre del cliente: ${session.orderBuilder?.clientData?.name || session.userName || 'No informado'}`;

      if (session.eventoFormato) {
        systemInstruction += `\n- Formato de Evento: ${session.eventoFormato}`;
      }

      // Convertimos el historial al formato que espera Gemini
      const contents = session.history.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] }));
      
      const config = { temperature: 0.7, maxOutputTokens: 300 };
      cliLog('IA: generando respuesta (fallback)...');
      const generated = await generateResponse(config, systemInstruction, contents);

      if (generated) {
         // Si el LLM ya cerró con la pregunta del estado, no la duplicamos
         reply = appendStepQuestionIfNeeded(generated, finalQuestion);
      } else {
         reply = buildNoInfoReply();
      }
    }

    session.history.turns.push({ role: 'model', text: reply });
    saveSession(sessionId, session);
    return reply;
  }
}

// ==============================================================================
// 5. ENTORNO DE PRUEBAS LOCALES (CLI)
// ==============================================================================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * cliChat: Bucle del simulador local.
 * Tras cada mensaje imprime feedback [TEST] uniforme (mute, estado, IA, etc.).
 */
function cliChat() {
  const sessionId = 'cli-test@s.whatsapp.net';

  rl.question('\nTú: ', async (message) => {
    if (message.toLowerCase() === '/exit') {
      rl.close();
      return;
    }

    const sessionBefore = getSession(sessionId);
    const wasMuted = !!sessionBefore.isMuted;
    const stateBefore = sessionBefore.currentState || '(sin estado)';

    const response = await processMessage(sessionId, message);

    const sessionAfter = getSession(sessionId);
    const isMutedNow = !!sessionAfter.isMuted;
    const stateAfter = sessionAfter.currentState || '(sin estado)';

    // --- Respuesta del bot (si hubo) ---
    // Puede ser string o array de bloques (carta + pregunta, etc.)
    if (response) {
      const replies = Array.isArray(response) ? response : [response];
      for (let i = 0; i < replies.length; i++) {
        const label = replies.length > 1 ? `Bot (${i + 1}/${replies.length})` : 'Bot';
        console.log(`\n${label}: ${replies[i]}`);
      }
    }

    // --- Feedback [TEST] siempre, mismo formato ---
    console.log(''); // línea en blanco antes del bloque de debug

    if (!wasMuted && isMutedNow) {
      cliLog(`MUTE activado → estado: ${stateAfter}`);
      cliLog(`Los siguientes mensajes se ignoran. Usa /unmute o /reset.`);
    } else if (wasMuted && isMutedNow) {
      cliLog(`MUTE activo — mensaje ignorado.`);
      cliLog(`Estado: ${stateAfter}. Usa /unmute o /reset.`);
    } else if (wasMuted && !isMutedNow) {
      cliLog(`MUTE desactivado. Bot reactivado.`);
      cliLog(`Estado: ${stateAfter}`);
    } else if (!response) {
      cliLog(`Sin respuesta del bot.`);
      cliLog(`Estado: ${stateAfter}`);
    } else if (stateBefore !== stateAfter) {
      cliLog(`Estado: ${stateBefore} → ${stateAfter}`);
    } else {
      cliLog(`Estado: ${stateAfter}`);
    }

    cliChat();
  });
}

if (isMainModule) {
  console.log('\n─────────────────────────────────────────');
  console.log('  Simulador Local — WhatsApp Lite Bot');
  console.log('  /reset   — borrar memoria');
  console.log('  /unmute  — reactivar si quedó en mute');
  console.log('  /mute    — silenciar a mano');
  console.log('  /exit    — cerrar el programa');
  console.log('─────────────────────────────────────────');
  cliChat();
}