import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { processMessage, setAdminAlertFunction } from './core/engine.js';
import { shouldHandleMessage, stripTriggerPrefix } from './logic/utils.js';
import { getSession, saveSession, resetSession } from './core/db.js';
import { loadBotConfig } from './core/config.js';
import { composeAdminAlertMessage } from './views/templates.js';
import { AUTH_DIR, PROJECT_ROOT } from './core/paths.js';
import process from 'node:process';

// ==============================================================================
// OBJETIVO: Punto de entrada del bot de WhatsApp.
// Este archivo conecta WhatsApp, escucha mensajes y los envía al motor de lógica
// (engine) para decidir qué responder.
// ==============================================================================

// Guarda IDs de mensajes enviados por el bot para evitar procesarlos como si fueran del cliente.
const botSentMessageIds = new Set();

// Caché en memoria de mensajes recientes (id → contenido).
// Baileys la usa en getMessage cuando el celular pide reintento de descifrado.
const recentMessages = new Map();
const RECENT_MESSAGES_MAX = 200;

// Comandos que solo se usan desde el chat propio/admin, siempre con número de cliente.
const ADMIN_COMMANDS = ['/detenerbot', '/iniciarbot', '/reiniciarbot'];

// Evita abrir varios sockets a la vez (causa típica de "Esperando mensaje" y auth corrupta).
let isConnecting = false;
let reconnectTimer = null;

/**
 * rememberMessage: Guarda un mensaje enviado/recibido para reintentos de WhatsApp.
 * Si el celular no pudo descifrar, Baileys llama getMessage y reenvía este contenido.
 *
 * @param {string|undefined} id - ID del mensaje (message.key.id)
 * @param {object|undefined} content - Contenido proto del mensaje (message.message)
 */
function rememberMessage(id, content) {
  if (!id || !content) return;
  recentMessages.set(id, content);
  // Evitamos que la Map crezca sin límite en un servidor 24/7
  if (recentMessages.size > RECENT_MESSAGES_MAX) {
    const oldestKey = recentMessages.keys().next().value;
    recentMessages.delete(oldestKey);
  }
}

/**
 * sleep: Pausa asíncrona (ms). Se usa entre mensajes seguidos para no spamear WhatsApp.
 *
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * isClientCustomerChat: true si el chat es de un cliente (no admin ni grupo).
 * Ahí NO deben ejecutarse comandos admin; solo mute por intervención humana real.
 *
 * @param {string} remoteJid - Chat donde llegó el evento
 * @param {string[]} adminList - JIDs de ADMIN_NUMBERS
 * @returns {boolean}
 */
function isClientCustomerChat(remoteJid, adminList) {
  if (!remoteJid) return false;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return false;
  if (adminList.includes(remoteJid)) return false;
  return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
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
    const config = loadBotConfig();
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
        const cached = key?.id ? recentMessages.get(key.id) : undefined;
        return cached || undefined;
      }
    });

    sock.ev.on('creds.update', saveCreds);

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
      const sendDelayMs = botConfig.messageSendDelayMs || 1500;

      const isFromMe = message.key.fromMe;
      const remoteJid = message.key.remoteJid;

      // Admin = mensaje desde un chat de ADMIN_NUMBERS, o participant admin en grupo
      let isFromAdmin = adminList.includes(remoteJid);
      if (!isFromAdmin && message.key.participant) {
        isFromAdmin = adminList.includes(message.key.participant);
      }

      // Eventos de sistema (mensajes temporales on/off, borrados, stubs):
      // NO son intervención humana ni comandos. Si el bot desactiva temporales
      // al responder, ese protocolMessage llega con fromMe y antes silenciaba el chat.
      if (isProtocolOrSystemMessage(message, content)) {
        return;
      }

      // Eco de lo que el bot acaba de enviar: ignorar siempre
      if (isFromMe && botSentMessageIds.has(message.key.id)) {
        return;
      }

      const isAuthorized = isFromMe || isFromAdmin;

      // --------------------------------------------------------------------------
      // 2.1 Comandos admin: SOLO desde chat propio/admin + número de cliente
      // Formato: /detenerbot 56912345678  (nunca desde la ventana del cliente)
      // Así evitamos borrar mensajes en el chat del cliente y falsos mutes.
      // --------------------------------------------------------------------------
      if (isAuthorized) {
        const parts = text.trim().split(/\s+/).filter(Boolean);
        const command = (parts[0] || '').toLowerCase();

        if (ADMIN_COMMANDS.includes(command)) {
          // En el chat del cliente no aceptamos comandos (aunque sea fromMe)
          if (isClientCustomerChat(remoteJid, adminList)) {
            console.log(`⚠️ Comando ${command} ignorado en chat de cliente. Usa: ${command} <número> desde tu chat.`);
            return;
          }

          // Obligatorio: /comando + número (o JID)
          if (parts.length < 2) {
            const help = `⚠️ Uso: ${command} <número>\nEjemplo: ${command} 56912345678`;
            try {
              const sent = await sock.sendMessage(remoteJid, { text: help });
              if (sent?.key?.id) {
                botSentMessageIds.add(sent.key.id);
                rememberMessage(sent.key.id, sent.message || { conversation: help });
              }
            } catch (e) {
              console.error('Error enviando ayuda de comando:', e.message);
            }
            return;
          }

          const commandTargetJid = toClientJid(parts[1]);
          const tgtSession = getSession(commandTargetJid);

          if (command === '/detenerbot') {
            tgtSession.isMuted = true;
            tgtSession.silenciado_timestamp = Date.now();
            saveSession(commandTargetJid, tgtSession);
            console.log(`🔇 Bot DETENIDO manualmente para: ${commandTargetJid}`);
            const ack = `🔇 Cliente ${parts[1]} silenciado.`;
            const sent = await sock.sendMessage(remoteJid, { text: ack });
            if (sent?.key?.id) {
              botSentMessageIds.add(sent.key.id);
              rememberMessage(sent.key.id, sent.message || { conversation: ack });
            }
            return;
          }

          if (command === '/iniciarbot') {
            tgtSession.isMuted = false;
            saveSession(commandTargetJid, tgtSession);
            console.log(`🤖 Bot INICIADO manualmente para: ${commandTargetJid}`);
            const ack = `🤖 Cliente ${parts[1]} iniciado.`;
            const sent = await sock.sendMessage(remoteJid, { text: ack });
            if (sent?.key?.id) {
              botSentMessageIds.add(sent.key.id);
              rememberMessage(sent.key.id, sent.message || { conversation: ack });
            }
            return;
          }

          if (command === '/reiniciarbot') {
            resetSession(commandTargetJid);
            console.log(`🔄 Sesión REINICIADA para: ${commandTargetJid}`);
            const ack = `✅ Sesión de ${parts[1]} reiniciada.`;
            const sent = await sock.sendMessage(remoteJid, { text: ack });
            if (sent?.key?.id) {
              botSentMessageIds.add(sent.key.id);
              rememberMessage(sent.key.id, sent.message || { conversation: ack });
            }
            return;
          }
        }

        // --------------------------------------------------------------------------
        // 2.2 Intervención humana real en chat de cliente → mute automático
        // Solo si hay texto/multimedia. Borrados y cambios de temporales ya se filtraron.
        // --------------------------------------------------------------------------
        if (isClientCustomerChat(remoteJid, adminList) && hasHumanChatContent(content)) {
          const session = getSession(remoteJid);
          if (!session.isMuted) {
            session.isMuted = true;
            session.silenciado_timestamp = Date.now();
            saveSession(remoteJid, session);
            console.log(`🔇 Bot SILENCIADO automáticamente (Intervención humana en ${remoteJid})`);
          }
          return;
        }

        // fromMe / admin en chat que no es cliente (o sin contenido humano): no seguir al flujo
        if (isFromMe) {
          return;
        }
      }

      // --------------------------------------------------------------------------
      // 2.3 Flujo normal para clientes
      // --------------------------------------------------------------------------
      const session = getSession(message.key.remoteJid);
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
        // Función que engine usará para avisar eventos importantes (SOS / cierre de venta) a admins.
        // Formato unificado: cabecera (tipo + cliente) + cuerpo (pedido o motivo).
        // alertData = { type: 'SUCCESS'|'SOS', title: string, body: string }
        const sendAdminAlert = async (alertData) => {
          // Identificamos al cliente con el JID real de WhatsApp + nombre de perfil (pushName)
          const realId = message.key.participant || message.key.remoteJid;
          let displayId = realId.replace('@s.whatsapp.net', '').replace('@c.us', '');
          const nombrePerfil = message.pushName ? ` (${message.pushName})` : '';

          // Algunos chats usan @lid (ID oculto): no tenemos el número público
          if (displayId.includes('@lid')) {
            displayId = displayId.replace('@lid', '') + ' [ID Oculto]';
          }

          const clientLabel = `+${displayId}${nombrePerfil}`;

          // Armamos el mensaje con la misma cabecera para SOS y cotizaciones
          const mensajeFinal = composeAdminAlertMessage({
            type: alertData.type || 'SOS',
            title: alertData.title || '',
            clientLabel,
            body: alertData.body || alertData.message || ''
          });

          // Una copia idéntica a cada administrador de ADMIN_NUMBERS
          for (const adminNum of adminList) {
            try {
              const sent = await sock.sendMessage(adminNum, { text: mensajeFinal });
              if (sent?.key?.id) {
                botSentMessageIds.add(sent.key.id);
                rememberMessage(sent.key.id, sent.message || { conversation: mensajeFinal });
              }
            } catch (e) {
              console.error(`Error enviando alerta a ${adminNum}:`, e.message);
            }
          }
        };

        setAdminAlertFunction(sendAdminAlert);

        const reply = await processMessage(message.key.remoteJid, cleanText);

        if (!reply) {
          return;
        }

        // El engine puede devolver un string o un array de mensajes (bloques separados)
        const replies = Array.isArray(reply) ? reply : [reply];
        const targetJid = message.key.remoteJid;

        // Asegura sesión Signal con el destinatario antes del primer envío
        try {
          await sock.assertSessions([targetJid], true);
        } catch (e) {
          console.warn(`assertSessions falló para ${targetJid}:`, e.message);
        }

        // Enviamos con pausa entre mensajes seguidos (anti-spam WhatsApp Web + lectura natural)
        for (let i = 0; i < replies.length; i++) {
          const textPart = replies[i];
          if (!textPart) continue;

          if (i > 0 && sendDelayMs > 0) {
            await sleep(sendDelayMs);
          }

          // Sin quoted: en algunos celulares el quote rompe el descifrado
          const sentMsg = await sock.sendMessage(targetJid, { text: textPart });
          if (sentMsg?.key?.id) {
            botSentMessageIds.add(sentMsg.key.id);
            rememberMessage(sentMsg.key.id, sentMsg.message || { conversation: textPart });
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
