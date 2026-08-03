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
import { warmCotCatalog } from '../logic/cot-catalog.js';

import { statesMap } from '../flows/index.js';
import { readPrompt } from '../views/prompts.js';
import { buildFaqCatalogContext, sanitizeCustomerFacingReply } from '../logic/utils.js';
import { isGreetingOrNoise, wantsExplicitHandoff } from '../logic/interruptions.js';
import { getPendingFlowRequirement } from '../logic/flow-stall.js';
import { isImagePart, isVideoPart, isMediaPart, assertImageExists } from '../logic/media.js';
import { buildAdminSosBody, HANDOFF_CLIENT_REPLY } from '../views/templates.js';
import { FAQ_JSON_PATH } from './paths.js';
import { enableTestDebug, testLog } from './debug-log.js';
import {
  getOnMissHint,
  canUseFaqSidequest,
  getFaqSidequestCount,
  incrementFaqSidequest,
  buildGuidedStepQuestion,
  withoutAssistantFooter,
  stepQuestionAfterIdentityBody,
  MENU_WRITE_REMINDER
} from '../logic/flow-rails.js';
import { clearNudgeFlag } from '../logic/inactivity-nudge.js';
import { jidToE164 } from '../logic/cot-event-quote.js';

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
 * pushModelTextAndSave: Guarda una respuesta de texto del bot y marca lastOutboundAt.
 * Usado en fallbacks que no pasan por commitBotReplies (FAQ, plantillas, SOS).
 *
 * @param {object} session
 * @param {string} sessionId
 * @param {string} text
 */
function pushModelTextAndSave(session, sessionId, text) {
  session.history.turns.push({ role: 'model', text });
  session.lastOutboundAt = Date.now();
  saveSession(sessionId, session);
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
  // Timestamp de outbound: el nudge-runner sabe que el bot ya preguntó y espera
  session.lastOutboundAt = Date.now();
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

  // Guardamos el JID y el teléfono E.164 para la API de cotizaciones web
  session.sessionId = sessionId;
  const phone = jidToE164(sessionId);
  if (phone) session.clientPhoneE164 = phone;

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

  // Actividad del cliente: habilita el reloj del nudge y permite un nudge nuevo
  // si vuelve a escribir (clearNudgeFlag). No muteamos al enviar el nudge.
  session.lastInboundAt = Date.now();
  clearNudgeFlag(session);

  // Inicialización de la sesión si es cliente nuevo
  if (!session.currentState) {
    session.currentState = 'ESPERANDO_INTENCION';
  }

  const currentStateId = session.currentState;
  const stallThreshold = maxConsecutiveErrors || 3;

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
      session.lastOutboundAt = Date.now();
    }
    saveSession(sessionId, session);
    return clientReply;
  };

  /**
   * registerFlowStallStrike: Suma strike cuando el cliente no avanza el paso actual.
   * Al llegar a SECURITY_MAX_CONSECUTIVE_ERRORS → mute + SOS con mensaje al cliente.
   *
   * @param {string} reason - Motivo corto para logs/admin
   * @returns {string|null|undefined} Respuesta al cliente si hubo SOS; null si aún no
   */
  const registerFlowStallStrike = (reason) => {
    session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
    cliLog(`flujo atascado (${reason}) → strike ${session.consecutiveErrors}/${stallThreshold}`);

    if (session.consecutiveErrors >= stallThreshold) {
      return triggerSosMute(
        'ANTI-LOOP',
        'Varios mensajes seguidos sin avanzar el paso de cotización.',
        HANDOFF_CLIENT_REPLY
      );
    }
    return null;
  };

  // 1.1 Escape global a humano (handoff seguro)
  const isNoWord = /^no$/i.test(messageText.trim());
  const isSosWord = /^sos$/i.test(messageText.trim());
  // En el router, "no" no significa handoff: mostramos nuevamente el menú.
  // El traspaso inicial ocurre con 3️⃣ o una petición explícita de HUMANO.
  const SOS_NO_EXCLUDED_STATES = ['ESPERANDO_INTENCION', 'BARRILES_RECOGIDA_DATOS'];
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
      
      const wantsBarriles = /(desechable|barril desechable|para la casa|para el hogar|llevarse|\bbarriles?\b)/i.test(messageText);
      const wantsEventos = /(servicio para eventos|para un evento|para mi matrimonio|dispensador port[aá]til|muro de cocteler[ií]a|matrimonio|cumplea[nñ]os)/i.test(messageText) && !/sin evento/i.test(messageText);

      let switchIntent = false;
      if (isCurrentlyEventos && wantsBarriles && !wantsEventos) switchIntent = 'BARRILES';
      else if (isCurrentlyBarriles && wantsEventos && !wantsBarriles) switchIntent = 'EVENTOS';

      if (switchIntent) {
        session.intentSwitchCount = (session.intentSwitchCount || 0) + 1;
        
        if (session.intentSwitchCount >= maxIntentSwitches) {
          cliLog(`SEGURIDAD: demasiados cambios de intención (>= ${maxIntentSwitches}). Silenciando.`);
          // Mismo contrato que el resto de SOS: mute + CERRADO (no dejar a mitad de flujo)
          session.isMuted = true;
          session.silenciado_timestamp = Date.now();
          session.currentState = 'CERRADO';
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
        session.consecutiveErrors = 0;

        // Limpiamos datos del flujo que se abandona para no “saltar” pasos
        // con invitados/fecha/carrito viejos al volver a entrar.
        if (switchIntent === 'BARRILES') {
          session.guests = null;
          session.date = null;
          session.location = null;
          session.isRM = undefined;
          session.celebrationType = null;
          session.eventoFormato = null;
          session.orderBuilder = {
            type: 'desechable',
            products: {},
            extras: {},
            clientData: { name: null, date: null, location: null }
          };
        } else if (switchIntent === 'EVENTOS') {
          // No reutilizamos el carrito desechable en Eventos (formato distinto)
          session.orderBuilder = null;
          session.guests = null;
          session.date = null;
          session.location = null;
          session.isRM = undefined;
          session.celebrationType = null;
          session.eventoFormato = null;
        }

        session.currentState = switchIntent === 'BARRILES' ? 'BARRILES_FILTRO_CANAL' : 'EVENTOS_RECOGIDA_DATOS';

        // Puede ser string o array (info + pregunta en burbujas separadas)
        const newState = statesMap[session.currentState];
        return commitBotReplies(session, sessionId, resolvePromptQuestion(newState, session), alertAdmin);
      }
    }
  }

  // 2.9 Pre-intercepción de preguntas (FAQ) para evitar extracción ansiosa (shadowing)
  const isQuestion = /\?/.test(messageText)
    || /^(como|cómo|donde|dónde|cuando|cuándo|quien|quién|porque|por\s*qu[eé]|que\s+es|qué\s+es|tienen|tienen\s+disponibilidad|cuanto|cuánto|cuesta|cuestan|vale|valen|hacen|realizan|despachan|envian|envían|van|llegan)\b/i.test(messageText.trim());

  const pendingFlow = getPendingFlowRequirement(session, currentStateId);
  const flowAlreadyStalling = Boolean(pendingFlow && (session.consecutiveErrors || 0) > 0);
  const faqSidequestAllowed = canUseFaqSidequest(session, pendingFlow);

  // Si ya hubo un strike y el paso sigue pendiente, no usamos FAQ: dejamos que el fallback cuente el strike
  // El router inicial es cerrado y determinístico: primero debe elegirse
  // Eventos o Barriles. No permitimos que FAQ/IA responda antes de esa elección.
  const canPrecheckFaq = currentStateId !== 'CERRADO'
    && currentStateId !== 'ESPERANDO_INTENCION';

  if (isQuestion && canPrecheckFaq && !flowAlreadyStalling && faqSidequestAllowed) {
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
      if (pendingFlow) {
        incrementFaqSidequest(session, pendingFlow);
        cliLog(`FAQ sidequest (${pendingFlow}) → strikes sin reset`);
      } else {
        session.consecutiveErrors = 0;
      }

      // Si promptQuestion es array (info + pregunta), usamos solo la última parte
      const questionText = lastPromptPart(resolvePromptQuestion(currentState, session));
      const shortQ = typeof currentState.shortQuestion === 'function' ? currentState.shortQuestion(session) : currentState.shortQuestion;
      const onMissHint = getOnMissHint(currentStateId, session, pendingFlow);
      const finalQuestion = shortQ || questionText;
      const guidedQuestion = buildGuidedStepQuestion(finalQuestion, onMissHint);

      const reply = appendStepQuestionIfNeeded(sanitizeCustomerFacingReply(faqResponse), guidedQuestion);
      pushModelTextAndSave(session, sessionId, reply);
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
    const pendingBefore = getPendingFlowRequirement(session, currentStateId);
    const stateAdvanced = Boolean(processResult.nextState && processResult.nextState !== currentStateId);
    const pendingAfter = getPendingFlowRequirement(session, processResult.nextState || currentStateId);
    // flowProgress: el estado avanzó el dato pendiente sin cambiar de paso
    // (ej. recibió el email y ahora pide dirección). Sin esto, success:true
    // con el mismo pending nunca llegaba al anti-loop (DATOS_CONTACTO).
    const madePartialProgress = Boolean(processResult.flowProgress);

    // Solo reseteamos strikes si el flujo avanzó, hubo progreso parcial, o ya no hay pendiente
    if (stateAdvanced || madePartialProgress || !pendingBefore || (pendingBefore && !pendingAfter)) {
      session.consecutiveErrors = 0;
      cliLog(`paso OK (success${madePartialProgress && !stateAdvanced ? ', progreso parcial' : ''})`);
    } else if (pendingBefore && pendingAfter && pendingBefore === pendingAfter && !stateAdvanced) {
      // success:true pero mismo requisito pendiente → cuenta como stall (anti-loop)
      const sosReply = registerFlowStallStrike(pendingAfter);
      if (sosReply !== null) return sosReply;
      cliLog('paso OK pero el flujo sigue pendiente → strike');
    } else {
      cliLog('paso OK (success)');
    }
    
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
    const onMissHint = getOnMissHint(currentStateId, session, pendingFlow);
    const baseQuestion = shortQ || questionText;
    const finalQuestion = buildGuidedStepQuestion(baseQuestion, onMissHint);

    /**
     * buildNoInfoReply: Plantilla fija cuando FAQ/IA no ayudan.
     * En el router (sin path) re-mostramos el menú con tono cordial (nunca “no estoy seguro”).
     * En pasos de DATOS (fecha, comuna, cócteles) no pedimos emoji de menú.
     * En pasos de DECISIÓN (1️⃣/2️⃣) sí recordamos responder con el número.
     */
    const buildNoInfoReply = () => {
      const q = withoutAssistantFooter(finalQuestion);
      const handoff = 'O escribe *NO* o *HUMANO* para hablar con alguien del equipo.';
      const hasPath = session.userIntent === 'BARRILES' || session.userIntent === 'EVENTOS';
      // Pendientes de menú numerado vs captura libre de datos
      const menuPendingKeys = new Set([
        'intent', 'confirm', 'format', 'continue', 'confirm_quote', 'mod_choice'
      ]);
      const isMenuStep = menuPendingKeys.has(pendingFlow)
        || currentStateId === 'ESPERANDO_INTENCION';

      // Entrada: miss = menú de nuevo, sin plantilla “no estoy seguro”
      if (currentStateId === 'ESPERANDO_INTENCION' && !hasPath) {
        return stepQuestionAfterIdentityBody(
          `Disculpa, no te entendí bien 😊 Soy el *asistente virtual* de Cocktails on Tap.\n${MENU_WRITE_REMINDER}`,
          finalQuestion
        );
      }

      if (hasPath && isMenuStep) {
        return `Disculpa, soy un *asistente virtual* y no estoy seguro de cómo responder a eso. 😔\n\n${MENU_WRITE_REMINDER}\n\n${q}\n\n${handoff}`;
      }

      if (hasPath) {
        // Paso de datos (fecha/comuna/cócteles/contacto): re-pregunta clara, sin menú
        return `Disculpa, no te entendí bien 😊\n\n${q}\n\n${handoff}`;
      }

      return `Disculpa, soy un *asistente virtual* y no estoy seguro de cómo responder a eso. 😔\n\n¿Quieres seguir con tu cotización?\n\n${q}\n\n${handoff}`;
    };

    const trimmedMessage = messageText.trim();

    // 4.0 Paso bloqueado + strike previo → no FAQ/IA: cuenta otro strike o SOS en silencio
    if (flowAlreadyStalling) {
      const sosReply = registerFlowStallStrike(pendingFlow);
      if (sosReply !== null) return sosReply;

      reply = buildNoInfoReply();
      pushModelTextAndSave(session, sessionId, reply);
      return reply;
    }

    // 4.1 Saludo / ruido / entusiasmo → re-pregunta corta SIN sumar strike
    // (ej. "Hoooola q genial", "gracias", "ok" a mitad de pedido)
    if (isGreetingOrNoise(trimmedMessage)) {
      cliLog('ruido/cortesía → re-pregunta fija (sin strike, sin IA)');
      if (currentStateId === 'ESPERANDO_INTENCION') {
        reply = stepQuestionAfterIdentityBody(
          '¡Hola! 🍸 Soy el *asistente virtual* de Cocktails on Tap.',
          finalQuestion
        );
      } else {
        // Datos libres: no empujar menú 1️⃣/2️⃣
        reply = `Disculpa, no te entendí bien 😊\n\n${finalQuestion}`;
      }
      pushModelTextAndSave(session, sessionId, reply);
      return reply;
    }

    // 4.2 Off-topic claro: NO alertamos al admin en el primer mensaje.
    // Sumamos strike y re-preguntamos; SOS solo al llegar al umbral anti-loop.
    const looksClearOffTopic = trimmedMessage.length >= 40
      && !/\b(barril|coctel|cóctel|precio|valor|web|whatsapp|evento|despacho|envio|envío|mojito|sangria|pisco|margarita|dispensador|muro|invitad|comuna|fecha|litro)\b/i.test(trimmedMessage)
      && !/\?/.test(trimmedMessage);

    if (looksClearOffTopic) {
      session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
      cliLog(`off-topic → strike ${session.consecutiveErrors}/${stallThreshold} (sin SOS inmediato)`);

      if (session.consecutiveErrors >= stallThreshold) {
        return triggerSosMute(
          'OFF-TOPIC',
          'Varios mensajes fuera de contexto de cotización; handoff a humano.',
          `Disculpa, mejor te paso con alguien del equipo para ayudarte bien. ¡Ya te escriben! 🙌`
        );
      }

      reply = currentStateId === 'ESPERANDO_INTENCION'
        ? buildNoInfoReply()
        : `Disculpa, soy un *asistente virtual* y estoy para ayudarte a cotizar 🍸\n${MENU_WRITE_REMINDER}\n\n${withoutAssistantFooter(finalQuestion)}\n\nO escribe *NO* o *HUMANO* para hablar con alguien del equipo.`;
      pushModelTextAndSave(session, sessionId, reply);
      return reply;
    }

    // 4.3 FAQ (precios, despacho, ingredientes oficiales…)
    let faqResponse = 'NO_FAQ';
    if (faqSidequestAllowed) {
      cliLog('FAQ: consultando faq.json + catálogo/despachos (datos.json) con IA...');
      const faqData = JSON.parse(fs.readFileSync(FAQ_JSON_PATH, 'utf8'));
      faqResponse = await responderFAQ(messageText, faqData, {
        userIntent: session.userIntent,
        eventoFormato: session.eventoFormato
      });
    } else {
      cliLog(`FAQ: sidequest agotado para "${pendingFlow}" → plantilla on-miss`);
    }

    if (faqResponse === 'SOS_HANDOFF') {
      cliLog('FAQ: Match con SOS_HANDOFF (frustración o fuera de alcance) → handoff inmediato');
      return triggerSosMute(
        'FRUSTRACIÓN / COMPLEJIDAD',
        'El cliente muestra frustración o consultó algo fuera de la base de conocimientos.',
        `Te comunico con alguien del equipo para ayudarte con eso. ¡Ya te escriben! 🙌`
      );
    }

    if (faqResponse !== 'NO_FAQ') {
      if (pendingFlow) {
        incrementFaqSidequest(session, pendingFlow);
        cliLog(`FAQ: match con dato pendiente (${pendingFlow}) → strikes sin reset`);
      } else {
        session.consecutiveErrors = 0;
        cliLog('FAQ: match → respondiendo (strikes en 0)');
      }
      reply = appendStepQuestionIfNeeded(sanitizeCustomerFacingReply(faqResponse), finalQuestion);
      pushModelTextAndSave(session, sessionId, reply);
      return reply;
    }

    // 4.4 Sin FAQ clara: strike + plantilla fija (o LLM muy corto si parece pregunta real)
    session.consecutiveErrors = (session.consecutiveErrors || 0) + 1;
    cliLog(`sin ayuda clara → strike ${session.consecutiveErrors}/${stallThreshold}`);

    // Anti-loop: umbral SECURITY_MAX_CONSECUTIVE_ERRORS → mute + SOS con mensaje al cliente
    if (session.consecutiveErrors >= stallThreshold) {
      return triggerSosMute(
        'ANTI-LOOP',
        'Varias respuestas seguidas que el bot no entendió.',
        HANDOFF_CLIENT_REPLY
      );
    }

    // ¿Parece una pregunta real? LLM corto solo sin dato pendiente o con sidequest disponible
    const looksLikeRealQuestion = /\?/.test(trimmedMessage)
      || /\b(como|cómo|donde|dónde|cuando|cuándo|quien|quién|porque|por\s*qu[eé]|que\s+es|qué\s+es)\b/i.test(trimmedMessage);
    const allowShortLlm = looksLikeRealQuestion && (!pendingFlow || faqSidequestAllowed);

    if (allowShortLlm) {
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

    pushModelTextAndSave(session, sessionId, reply);
    return reply;
  }
}

// ==============================================================================
// 5. ENTORNO DE PRUEBAS LOCALES (CLI)
// ==============================================================================
let rl = null;

/**
 * formatCartSummary: Resumen corto del carrito para el panel [TEST].
 *
 * @param {object} session
 * @returns {string}
 */
function formatCartSummary(session) {
  const products = session.orderBuilder?.products;
  if (!products || Object.keys(products).length === 0) return '(vacío)';
  return Object.entries(products)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

/**
 * formatCliSnapshotLines: Líneas del panel interno (sin imprimir).
 *
 * @param {object} session
 * @param {object} [opts]
 * @param {string} [opts.stateBefore]
 * @returns {string[]}
 */
function formatCliSnapshotLines(session, opts = {}) {
  const stateId = session.currentState || '(sin estado)';
  const pending = getPendingFlowRequirement(session, stateId);
  const strikes = session.consecutiveErrors || 0;
  const threshold = maxConsecutiveErrors || 2;
  const faqUsed = pending ? getFaqSidequestCount(session, pending) : 0;
  const onMiss = pending ? getOnMissHint(stateId, session, pending) : null;
  const cd = session.orderBuilder?.clientData;
  const lines = [];

  if (opts.stateBefore && opts.stateBefore !== stateId) {
    lines.push(`Estado: ${opts.stateBefore} → ${stateId}`);
  } else {
    lines.push(`Estado: ${stateId}`);
  }
  lines.push(`Mute: ${session.isMuted ? 'SÍ (bot silenciado)' : 'no'}`);
  lines.push(`Intención: ${session.userIntent || '(sin elegir)'}`);
  lines.push(`Strikes: ${strikes}/${threshold}${strikes >= threshold ? ' → SOS/handoff' : ''}`);
  lines.push(`Dato pendiente (stall): ${pending || '(ninguno — paso libre o ya completo)'}`);
  if (pending) {
    lines.push(`FAQ sidequest (${pending}): ${faqUsed}/1 usada${faqUsed >= 1 ? ' (agotada → solo plantilla)' : ''}`);
    if (onMiss) lines.push(`Hint on-miss: ${onMiss}`);
  }
  if (session.intentSwitchCount) {
    lines.push(`Cambios Barriles↔Eventos: ${session.intentSwitchCount}/${maxIntentSwitches}`);
  }
  if (session.userIntent === 'EVENTOS' || stateId.startsWith('EVENTOS_')) {
    lines.push(`Evento: invitados=${session.guests || '—'} | fecha=${session.date || '—'} | comuna=${session.location || '—'} | formato=${session.eventoFormato || '—'}`);
    if (session.celebrationType) lines.push(`Celebración: ${session.celebrationType}`);
  }
  if (session.userIntent === 'BARRILES' || stateId.startsWith('BARRILES_')) {
    lines.push(`Entrega: fecha=${cd?.date || '—'} | comuna=${cd?.location || '—'}`);
  }
  if (session.orderBuilder?.products) {
    lines.push(`Carrito: ${formatCartSummary(session)}`);
  }
  if (opts.wasMuted && session.isMuted) {
    lines.push('Mensaje ignorado (sigue en mute). Usa /unmute o /reset.');
  } else if (!opts.wasMuted && session.isMuted) {
    lines.push('MUTE recién activado. Los siguientes mensajes se ignoran hasta /unmute o /reset.');
  } else if (opts.hadReply === false && !session.isMuted) {
    lines.push('Sin respuesta del bot en este turno.');
  }
  return lines;
}

/**
 * printCliStartupIntro: Bienvenida mínima + estado actual.
 *
 * @param {object} session
 */
function printCliStartupIntro(session) {
  const stateId = session.currentState || '(sin estado)';
  console.log(`
─────────────────────────────────────────
  Simulador Local — WhatsApp Lite Bot
  Rails: estado · stall · strikes · FAQ

  Comandos: /status /help /reset /mute /unmute /exit

Estado: ${stateId}
─────────────────────────────────────────
`);
}

/**
 * printCliSessionSnapshot: Panel interno bajo demanda (/status).
 *
 * @param {object} session
 * @param {object} [opts]
 */
function printCliSessionSnapshot(session, opts = {}) {
  const lines = formatCliSnapshotLines(session, opts);
  console.log('\n────────── PANEL INTERNO [TEST] ──────────');
  for (const line of lines) cliLog(line);
  cliLog('Comandos: /status /help /reset /mute /unmute /exit');
  console.log('─────────────────────────────────────────\n');
}

/**
 * printCliHelp: Guía corta del simulador y ejemplos para probar rails.
 */
function printCliHelp() {
  console.log(`
── Ayuda del simulador ──────────────────────
Comandos:
  /status  — panel interno sin enviar mensaje
  /help    — esta ayuda
  /reset   — borrar sesión
  /mute    — silenciar a mano
  /unmute  — reactivar
  /exit    — salir

Qué mirar en el PANEL INTERNO:
  • Estado          → paso actual de la máquina
  • Dato pendiente  → qué falta para avanzar (stall)
  • Strikes         → fallos seguidos; a ${maxConsecutiveErrors || 2} → handoff hablado
  • FAQ sidequest   → máx. 1 duda lateral por dato pendiente
  • Mute            → bot callado (mirón / SOS / humano)

Ejemplos para probar:
  barriles
  solo estoy mirando
  ¡Hola! Quiero más información
  eventos → van a la serena? → texto raro
  desechables → después te confirmo la comuna
  HUMANO
─────────────────────────────────────────────
`);
}

/**
 * cliChat: Bucle del simulador local.
 * Tras cada mensaje imprime la respuesta del bot + panel interno completo.
 */
function cliChat() {
  // Número ficticio E.164-compatible para que cot-api/admin muestren WhatsApp en CLI
  const sessionId = '56911111111@s.whatsapp.net';

  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  rl.question('Tú: ', async (message) => {
    const cmd = message.trim().toLowerCase();

    if (cmd === '/exit') {
      rl.close();
      return;
    }

    // Comandos de inspección: no pasan por processMessage
    if (cmd === '/help') {
      printCliHelp();
      cliChat();
      return;
    }
    if (cmd === '/status') {
      printCliSessionSnapshot(getSession(sessionId), { hadReply: true });
      cliChat();
      return;
    }

    const sessionBefore = getSession(sessionId);
    const wasMuted = !!sessionBefore.isMuted;
    const stateBefore = sessionBefore.currentState || '(sin estado)';
    const adminAlerts = [];

    // En el simulador, las alertas SOS se imprimen para depurar (en WhatsApp van al admin)
    const response = await processMessage(sessionId, message, {
      sendAdminAlert: (alert) => {
        adminAlerts.push(alert);
        const type = String(alert?.type || 'ALERT').toUpperCase();
        const title = alert?.title || '(sin título)';
        cliLog(`SOS → alerta al administrador`);
        cliLog(`  tipo: ${type}`);
        cliLog(`  título: ${title}`);
        if (alert?.body) {
          for (const line of String(alert.body).split('\n')) {
            cliLog(`  ${line}`);
          }
        }
      }
    });

    const sessionAfter = getSession(sessionId);

    // --- Respuesta del bot (si hubo) ---
    if (response) {
      const replies = Array.isArray(response) ? response : [response];
      for (let i = 0; i < replies.length; i++) {
        const label = replies.length > 1 ? `Bot (${i + 1}/${replies.length})` : 'Bot';
        const part = replies[i];
        if (typeof part === 'string') {
          console.log(`\n${label}: ${part}`);
        } else if (isImagePart(part)) {
          console.log(`\n${label}: [IMAGEN] ${part.file}`);
          if (part.caption) console.log(part.caption);
        } else if (isVideoPart(part)) {
          console.log(`\n${label}: [VIDEO] ${part.file}`);
          if (part.caption) console.log(part.caption);
        }
      }
    } else if (adminAlerts.length > 0 && !wasMuted) {
      // Mute silencioso con SOS: el cliente no ve nada, pero el test sí muestra el motivo
      cliLog('Sin respuesta al cliente (mute silencioso + SOS)');
    }

    if (cmd === '/reset') {
      cliLog(`/reset: memoria borrada (antes: ${stateBefore})`);
    }

    // Feedback corto por turno (el panel completo solo al inicio o con /status)
    const stateAfter = sessionAfter.currentState || '(sin estado)';
    const isMutedNow = !!sessionAfter.isMuted;
    if (!wasMuted && isMutedNow) {
      cliLog(`MUTE activado → estado: ${stateAfter}`);
      if (adminAlerts.length > 0) {
        cliLog(`SOS enviado al administrador (${adminAlerts.map((a) => a.title || a.type).join(', ')})`);
      }
      cliLog(`Los siguientes mensajes se ignoran. Usa /unmute o /reset.`);
    } else if (wasMuted && isMutedNow) {
      cliLog(`MUTE activo — mensaje ignorado. Estado: ${stateAfter}`);
    } else if (wasMuted && !isMutedNow) {
      cliLog(`MUTE desactivado. Estado: ${stateAfter}`);
    } else if (stateBefore !== stateAfter) {
      cliLog(`Estado: ${stateBefore} → ${stateAfter}`);
    } else {
      cliLog(`Estado: ${stateAfter}`);
    }
    console.log('');

    cliChat();
  });
}

if (isMainModule) {
  // Precargamos antes de dibujar "Tú:" y sin logs para que ninguna salida
  // asíncrona del catálogo se mezcle con el mensaje que escribe el tester.
  if (botConfig.cotApi?.configured) {
    await warmCotCatalog({ silent: true });
  }
  // JID sintético con forma de celular Chile: así la API/admin ven un WhatsApp
  // en pruebas locales (en producción llega el JID real del cliente).
  printCliStartupIntro(getSession('56911111111@s.whatsapp.net'));
  cliChat();
}