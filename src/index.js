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
import { assertRuntimeConfigReady, loadBotConfig } from './core/config.js';
import { AUTH_DIR, PROJECT_ROOT } from './core/paths.js';
import { isImagePart, assertImageExists } from './logic/media.js';
import { rememberLabel } from './core/business-labels.js';
import {
  sendTracked,
  rememberMessage,
  wasSentByBot,
  getCachedMessage,
  notifyAdmins,
  logLabelReadyStatus
} from './core/whatsapp-send.js';
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
 * isSelfChat: Detecta el chat "Mensaje para ti mismo" (Message Yourself).
 * Ahí remoteJid suele ser el propio número del bot; no es un cliente.
 *
 * @param {string} remoteJid
 * @param {object|null} sock - Socket Baileys (para leer sock.user.id)
 * @returns {boolean}
 */
function isSelfChat(remoteJid, sock) {
  if (!remoteJid || !sock?.user?.id) return false;
  const meUser = jidUserPart(sock.user.id);
  const remoteUser = jidUserPart(remoteJid);
  if (meUser && remoteUser && meUser === remoteUser) return true;
  // A veces el self-chat llega como LID propio
  const meLid = sock.user.lid ? jidUserPart(sock.user.lid) : '';
  if (meLid && remoteUser && meLid === remoteUser) return true;
  return false;
}

/**
 * isClientCustomerChat: true si el chat es de un cliente (no admin, no self, no grupo).
 * Ahí NO deben ejecutarse comandos admin; solo mute por intervención humana real.
 *
 * @param {string} remoteJid - Chat donde llegó el evento
 * @param {string[]} adminList - JIDs de ADMIN_NUMBERS
 * @param {object|null} sock - Socket Baileys
 * @returns {boolean}
 */
function isClientCustomerChat(remoteJid, adminList, sock = null) {
  if (!remoteJid) return false;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return false;
  if (adminList.includes(remoteJid)) return false;
  // "Mensaje para ti mismo" = consola admin, no cliente
  if (isSelfChat(remoteJid, sock)) return false;
  return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
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
  const key = message.key || {};
  let mappedPn = null;

  // Si el chat llegó como LID, pedimos a Baileys el teléfono asociado
  try {
    if (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@lid')) {
      mappedPn = await sock.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid) || null;
    }
  } catch (_) { /* ignore */ }

  const realId = key.remoteJidAlt
    || key.senderPn
    || mappedPn
    || (typeof sessionId === 'string' && sessionId.endsWith('@s.whatsapp.net') ? sessionId : null)
    || key.participantAlt
    || key.participant
    || key.remoteJid
    || '';

  let displayId = String(realId)
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '')
    .replace('@lid', '');

  // Si solo tenemos LID, dejamos aviso claro (mejor que un número inventado)
  if (String(realId).endsWith('@lid') && !mappedPn && !key.remoteJidAlt && !key.senderPn) {
    displayId = `${displayId} [ID Oculto]`;
  }

  const nombrePerfil = message.pushName ? ` (${message.pushName})` : '';
  return `+${displayId}${nombrePerfil}`;
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
          logLabelReadyStatus(config.labels?.asistencia);
        }, 5000);
      }

      if (connection === 'close') {
        clearTimeout(connectingWatchdog);
        releaseConnecting();
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
      const message = messages[0];

      if (!message || message.key.remoteJid === 'status@broadcast') {
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

      const isFromMe = message.key.fromMe;
      const remoteJid = message.key.remoteJid;

      // Admin = mensaje desde un chat de ADMIN_NUMBERS, o participant admin en grupo
      let isFromAdmin = adminList.includes(remoteJid);
      if (!isFromAdmin && message.key.participant) {
        isFromAdmin = adminList.includes(message.key.participant);
      }

      const selfChat = isSelfChat(remoteJid, sock);

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

      // fromMe (incluye "Mensaje para ti mismo") o chat de ADMIN_NUMBERS
      const isAuthorized = isFromMe || isFromAdmin || selfChat;

      // --------------------------------------------------------------------------
      // 2.1 Comandos admin: desde chat propio / Message Yourself / admin + número
      // Formato: /detenerbot 56912345678  (nunca desde la ventana del cliente)
      // --------------------------------------------------------------------------
      if (isAuthorized) {
        const parts = text.trim().split(/\s+/).filter(Boolean);
        const command = (parts[0] || '').toLowerCase();

        if (ADMIN_COMMANDS.includes(command)) {
          const inClientChat = isClientCustomerChat(remoteJid, adminList, sock);

          // En el chat del cliente no aceptamos comandos (aunque sea fromMe)
          if (inClientChat) {
            console.log(`⚠️ Comando ${command} ignorado en chat de cliente. Usa: ${command} <número> desde Mensaje para ti mismo.`);
            return;
          }

          // Obligatorio: /comando + número (o JID)
          if (parts.length < 2) {
            const help = `⚠️ Uso: ${command} <número>\nEjemplo: ${command} 56912345678`;
            await sendTracked(sock, remoteJid, { text: help });
            return;
          }

          // Resolvemos PN + posibles @lid para no dejar sesiones huérfanas muteadas
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

        // --------------------------------------------------------------------------
        // 2.2 Intervención humana real en chat de cliente → mute automático
        // Solo si hay texto/multimedia. Borrados y cambios de temporales ya se filtraron.
        // --------------------------------------------------------------------------
        if (isClientCustomerChat(remoteJid, adminList, sock) && hasHumanChatContent(content)) {
          const sessionId = getPreferredSessionId(message);
          const session = getSession(sessionId);
          if (!session.isMuted) {
            session.isMuted = true;
            session.silenciado_timestamp = Date.now();
            saveSession(sessionId, session);
            // Si llegó como @lid, muteamos también el PN (y viceversa) para no dejar huecos
            if (sessionId !== remoteJid) {
              const altSession = getSession(remoteJid);
              altSession.isMuted = true;
              altSession.silenciado_timestamp = Date.now();
              saveSession(remoteJid, altSession);
            }
            console.log(`🔇 Bot SILENCIADO automáticamente (Intervención humana en ${sessionId})`);
          }
          return;
        }

        // fromMe / admin / self-chat sin comando: no seguir al flujo de cliente
        if (isFromMe || selfChat) {
          return;
        }
      }

      // --------------------------------------------------------------------------
      // 2.3 Flujo normal para clientes
      // --------------------------------------------------------------------------
      const sessionId = getPreferredSessionId(message);
      const session = getSession(sessionId);
      if (session.isMuted) {
        return;
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

        const reply = await processMessage(sessionId, cleanText, { sendAdminAlert });

        if (!reply) {
          return;
        }

        // El engine puede devolver string, imagen (img) o array mixto (foto + pregunta, etc.)
        const replies = Array.isArray(reply) ? reply : [reply];
        // Responder al JID con el que llegó el mensaje (puede ser @lid); la sesión usa sessionId
        const targetJid = message.key.remoteJid;

        // Asegura sesión Signal con el destinatario antes del primer envío
        try {
          await sock.assertSessions([targetJid], true);
        } catch (e) {
          console.warn(`assertSessions falló para ${targetJid}:`, e.message);
        }

        // Envío inmediato de cada bloque (sin delay entre customReplies:
        // un delay aquí hacía que el cliente escribiera "entre medio" de dos mensajes).
        for (const part of replies) {
          if (!part) continue;

          if (typeof part === 'string') {
            await sendTracked(sock, targetJid, { text: part });
            continue;
          }

          // Imagen desde assets/ (el engine ya validó que existe; defensa extra aquí)
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
          }
        }

      } catch (error) {
        console.error('Error procesando mensaje de WhatsApp:', error.message);
      }
    });
  } catch (error) {
    // Falló antes de conectar (auth, red, etc.): liberamos flag y reintentamos
    console.error('Error iniciando socket WhatsApp:', error.message);
    releaseConnecting();
    scheduleReconnect(5000);
  }
}

// Arranque de la app.
startBot().catch((error) => {
  console.error('No se pudo iniciar el bot de WhatsApp:', error.message);
  process.exit(1);
});
