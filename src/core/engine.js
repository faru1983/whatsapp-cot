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
import { buildFaqCatalogContext, sanitizeCustomerFacingReply } from '../logic/utils.js';
import { isGreetingOrNoise, wantsExplicitHandoff } from '../logic/interruptions.js';
import { isImagePart, isVideoPart, isMediaPart, assertImageExists } from '../logic/media.js';
import { buildAdminSosBody } from '../views/templates.js';
import { FAQ_JSON_PATH } from './paths.js';
import { enableTestDebug, testLog } from './debug-log.js';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

// En el simulador CLI activamos logs [TEST] para todo el proceso (keywords, NLU, FAQ…)
if (isMainModule) enableTestDebug();

// Configuración cargada una vez al arrancar (incluye umbrales SECURITY_* del .env)
const botConfig = loadBotConfig();
const { maxConsecutiveErrors, maxIntentSwitches } = botConfig.security;

// Cola por sessionId: evita que dos mensajes del mismo cliente se pisen
// (getSession → lógica async → saveSession sin candado).
const sessionQueues = new Map();

/**
 * withSessionLock: Encadena el procesamiento de un mismo cliente.
 * Si llegan 2 mensajes seguidos, el segundo espera a que termine el primero.
 *
 * @param {string} sessionId - JID / id de sesión
 * @param {() => Promise<*>} work - Trabajo async a ejecutar en serie
 * @returns {Promise<*>} Resultado de work
 */
function withSessionLock(sessionId, work) {
  const previous = sessionQueues.get(sessionId) || Promise.resolve();
  // Si el anterior falló, igual seguimos (no bloqueamos al cliente para siempre)
  const current = previous.catch(() => {}).then(work);
  // Guardamos una promesa que siempre se resuelve, solo para encadenar el orden
  sessionQueues.set(sessionId, current.then(() => {}, () => {}));
  return current;
}

/**
 * cliLog: Feedback uniforme del simulador local (npm run test:local).
 * En WhatsApp real estos mensajes no existen; solo ayudan a depurar en consola.
 * Formato fijo: [TEST] mensaje
 *
 * @param {string} message - Texto del aviso (puede ser multilínea)
 */
function cliLog(message) {
  testLog(message);
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

/**
 * historyTextForPart: Texto que guardamos en el historial por cada burbuja.
 * Imágenes/videos no son string: dejamos un marcador legible para la IA y el debug.
 *
 * @param {string|{ type: string, file: string, caption?: string }} part
 * @returns {string}
 */
function historyTextForPart(part) {
  if (typeof part === 'string') return part;
  // Marcador fijo: el CLI y la IA ven el nombre del archivo, no un objeto crudo
  const label = part.type === 'video' ? '[VIDEO]' : '[IMAGEN]';
  let text = `${label} ${part.file}`;
  if (part.caption) text += `\n${part.caption}`;
  return text;
}

/**
 * normalizeReplyParts: Convierte string, imagen, video o array mixto en lista limpia.
 * Así promptQuestion / customReplies pueden mezclar texto, img() y vid().
 *
 * @param {string|object|Array|null|undefined} reply - Respuesta del estado o customReply(s)
 * @returns {Array<string|{ type: string, file: string, caption?: string }>}
 */
function normalizeReplyParts(reply) {
  if (reply == null) return [];
  const list = Array.isArray(reply) ? reply : [reply];
  return list.filter((p) => {
    if (typeof p === 'string') return p.trim() !== '';
    return isMediaPart(p);
  });
}

/**
 * failMissingImage: Silencia el chat y avisa al admin si falta un archivo en assets/.
 * No envía nada al cliente: el administrador continúa la conversación a mano.
 *
 * @param {object} session - Sesión actual (se muta mute + estado)
 * @param {string} sessionId - ID de sesión para persistir
 * @param {string} expectedPath - Ruta relativa esperada (ej. assets/foto.webp)
 * @param {((alert: object) => void)|null} alertAdmin - Callback de alerta (por mensaje, no global)
 * @returns {null} Siempre null (sin reply al cliente)
 */
function failMissingImage(session, sessionId, expectedPath, alertAdmin) {
  const stateId = session.currentState || '(sin estado)';
  session.isMuted = true;
  session.silenciado_timestamp = Date.now();
  session.currentState = 'CERRADO';

  cliLog(`SOS: imagen no encontrada → ${expectedPath}`);
  cliLog('MUTE activado (imagen faltante). El bot no responde al cliente.');

  if (alertAdmin) {
    alertAdmin({
      type: 'SOS',
      title: 'IMAGEN FALTANTE',
      body: buildAdminSosBody({
        reason: `El sistema intentó enviar una imagen pero no encontró ${expectedPath}. El bot se silenció.`,
        stateId
      })
    });
  }

  saveSession(sessionId, session);
  return null;
}

/**
 * commitBotReplies: Guarda cada bloque en el historial y devuelve string, imagen o array.
 * Si alguna imagen no existe en assets/, mute + SOS y no se envía nada al cliente.
 *
 * @param {object} session - Sesión actual (se muta el historial)
 * @param {string} sessionId - ID de sesión para persistir
 * @param {string|object|Array} reply - Uno o varios textos / imágenes del bot
 * @param {((alert: object) => void)|null} [alertAdmin] - Callback de alerta del mensaje actual
 * @returns {string|object|Array|null} Lo que debe enviar WhatsApp / CLI
 */
function commitBotReplies(session, sessionId, reply, alertAdmin = null) {
  const parts = normalizeReplyParts(reply);
  if (parts.length === 0) return null;

  // Validamos imágenes/videos antes de guardar historial o devolver nada
  for (const part of parts) {
    if (isMediaPart(part)) {
      const check = assertImageExists(part.file);
      if (!check.ok) {
        return failMissingImage(session, sessionId, check.expectedPath, alertAdmin);
      }
    }
  }

  // Cada burbuja queda como un turno aparte en el historial (útil para la IA)
  for (const part of parts) {
    session.history.turns.push({ role: 'model', text: historyTextForPart(part) });
  }
  saveSession(sessionId, session);
  return parts.length === 1 ? parts[0] : parts;
}

/**
 * resolvePromptQuestion: Obtiene el promptQuestion del estado (string o array).
 *
 * @param {object} stateObj - Estado del statesMap
 * @param {object} session - Sesión actual
 * @returns {string|string[]|null|undefined}
 */
function resolvePromptQuestion(stateObj, session) {
  if (!stateObj) return null;
  return typeof stateObj.promptQuestion === 'function'
    ? stateObj.promptQuestion(session)
    : stateObj.promptQuestion;
}

/**
 * lastPromptPart: Si el prompt es un array (info + pregunta), usa solo la última parte.
 * Sirve en el fallback para no re-pegar el bloque informativo largo.
 *
 * @param {string|string[]|null|undefined} prompt - promptQuestion crudo
 * @returns {string}
 */
function lastPromptPart(prompt) {
  const parts = normalizeReplyParts(prompt);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  // El fallback FAQ/IA solo usa texto; si el último bloque fuera imagen, no lo pegamos
  return typeof last === 'string' ? last : '';
}

/**
 * processMessage: Orquesta un turno completo (mute, estado, fallbacks, SOS).
 * WhatsApp pasa `options.sendAdminAlert` por mensaje para no mezclar clientes
 * si hay varios chats procesándose a la vez.
 *
 * @param {string} sessionId - JID / id de sesión
 * @param {string} messageText - Texto del cliente (o comando CLI)
 * @param {{ sendAdminAlert?: (alert: object) => void|Promise<void> }} [options]
 * @returns {Promise<string|object|Array|null>}
 */
export async function processMessage(sessionId, messageText, options = {}) {
  return withSessionLock(sessionId, () =>
    processMessageUnlocked(sessionId, messageText, options)
  );
}

/**
 * processMessageUnlocked: Cuerpo real del engine (ya serializado por sessionId).
 *
 * @param {string} sessionId
 * @param {string} messageText
 * @param {{ sendAdminAlert?: (alert: object) => void|Promise<void> }} options
 * @returns {Promise<string|object|Array|null>}
 */
async function processMessageUnlocked(sessionId, messageText, options = {}) {
  // Callback de este mensaje concreto (no variable global compartida)
  const alertAdmin = typeof options.sendAdminAlert === 'function'
    ? options.sendAdminAlert
    : null;

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

  const currentStateId = session.currentState;

  // triggerSosMute: Silencia el chat y avisa al admin (handoff humano).
  const triggerSosMute = (title, reason, clientReply = null) => {
    cliLog(`SOS: ${title} en estado ${currentStateId}.`);
    session.isMuted = true;
    session.silenciado_timestamp = Date.now();
    session.currentState = 'CERRADO';
    if (alertAdmin) {
      alertAdmin({
        type: 'SOS',
        title,
        body: buildAdminSosBody({
          reason,
          stateId: currentStateId,
          lastMessage: messageText
        })
      });
    }
    if (clientReply) {
      session.history.turns.push({ role: 'model', text: clientReply });
    }
    saveSession(sessionId, session);
    return clientReply;
  };

  // 1.1 Escape global a humano (handoff seguro)
  const isNoWord = /^no$/i.test(messageText.trim());
  const isSosWord = /^sos$/i.test(messageText.trim());
  const SOS_NO_EXCLUDED_STATES = ['BARRILES_RECOGIDA_DATOS'];
  const wantsNoHandoff = isNoWord && !SOS_NO_EXCLUDED_STATES.includes(currentStateId);
  const wantsHandoff = isSosWord || wantsNoHandoff || wantsExplicitHandoff(messageText);

  if (wantsHandoff) {
    session.history.turns.push({ role: 'user', text: messageText });
    return triggerSosMute(
      'PIDIÓ HUMANO',
      'Solicitó hablar con el equipo de forma explícita.',
      `Te comunico con alguien del equipo. ¡Ya te escriben! 🙌`
    );
  }

  session.history.turns.push({ role: 'user', text: messageText });

  let currentState = statesMap[currentStateId];
  cliLog(`paso actual: ${currentStateId}`);

  if (!currentState) {
    const fallbackState =
      session.userIntent === 'BARRILES'
        ? 'BARRILES_FILTRO_CANAL'
        : session.userIntent === 'EVENTOS'
          ? 'EVENTOS_RECOGIDA_DATOS'
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
      'BARRILES_RECOGIDA_PRODUCTOS',
      'EVENTOS_RECOGIDA_DATOS',
      'EVENTOS_CONFIRMAR_DATOS'
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
          // Alerta SOS unificada: cabecera (cliente) la arma index.js
          if (alertAdmin) {
            alertAdmin({
              type: 'SOS',
              title: 'INDECISIÓN',
              body: buildAdminSosBody({
                reason: 'Cambió demasiadas veces entre Barriles y Eventos.',
                stateId: currentStateId
              })
            });
          }
          saveSession(sessionId, session);
          return null;
        }

        cliLog(`SWITCH: cliente cambia intención → ${switchIntent}`);
        session.userIntent = switchIntent;
        session.currentState = switchIntent === 'BARRILES' ? 'BARRILES_FILTRO_CANAL' : 'EVENTOS_RECOGIDA_DATOS';
        session.consecutiveErrors = 0;

        // Puede ser string o array (info + pregunta en burbujas separadas)
        const newState = statesMap[session.currentState];
        return commitBotReplies(session, sessionId, resolvePromptQuestion(newState, session), alertAdmin);
      }
    }
  }

  // 2.9 Pre-intercepción de preguntas (FAQ) para evitar extracción ansiosa (shadowing)
  const isQuestion = /\?/.test(messageText)
    || /^(como|cómo|donde|dónde|cuando|cuándo|quien|quién|porque|por\s*qu[eé]|que\s+es|qué\s+es|tienen|tienen\s+disponibilidad|cuanto|cuánto|cuesta|cuestan|vale|valen|hacen|realizan|despachan|envian|envían|van|llegan)\b/i.test(messageText.trim());

  if (isQuestion && currentStateId !== 'CERRADO') {
    cliLog(`FAQ PRE-CHECK: Detectada posible pregunta en '${messageText}'`);
    const faqData = JSON.parse(fs.readFileSync(FAQ_JSON_PATH, 'utf8'));
    const faqResponse = await responderFAQ(messageText, faqData, {
      userIntent: session.userIntent,
      eventoFormato: session.eventoFormato
    });

    if (faqResponse === 'SOS_HANDOFF') {
      cliLog('FAQ PRE-CHECK: Match con SOS_HANDOFF → handoff inmediato');
      return triggerSosMute(
        'FRUSTRACIÓN / COMPLEJIDAD',
        'El cliente muestra frustración o consultó algo fuera de la base de conocimientos.',
        `Te comunico con alguien del equipo para ayudarte con eso. ¡Ya te escriben! 🙌`
      );
    }

    if (faqResponse !== 'NO_FAQ') {
      cliLog('FAQ PRE-CHECK: Match con FAQ → respondiendo antes de extraer datos');
      session.consecutiveErrors = 0; // se reinicia por respuesta exitosa

      // Si promptQuestion es array (info + pregunta), usamos solo la última parte
      const questionText = lastPromptPart(resolvePromptQuestion(currentState, session));
      const shortQ = typeof currentState.shortQuestion === 'function' ? currentState.shortQuestion(session) : currentState.shortQuestion;
      const finalQuestion = shortQ || questionText;

      const reply = appendStepQuestionIfNeeded(sanitizeCustomerFacingReply(faqResponse), finalQuestion);
      session.history.turns.push({ role: 'model', text: reply });
      saveSession(sessionId, session);
      return reply;
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
    cliLog(`paso OK (success)`);
    
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

    if (processResult.notifyAdmin && alertAdmin) {
      alertAdmin(processResult.notifyAdmin);
    }

    // customReplies: varios mensajes separados (ej. carta + pregunta de cotizar)
    // customReply: un solo mensaje (compatibilidad con el resto del flujo)
    if (Array.isArray(processResult.customReplies) && processResult.customReplies.length > 0) {
      return commitBotReplies(session, sessionId, processResult.customReplies, alertAdmin);
    }

    if (processResult.customReply) {
      reply = processResult.customReply;
    } else if (processResult.nextState) {
      const nextStateObj = statesMap[processResult.nextState];
      if (nextStateObj && !processResult.mute) {
         // promptQuestion puede ser string o string[] (bloque info + pregunta)
         reply = resolvePromptQuestion(nextStateObj, session);

         // Si el nuevo estado no tiene un prompt estático (retorna vacío), pero tiene aiContextPrompt,
         // generamos el prompt inicial dinámicamente con la IA.
         if (normalizeReplyParts(reply).length === 0 && nextStateObj.aiContextPrompt) {
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
           // generateResponse ya limpia jerga interna; defensa extra por si acaso
           reply = sanitizeCustomerFacingReply(generated) || "";
          }
      }
    }
    // Guarda y devuelve (string o array de burbujas)
    const committed = commitBotReplies(session, sessionId, reply, alertAdmin);
    if (committed != null) return committed;

    saveSession(sessionId, session);
    return null;

  } else {
    // ==============================================================================
    // 4. RED DE SEGURIDAD GLOBAL: FAQ → plantilla corta / SOS (sin monólogo creativo)
    // Strikes: solo cuando NO pudimos ayudar. FAQ OK y ruido/re-pregunta NO suman.
    // ==============================================================================
    cliLog(`paso sin match → red de seguridad (FAQ → plantilla/SOS)`);

    // Si promptQuestion es array (info + pregunta), usamos solo la última parte
    const questionText = lastPromptPart(resolvePromptQuestion(currentState, session));
    const shortQ = typeof currentState.shortQuestion === 'function' ? currentState.shortQuestion(session) : currentState.shortQuestion;
    // Preferimos la pregunta corta para no re-pegar el prompt largo del estado
    const finalQuestion = shortQ || questionText;

    const conversationalMaxErrors = Math.min(2, maxConsecutiveErrors || 3);

    /**
     * buildNoInfoReply: Plantilla fija cuando FAQ/IA no ayudan.
     * Si ya eligió Barriles/Eventos, no preguntamos "¿seguir con X?" (es redundante).
     */
    const buildNoInfoReply = () => {
      const hasPath = session.userIntent === 'BARRILES' || session.userIntent === 'EVENTOS';
      if (hasPath) {
        return `Disculpa, soy un *asistente virtual* y no estoy seguro de cómo responder a eso. 😔\n\n${finalQuestion}\n\nO escribe *NO* o *HUMANO* para hablar con alguien del equipo.`;
      }
      return `Disculpa, soy un *asistente virtual* y no estoy seguro de cómo responder a eso. 😔\n\n¿Quieres seguir con tu cotización?\n\n${finalQuestion}\n\nO escribe *NO* o *HUMANO* para hablar con alguien del equipo.`;
    };

    const trimmedMessage = messageText.trim();

    // 4.1 Saludo / ruido / entusiasmo → re-pregunta corta SIN sumar strike
    // (ej. "Hoooola q genial", "gracias", "ok" a mitad de pedido)
    if (isGreetingOrNoise(trimmedMessage)) {
      cliLog('ruido/cortesía → re-pregunta fija (sin strike, sin IA)');
      reply = currentStateId === 'ESPERANDO_INTENCION'
        ? `¡Hola! 🍸 Soy el *asistente virtual* de Cocktails on Tap.\n\n${finalQuestion}`
        : `Disculpa, no te entendí bien 😊\nResponde con la palabra en *negrita* si puedes.\n\n${finalQuestion}`;
      session.history.turns.push({ role: 'model', text: reply });
      saveSession(sessionId, session);
      return reply;
    }

    // 4.2 Off-topic claro: NO alertamos al admin en el primer mensaje.
    // Sumamos strike y re-preguntamos; SOS solo al llegar al umbral anti-loop.
    const looksClearOffTopic = trimmedMessage.length >= 40
      && !/\b(barril|coctel|cóctel|precio|valor|web|whatsapp|evento|despacho|envio|envío|mojito|sangria|pisco|margarita|dispensador|muro|invitad|comuna|fecha|litro)\b/i.test(trimmedMessage)
      && !/\?/.test(trimmedMessage);

    if (looksClearOffTopic) {
      session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
      cliLog(`off-topic → strike ${session.consecutiveErrors}/${conversationalMaxErrors} (sin SOS inmediato)`);

      if (session.consecutiveErrors >= conversationalMaxErrors) {
        return triggerSosMute(
          'OFF-TOPIC',
          'Varios mensajes fuera de contexto de cotización; handoff a humano.',
          `Disculpa, mejor te paso con alguien del equipo para ayudarte bien. ¡Ya te escriben! 🙌`
        );
      }

      reply = `Disculpa, soy un *asistente virtual* y estoy para ayudarte a cotizar 🍸\nResponde con la palabra en *negrita* si puedes.\n\n${finalQuestion}\n\nO escribe *NO* o *HUMANO* para hablar con alguien del equipo.`;
      session.history.turns.push({ role: 'model', text: reply });
      saveSession(sessionId, session);
      return reply;
    }

    // 4.3 FAQ (precios, despacho, ingredientes oficiales…)
    let faqResponse = 'NO_FAQ';
    cliLog('FAQ: consultando faq.json + catálogo/despachos (datos.json) con IA...');
    const faqData = JSON.parse(fs.readFileSync(FAQ_JSON_PATH, 'utf8'));
    faqResponse = await responderFAQ(messageText, faqData, {
      userIntent: session.userIntent,
      eventoFormato: session.eventoFormato
    });

    if (faqResponse === 'SOS_HANDOFF') {
      cliLog('FAQ: Match con SOS_HANDOFF (frustración o fuera de alcance) → handoff inmediato');
      return triggerSosMute(
        'FRUSTRACIÓN / COMPLEJIDAD',
        'El cliente muestra frustración o consultó algo fuera de la base de conocimientos.',
        `Te comunico con alguien del equipo para ayudarte con eso. ¡Ya te escriben! 🙌`
      );
    }

    if (faqResponse !== 'NO_FAQ') {
      // FAQ OK: ayudamos → reseteamos strikes (no cuenta como fallo)
      session.consecutiveErrors = 0;
      cliLog('FAQ: match → respondiendo (strikes en 0)');
      reply = appendStepQuestionIfNeeded(sanitizeCustomerFacingReply(faqResponse), finalQuestion);
      session.history.turns.push({ role: 'model', text: reply });
      saveSession(sessionId, session);
      return reply;
    }

    // 4.4 Sin FAQ clara: strike + plantilla fija (o LLM muy corto si parece pregunta real)
    session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
    cliLog(`sin ayuda clara → strike ${session.consecutiveErrors}/${conversationalMaxErrors}`);

    // Anti-loop: umbral anti-loop conversacional → mute + SOS
    if (session.consecutiveErrors >= conversationalMaxErrors) {
      return triggerSosMute(
        'ANTI-LOOP',
        'Varias respuestas seguidas que el bot no entendió.',
        null
      );
    }

    // ¿Parece una pregunta real? Intentamos LLM ultra-corto; si no, plantilla fija
    const looksLikeRealQuestion = /\?/.test(trimmedMessage)
      || /\b(como|cómo|donde|dónde|cuando|cuándo|quien|quién|porque|por\s*qu[eé]|que\s+es|qué\s+es)\b/i.test(trimmedMessage);

    if (looksLikeRealQuestion) {
      cliLog('FAQ: NO_FAQ → LLM corto disciplinado');
      let systemInstruction = readPrompt();
      if (currentState.aiContextPrompt) {
        systemInstruction = `${systemInstruction}\n\n${currentState.aiContextPrompt}`;
      }
      systemInstruction = `${systemInstruction}\n\n${buildFaqCatalogContext()}
REGLA FALLBACK (crítica): Máximo 2 frases cortas. Si no sabes con certeza → di que no tienes esa info y ofrece escribir *NO* o *HUMANO* para un humano. NO inventes pitch, precios ni historias.
REGLA ANTI-JERGA: NUNCA digas "DATOS OFICIALES", "FAQ" ni "datos.json".`;

      systemInstruction = `${systemInstruction}\n\n[DATOS CONOCIDOS]:
      - Intención: ${session.userIntent || 'No definido'}
      - Nombre: ${session.orderBuilder?.clientData?.name || session.userName || 'No informado'}`;
      if (session.eventoFormato) {
        systemInstruction += `\n- Formato evento: ${session.eventoFormato}`;
      }

      const contents = session.history.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] }));
      const config = { temperature: 0.2, maxOutputTokens: 120 };
      const generated = await generateResponse(config, systemInstruction, contents);
      if (generated) {
        reply = appendStepQuestionIfNeeded(sanitizeCustomerFacingReply(generated), finalQuestion);
      } else {
        reply = buildNoInfoReply();
      }
    } else {
      // Sin pregunta clara → plantilla fija (no monólogo creativo)
      cliLog('FAQ: NO_FAQ → plantilla fija (sin LLM creativo)');
      reply = buildNoInfoReply();
    }

    session.history.turns.push({ role: 'model', text: reply });
    saveSession(sessionId, session);
    return reply;
  }
}

// ==============================================================================
// 5. ENTORNO DE PRUEBAS LOCALES (CLI)
// ==============================================================================
let rl = null;

/**
 * cliChat: Bucle del simulador local.
 * Tras cada mensaje imprime feedback [TEST] uniforme (mute, estado, IA, etc.).
 */
function cliChat() {
  const sessionId = 'cli-test@s.whatsapp.net';

  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

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
    // Puede ser string, imagen (img) o array mixto (carta/foto + pregunta, etc.)
    if (response) {
      const replies = Array.isArray(response) ? response : [response];
      for (let i = 0; i < replies.length; i++) {
        const label = replies.length > 1 ? `Bot (${i + 1}/${replies.length})` : 'Bot';
        const part = replies[i];
        if (typeof part === 'string') {
          console.log(`\n${label}: ${part}`);
        } else if (isImagePart(part)) {
          // En el simulador no hay WhatsApp: mostramos el nombre del archivo
          console.log(`\n${label}: [IMAGEN] ${part.file}`);
          if (part.caption) console.log(part.caption);
        } else if (isVideoPart(part)) {
          console.log(`\n${label}: [VIDEO] ${part.file}`);
          if (part.caption) console.log(part.caption);
        }
      }
    }

    // --- Feedback [TEST] siempre, mismo formato ---
    console.log(''); // línea en blanco antes del bloque de debug

    const cmd = message.trim().toLowerCase();

    // /reset: mensaje explícito para no confundir "estado viejo → limpio" con un salto de flujo
    if (cmd === '/reset') {
      cliLog(`/reset: memoria borrada (antes: ${stateBefore})`);
      cliLog(`Estado actual: ${stateAfter}`);
    } else if (!wasMuted && isMutedNow) {
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