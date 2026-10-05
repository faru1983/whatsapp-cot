import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { processMessage } from './core/engine.js';
import { shouldHandleMessage, stripTriggerPrefix } from './logic/utils.js';
import { getSession, saveSession, resetSession, findSessionIdsForPhone } from './core/db.js';
import { resolveClientPhoneE164 } from './logic/cot-phone-resolve.js';
import { extractMetaCtwaAttribution, applyMetaCtwaToSession } from './logic/meta-ctwa.js';
import { syncCrmCtwaAttributionAsync } from './logic/cot-crm-sync.js';
import { assertRuntimeConfigReady, loadBotConfig } from './core/config.js';
import { warmCotCatalog } from './logic/cot-catalog.js';
import { AUTH_DIR, PROJECT_ROOT } from './core/paths.js';
import { isImagePart, isVideoPart, assertImageExists } from './logic/media.js';
import { rememberLabel, applyChatLabel } from './core/business-labels.js';
import {
  sendTracked,
  rememberMessage,
  wasSentByBot,
  getCachedMessage,
  notifyAdmins,
  logLabelReadyStatus
} from './core/whatsapp-send.js';
import { startNudgeRunner, stopNudgeRunner } from './core/nudge-runner.js';
import { waitBeforeFirstReply, waitBetweenBubbles } from './logic/reply-timing.js';
import {
  isCustomerBotEnabled,
  handleRuntimeToggleCommand
} from './logic/bot-runtime-flags.js';
import {
  isOperatorMenuCommand,
  isOperatorMidFlowState,
  isOperatorExitCommand,
  buildOperatorExitReply
} from './logic/operator-menu.js';
import { clearOperatorDraft } from './logic/operator-draft.js';
import {
  isSelfChat,
  isClientCustomerChat,
  isOperatorConsoleChannel,
  isSenderAdmin
} from './logic/operator-console.js';
import process from 'node:process';
import fs from 'node:fs';

// ==============================================================================
// OBJETIVO: Punto de entrada del bot de WhatsApp.
// Este archivo conecta WhatsApp, escucha mensajes y los envía al motor de lógica
// (engine) para decidir qué responder.
// Envío y etiquetas viven en core/whatsapp-send.js y core/business-labels.js.
// ==============================================================================

// Comandos que solo se usan desde el chat propio/admin, siempre con número de cliente.
const ADMIN_COMMANDS = ['/detenerbot', '/iniciarbot', '/reiniciarbot'];

// Evita abrir varios sockets a la vez (causa típica de "Esperando mensaje" y auth corrupta).
let isConnecting = false;
let reconnectTimer = null;

// Caché deduplicador de mensajes entrantes (evita doble procesamiento por reintentos ACK de WhatsApp)
const processedIncomingMsgIds = new Set();
function isRecentlyProcessedMessage(msgId) {
  if (!msgId) return false;
  if (processedIncomingMsgIds.has(msgId)) return true;
  processedIncomingMsgIds.add(msgId);
  if (processedIncomingMsgIds.size > 1000) {
    const first = processedIncomingMsgIds.values().next().value;
    processedIncomingMsgIds.delete(first);
  }
  return false;
}

/**
 * unwrapMessageContent: Saca el contenido real de un mensaje.
 * Los chats con "mensajes temporales" envuelven el texto en ephemeralMessage;
 * sin esto el bot ve texto vacío y el chat no arranca.
 *
 * @param {object|null|undefined} rawMessage - message.message de Baileys
 * @returns {object|undefined} Contenido ya desempaquetado
 */
function unwrapMessageContent(rawMessage) {
  if (!rawMessage) return undefined;
  return normalizeMessageContent(rawMessage) || rawMessage;
}

/**
 * getMessageText: Lee el texto visible del mensaje (conversation o extendedText).
 *
 * @param {object|undefined} content - Contenido ya desempaquetado
 * @returns {string} Texto o cadena vacía
 */
function getMessageText(content) {
  if (!content) return '';
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || '';
}

/**
 * isProtocolOrSystemMessage: Detecta eventos de sistema (no son un humano escribiendo).
 * Ejemplos: activar/desactivar mensajes temporales, borrar un mensaje, sync interno.
 * Si los tratáramos como "intervención humana", el bot se silenciaría solo.
 *
 * @param {object} waMessage - Mensaje completo de Baileys (con key y message)
 * @param {object|undefined} content - Contenido desempaquetado
 * @returns {boolean} true si debemos ignorarlo para mute/comandos
 */
function isProtocolOrSystemMessage(waMessage, content) {
  // Stubs de WhatsApp (avisos de grupo, cambios de privacidad, etc.)
  if (waMessage.messageStubType) return true;

  // Sin payload útil: sync vacío u otros eventos internos
  if (!content) return true;

  // protocolMessage: REVOKE (borrado), EPHEMERAL_SETTING (mensajes temporales), etc.
  if (content.protocolMessage) return true;

  // Distribución de claves / reacciones: no cuentan como "el admin habló con el cliente"
  if (content.senderKeyDistributionMessage) return true;
  if (content.reactionMessage) return true;

  return false;
}

/**
 * hasHumanChatContent: ¿Hay texto o multimedia real de una persona?
 * Solo con esto silenciamos el bot por intervención humana.
 *
 * @param {object|undefined} content - Contenido desempaquetado
 * @returns {boolean}
 */
function hasHumanChatContent(content) {
  if (!content) return false;
  if (content.protocolMessage || content.senderKeyDistributionMessage || content.reactionMessage) {
    return false;
  }

  if (getMessageText(content).trim()) return true;

  // Multimedia o adjuntos cuentan como intervención del vendedor
  return Boolean(
    content.imageMessage
    || content.videoMessage
    || content.audioMessage
    || content.documentMessage
    || content.stickerMessage
    || content.contactMessage
    || content.contactsArrayMessage
    || content.locationMessage
    || content.liveLocationMessage
  );
}

/**
 * toClientJid: Normaliza un número o JID al formato @s.whatsapp.net.
 *
 * @param {string} rawTarget - "569..." o JID completo
 * @returns {string} JID del cliente
 */
function toClientJid(rawTarget) {
  return rawTarget.includes('@') ? rawTarget : `${rawTarget}@s.whatsapp.net`;
}

/**
 * extractPhoneDigits: Saca solo los dígitos de un número o JID.
 *
 * @param {string} raw - Número o JID
 * @returns {string} Solo dígitos
 */
function extractPhoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * jidUserPart: Parte de usuario de un JID (sin device ni dominio).
 * Ej: "569123:12@s.whatsapp.net" → "569123"
 *
 * @param {string} jid
 * @returns {string}
 */
function jidUserPart(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

/**
 * resolveSessionIdsForCommand: IDs de sesión a tocar con un comando admin.
 * Incluye el PN (569...@s.whatsapp.net) y, si Baileys tiene mapping, el @lid.
 *
 * @param {object} sock - Socket Baileys
 * @param {string} phoneOrJid - Número o JID del cliente
 * @returns {Promise<string[]>}
 */
async function resolveSessionIdsForCommand(sock, phoneOrJid) {
  const digits = extractPhoneDigits(phoneOrJid.includes('@') ? jidUserPart(phoneOrJid) : phoneOrJid);
  const ids = new Set();
  if (!digits) return [];

  const pnJid = `${digits}@s.whatsapp.net`;
  ids.add(pnJid);

  // Sesiones ya guardadas que coincidan con el número
  for (const id of findSessionIdsForPhone(digits)) {
    ids.add(id);
  }

  // Mapping PN ↔ LID de Baileys (si existe)
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid);
    if (lid) ids.add(lid);
  } catch (_) { /* ignore */ }

  return [...ids];
}

/**
 * getPreferredSessionId: Elige el ID de sesión más estable para un mensaje entrante.
 * Prefiere el número público (@s.whatsapp.net) sobre @lid cuando WhatsApp lo envía
 * en remoteJidAlt / senderPn.
 *
 * @param {object} message - Mensaje Baileys
 * @returns {string} JID a usar como sessionId
 */
function getPreferredSessionId(message) {
  const remoteJid = message.key?.remoteJid || '';
  const alt = message.key?.remoteJidAlt || message.key?.senderPn || '';
  if (remoteJid.endsWith('@lid') && typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) {
    return alt;
  }
  return remoteJid;
}

/**
 * resolveClientPhoneLabel: Arma el texto "+569... (Nombre)" para alertas admin.
 * WhatsApp a veces manda el chat como @lid (ID largo oculto); priorizamos el
 * número público (remoteJidAlt / senderPn / mapping Baileys / sessionId PN).
 *
 * @param {object} message - Mensaje Baileys
 * @param {object} sock - Socket Baileys
 * @param {string} sessionId - ID de sesión ya preferido (puede ser PN)
 * @returns {Promise<string>} Etiqueta lista para alertas admin ("+569... (Nombre)")
 */
async function resolveClientPhoneLabel(message, sock, sessionId) {
  const e164 = await resolveClientPhoneE164({ message, sock, sessionId });
  const nombrePerfil = message.pushName ? ` (${message.pushName})` : '';
  if (e164) return `${e164}${nombrePerfil}`;

  const key = message.key || {};
  if (String(key.remoteJid || '').endsWith('@lid')) {
    const lidPart = String(key.remoteJid).split('@')[0];
    return `+${lidPart} [ID Oculto]${nombrePerfil}`;
  }

  const fallback = String(sessionId || key.remoteJid || '').replace('@s.whatsapp.net', '');
  return `+${fallback}${nombrePerfil}`;
}

/**
 * deliverBotReply: Envía string, array o media al JID indicado (ritmo natural).
 *
 * @param {object} sock - Socket Baileys
 * @param {string} targetJid
 * @param {string|object|Array|null} reply
 * @param {object} timing - botConfig.replyTiming
 */
async function deliverBotReply(sock, targetJid, reply, timing = {}) {
  if (!reply) return;

  const replies = Array.isArray(reply) ? reply : [reply];

  try {
    await sock.assertSessions([targetJid], true);
  } catch (e) {
    console.warn(`assertSessions falló para ${targetJid}:`, e.message);
  }

  await waitBeforeFirstReply(sock, targetJid, timing);

  for (let i = 0; i < replies.length; i++) {
    const part = replies[i];
    if (!part) continue;

    await waitBetweenBubbles(sock, targetJid, timing, i);

    if (typeof part === 'string') {
      await sendTracked(sock, targetJid, { text: part });
      continue;
    }

    if (isImagePart(part)) {
      const check = assertImageExists(part.file);
      if (!check.ok) {
        console.error(`Imagen no encontrada al enviar: ${check.expectedPath}`);
        continue;
      }
      const imageBuffer = fs.readFileSync(check.absolutePath);
      const payload = { image: imageBuffer };
      if (part.caption) payload.caption = part.caption;
      await sendTracked(sock, targetJid, payload);
    } else if (isVideoPart(part)) {
      const check = assertImageExists(part.file);
      if (!check.ok) {
        console.error(`Video no encontrado al enviar: ${check.expectedPath}`);
        continue;
      }
      const videoBuffer = fs.readFileSync(check.absolutePath);
      const payload = { video: videoBuffer, mimetype: 'video/mp4' };
      if (part.caption) payload.caption = part.caption;
      await sendTracked(sock, targetJid, payload);
    }
  }
}

/**
 * handleOperatorConsoleMessage: Panel /menu (self-chat o ADMIN_NUMBERS).
 *
 * @param {object} params
 */
async function handleOperatorConsoleMessage({
  message,
  sock,
  config,
  botConfig,
  remoteJid,
  text,
  content
}) {
  const cleanText = stripTriggerPrefix(text, config);
  const rawCmd = (cleanText || text || '').trim();
  if (!cleanText && !getMessageText(content).trim()) {
    return;
  }

  const toggleReply = handleRuntimeToggleCommand(cleanText || text);
  if (toggleReply) {
    await deliverBotReply(sock, remoteJid, toggleReply, botConfig.replyTiming || {});
    return;
  }

  const sessionId = remoteJid;
  const session = getSession(sessionId);

  if (isOperatorExitCommand(rawCmd)) {
    clearOperatorDraft(session);
    session.operatorMode = false;
    session.currentState = null;
    saveSession(sessionId, session);
    await deliverBotReply(sock, remoteJid, buildOperatorExitReply(), botConfig.replyTiming || {});
    return;
  }

  const inOperatorFlow = isOperatorMidFlowState(session.currentState)
    || String(session.currentState || '').startsWith('OPERADOR_');

  // Si no es /menu ni está en un flujo operador activo: silencio total (permite notas personales, audios, etc.)
  if (!isOperatorMenuCommand(rawCmd) && !inOperatorFlow) {
    return;
  }

  try {
    const reply = await processMessage(sessionId, cleanText || text, { operatorMode: true });
    if (!reply) {
      console.warn(`[operador] sin respuesta para "${String(cleanText || text).slice(0, 40)}" en ${sessionId} (¿mute?)`);
      return;
    }
    await deliverBotReply(sock, remoteJid, reply, botConfig.replyTiming || {});
  } catch (error) {
    console.error('Error en consola operador:', error.message);
    await deliverBotReply(
      sock,
      remoteJid,
      '⚠️ Error interno en consola operador. Revisa los logs del servidor.',
      botConfig.replyTiming || {}
    );
  }
}

/**
 * clearReconnectTimer: Cancela un reintento pendiente (ej. si WhatsApp hizo logout).
 */
function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * scheduleReconnect: Reconecta una sola vez tras un breve delay.
 * Así no se apilan varios startBot() si WhatsApp cierra/abre rápido.
 *
 * @param {number} delayMs - Espera antes de reconectar
 */
function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((error) => {
      console.error('Error fatal al intentar reconectar:', error.message);
      isConnecting = false;
      scheduleReconnect(5000);
    });
  }, delayMs);
}

/**
 * printPairingQrLink: Muestra un link para abrir el QR en el navegador.
 * En SSH el QR dibujado en terminal se deforma; el link es más fiable.
 *
 * @param {string} qrCode - Texto del QR que entrega Baileys
 */
function printPairingQrLink(qrCode) {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrCode)}`;
  console.log('');
  console.log('========== VINCULAR WHATSAPP ==========');
  console.log('1) En el celular: WhatsApp > Dispositivos vinculados > Vincular dispositivo');
  console.log('2) Abre este link en el navegador del PC y escanea la imagen:');
  console.log(url);
  console.log('======================================');
  console.log('');
}

// Inicializa conexión con WhatsApp y registra todos los listeners de eventos.
async function startBot() {
  // Si ya hay un intento de conexión en curso, no abrimos otro socket
  if (isConnecting) {
    console.log('Ya hay una conexión en curso; se omite otro startBot().');
    return;
  }
  isConnecting = true;

  // Si startBot falla antes de open/close, liberamos el flag para no quedar trabados
  let connectionSettled = false;
  const releaseConnecting = () => {
    if (!connectionSettled) {
      connectionSettled = true;
      isConnecting = false;
    }
  };

  try {
    // Fail-fast: API key obligatoria; ADMIN_NUMBERS vacío solo avisa (SOS no llegarían)
    const config = assertRuntimeConfigReady();
    // Precarga catálogo web (productId + sizes) para el primer quote más rápido
    if (config.cotApi?.configured) {
      void warmCotCatalog();
    }
    const logger = pino({ level: 'silent' });

    console.log(`Iniciando bot en: ${PROJECT_ROOT}`);

    // AUTH_DIR es ruta absoluta → auth/ siempre en la raíz del repo
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    // Baileys 7: caché de mensajes + recreación de sesión ayudan al descifrado.
    // getMessage: WhatsApp pide el contenido original para reenviar cifrado.
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60000,
      enableRecentMessageCache: true,
      enableAutoSessionRecreation: true,
      getMessage: async (key) => {
        return getCachedMessage(key?.id) || undefined;
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Sincroniza etiquetas de WhatsApp Business (caché id → nombre)
    sock.ev.on('labels.edit', (label) => {
      rememberLabel(label);
      if (label?.id && label?.name && !label.deleted) {
        console.log(`🏷️ Etiqueta Business sync: id=${label.id} name="${label.name}"`);
      }
    });

    // Si nunca llega open/close (cuelga en "connecting"), liberamos el flag a los 60s
    const connectingWatchdog = setTimeout(() => {
      if (!connectionSettled) {
        console.warn('Timeout esperando conexión WhatsApp; se libera el bloqueo de arranque.');
        releaseConnecting();
      }
    }, 60000);

    // Listener de estado de conexión (QR, conectado, desconectado, reconexión automática).
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr: qrCode }) => {
      if (qrCode) {
        printPairingQrLink(qrCode);
      }

      if (connection === 'open') {
        clearTimeout(connectingWatchdog);
        releaseConnecting();
        console.log('WhatsApp conectado. El bot está listo para trabajar.');
        // Tras sync de etiquetas Business, logueamos si ya resolvemos "Asistencia"
        setTimeout(() => {
          logLabelReadyStatus(config.labels);
        }, 5000);
        // Nudge por inactividad (híbrido cron + horas). Off si NUDGE_ENABLED=false o /respuestas off.
        startNudgeRunner(sock, () => {
          const nudge = loadBotConfig().nudge;
          return { ...nudge, enabled: Boolean(nudge.enabled && isCustomerBotEnabled()) };
        });
      }

      if (connection === 'close') {
        clearTimeout(connectingWatchdog);
        releaseConnecting();
        stopNudgeRunner();
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('Conexión cerrada. ¿Intentar reconectar automáticamente?:', shouldReconnect);

        // Liberamos listeners del socket viejo para no acumular handlers
        try {
          sock.ev.removeAllListeners('connection.update');
          sock.ev.removeAllListeners('messages.upsert');
          sock.ev.removeAllListeners('creds.update');
          sock.ev.removeAllListeners('labels.edit');
        } catch (_) { /* ignore */ }

        if (shouldReconnect) {
          // Un solo reintento programado (no startBot() inmediato en cascada)
          scheduleReconnect(3000);
        } else {
          // Logout: cancelamos cualquier reintento ya programado
          clearReconnectTimer();
          console.log('Sesión cerrada (loggedOut). Borra auth/ y vuelve a escanear el QR.');
        }
      }
    });

    // Listener principal de mensajes entrantes.
    // ==============================================================================
    // 2. MENSAJES: CLIENTES, ADMIN Y EVENTOS DE SISTEMA
    // ==============================================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
      // Red de seguridad del listener completo: un error aquí (DB, resolución de JID,
      // etc.) no debe tirar abajo el proceso entero (unhandledRejection = bot caído).
      try {
        await handleIncomingMessage(messages, sock, config);
      } catch (error) {
        console.error('Error procesando mensaje de WhatsApp:', error?.message || error);
      }
    });

    /**
     * handleIncomingMessage: Cuerpo real del listener messages.upsert.
     * Separado en función propia para poder envolverlo en un solo try/catch
     * y no perder ningún mensaje entrante por una excepción no prevista.
     *
     * @param {Array} messages - Array de mensajes del evento (Baileys entrega 1 normalmente)
     * @param {object} sock - Socket Baileys activo
     * @param {object} config - loadBotConfig() ya resuelto para esta conexión
     */
    async function handleIncomingMessage(messages, sock, config) {
      const message = messages[0];

      if (!message || message.key.remoteJid === 'status@broadcast') {
        return;
      }

      const isFromMe = message.key.fromMe;

      // Omite mensajes entrantes duplicados por reintentos de red ACK
      if (!isFromMe && message.key?.id && isRecentlyProcessedMessage(message.key.id)) {
        return;
      }

      // Guardamos el contenido por si WhatsApp pide reintento de descifrado (getMessage)
      if (message.message && message.key?.id) {
        rememberMessage(message.key.id, message.message);
      }

      // Desempaquetamos ephemeral/viewOnce: sin esto, chats con mensajes temporales
      // llegan con texto vacío y el bot nunca responde.
      const content = unwrapMessageContent(message.message);
      const text = getMessageText(content);

      const botConfig = loadBotConfig();
      const adminList = botConfig.numeros_notificar || [];

      const remoteJid = message.key.remoteJid;

      const selfChat = isSelfChat(remoteJid, sock, message);
      const senderIsAdmin = await isSenderAdmin({ message, sock, remoteJid, adminList });
      const operatorConsole = await isOperatorConsoleChannel({
        remoteJid,
        message,
        sock,
        adminList,
        isFromMe
      });

      // Eventos de sistema (mensajes temporales on/off, borrados, stubs):
      // NO son intervención humana ni comandos. Si el bot desactiva temporales
      // al responder, ese protocolMessage llega con fromMe y antes silenciaba el chat.
      if (isProtocolOrSystemMessage(message, content)) {
        return;
      }

      // Eco de lo que el bot acaba de enviar: ignorar siempre
      if (isFromMe && wasSentByBot(message.key.id)) {
        return;
      }

      const parts = text.trim().split(/\s+/).filter(Boolean);
      const command = (parts[0] || '').toLowerCase();

      // --------------------------------------------------------------------------
      // 2.1 Consola operador PRIMERO (self-chat o ADMIN_NUMBERS → /menu, toggles)
      // Debe ir antes del mute por intervención humana para que /menu siempre responda.
      // --------------------------------------------------------------------------
      if (operatorConsole) {
        if (ADMIN_COMMANDS.includes(command)) {
          if (parts.length < 2) {
            const help = `⚠️ Uso: ${command} <número>\nEjemplo: ${command} 56912345678`;
            await sendTracked(sock, remoteJid, { text: help });
            return;
          }

          const targetIds = await resolveSessionIdsForCommand(sock, parts[1]);

          if (command === '/detenerbot') {
            for (const id of targetIds) {
              const tgtSession = getSession(id);
              tgtSession.isMuted = true;
              tgtSession.silenciado_timestamp = Date.now();
              saveSession(id, tgtSession);
            }
            console.log(`🔇 Bot DETENIDO manualmente para: ${targetIds.join(', ')}`);
            await sendTracked(sock, remoteJid, { text: `🔇 Cliente ${parts[1]} silenciado.` });
            return;
          }

          if (command === '/iniciarbot') {
            for (const id of targetIds) {
              const tgtSession = getSession(id);
              tgtSession.isMuted = false;
              saveSession(id, tgtSession);
            }
            console.log(`🤖 Bot INICIADO manualmente para: ${targetIds.join(', ')}`);
            await sendTracked(sock, remoteJid, { text: `🤖 Cliente ${parts[1]} iniciado.` });
            return;
          }

          if (command === '/reiniciarbot') {
            for (const id of targetIds) {
              resetSession(id);
            }
            console.log(`🔄 Sesión REINICIADA para: ${targetIds.join(', ')}`);
            await sendTracked(sock, remoteJid, { text: `✅ Sesión de ${parts[1]} reiniciada.` });
            return;
          }
        }

        await handleOperatorConsoleMessage({
          message,
          sock,
          config,
          botConfig,
          remoteJid,
          text,
          content
        });
        return;
      }

      // --------------------------------------------------------------------------
      // 2.2 Intervención humana real en chat de cliente → mute automático
      // Solo fromMe con contenido real; nunca en consola operador (ya salió arriba).
      // --------------------------------------------------------------------------
      if (
        isFromMe
        && isClientCustomerChat(remoteJid, adminList, sock, message)
        && hasHumanChatContent(content)
      ) {
        const targetIds = await resolveSessionIdsForCommand(sock, remoteJid);
        const preferredId = getPreferredSessionId(message);
        if (!targetIds.includes(preferredId)) targetIds.push(preferredId);

        for (const id of targetIds) {
          const tgtSession = getSession(id);
          tgtSession.isMuted = true;
          tgtSession.silenciado_timestamp = Date.now();
          saveSession(id, tgtSession);
        }
        console.log(`🔇 Bot SILENCIADO automáticamente por intervención humana en: ${targetIds.join(', ')}`);
        return;
      }

      // Comandos admin en chat de cliente: ignorar (evita /detenerbot sin contexto)
      if ((isFromMe || senderIsAdmin || selfChat) && ADMIN_COMMANDS.includes(command)) {
        const inClientChat = isClientCustomerChat(remoteJid, adminList, sock, message);
        if (inClientChat) {
          console.log(`⚠️ Comando ${command} ignorado en chat de cliente. Usa: ${command} <número> desde Mensaje para ti mismo.`);
        }
        return;
      }

      // --------------------------------------------------------------------------
      // 2.3 Flujo normal para clientes (si /respuestas on)
      // --------------------------------------------------------------------------
      if (!isCustomerBotEnabled()) {
        return;
      }
      const sessionId = getPreferredSessionId(message);
      const session = getSession(sessionId);
      if (session.isMuted) {
        return;
      }

      const clientPhoneE164 = await resolveClientPhoneE164({ message, sock, sessionId });
      const pushName = String(message.pushName || '').trim();
      if (clientPhoneE164) session.clientPhoneE164 = clientPhoneE164;
      if (pushName) session.clientPushName = pushName;

      // Meta Click-to-WhatsApp: ctwa_clid vive en contextInfo del primer mensaje del anuncio
      const ctwaAttr = extractMetaCtwaAttribution(message);
      const ctwaChanged = applyMetaCtwaToSession(session, ctwaAttr);
      if (ctwaAttr.ctwaClid) {
        console.log(`📎 CTWA clid capturado para ${sessionId}: ${String(ctwaAttr.ctwaClid).slice(0, 24)}…`);
      } else if (ctwaAttr.isCtwaSignal && !session.metaCtwaClid) {
        // Señal de anuncio sin clid legible (payload opaco de Meta) — igual marcamos origen
        console.log(
          `📎 CTWA señal sin clid (${ctwaAttr.conversionSource || ctwaAttr.entryPoint || 'ads'}) en ${sessionId}`
        );
      }

      if (clientPhoneE164 || pushName || ctwaChanged) {
        saveSession(sessionId, session);
      }

      // Si el clid llegó tarde (después del Lead curious), backfill touchpoint sin re-disparar CAPI
      if (ctwaChanged && session.metaCtwaClid) {
        syncCrmCtwaAttributionAsync(session);
      }

      const isGroup = message.key.remoteJid?.endsWith('@g.us');
      if (isGroup && !config.allowGroups) {
        return;
      }

      if (!shouldHandleMessage(text, config)) {
        return;
      }

      const cleanText = stripTriggerPrefix(text, config);
      if (!cleanText) {
        return;
      }

      try {
        // Callback por mensaje: captura sock/sessionId de ESTE chat.
        // Así, si hay varios clientes a la vez, un SOS no se mezcla con otro.
        // alertData = { type: 'SUCCESS'|'SOS', title, body, labelKey? }
        const sendAdminAlert = async (alertData) => {
          await notifyAdmins({
            sock,
            message,
            sessionId,
            adminList,
            alertData,
            labels: botConfig.labels,
            resolveClientPhoneLabel
          });
        };

        // Etiqueta Business sin pasar por alerta admin (engaged → Cliente potencial)
        const applyBusinessLabel = async (labelKey) => {
          const labelConfig = botConfig.labels?.[labelKey];
          if (!labelConfig) {
            console.warn(`⚠️ applyBusinessLabel: labelKey desconocido "${labelKey}"`);
            return null;
          }
          return applyChatLabel(sock, message, sessionId, labelConfig);
        };

        const reply = await processMessage(sessionId, cleanText, {
          sendAdminAlert,
          applyBusinessLabel,
          clientPhoneE164: clientPhoneE164 || session.clientPhoneE164 || undefined,
          pushName: pushName || session.clientPushName || undefined,
        });

        await deliverBotReply(sock, message.key.remoteJid, reply, botConfig.replyTiming || {});

      } catch (error) {
        console.error('Error procesando mensaje de WhatsApp:', error.message);
      }
    }
  } catch (error) {
    // Falló antes de conectar (auth, red, etc.): liberamos flag y reintentamos
    console.error('Error iniciando socket WhatsApp:', error.message);
    releaseConnecting();
    scheduleReconnect(5000);
  }
}

// ==============================================================================
// 3. RED DE SEGURIDAD DEL PROCESO
// El bot corre 24/7 sin supervisor interactivo. Una excepción o promesa sin
// .catch() en algún rincón (Baileys, un timer, un fire-and-forget) no debe
// tirar abajo todo el proceso: solo la logueamos y seguimos.
// Si pm2/systemd reinicia el proceso en cada crash, preferimos loguear y seguir
// vivo (los mensajes de WhatsApp no esperan a un restart).
// ==============================================================================
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Promesa sin manejar (unhandledRejection):', reason?.message || reason);
});

process.on('uncaughtException', (error) => {
  console.error('⚠️  Excepción no capturada (uncaughtException):', error?.message || error);
});

// Arranque de la app.
startBot().catch((error) => {
  console.error('No se pudo iniciar el bot de WhatsApp:', error.message);
  process.exit(1);
});
