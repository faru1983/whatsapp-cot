import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qr from 'qrcode-terminal';
import { processMessage, setAdminAlertFunction } from './core/engine.js';
import { shouldHandleMessage, stripTriggerPrefix } from './logic/utils.js';
import { getSession, saveSession, resetSession } from './core/db.js';
import { loadBotConfig } from './core/config.js';
import { composeAdminAlertMessage } from './views/templates.js';
import { AUTH_DIR, PROJECT_ROOT, SQLITE_PATH } from './core/paths.js';
import process from 'node:process';

// BAILEYS_DEBUG=1 → logs detallados de Baileys (útil en el VPS para "Esperando mensaje")
const BAILEYS_DEBUG = process.env.BAILEYS_DEBUG === '1';

// ==============================================================================
// OBJETIVO: Punto de entrada del bot de WhatsApp.
// Este archivo conecta WhatsApp, escucha mensajes y los envía al motor de lógica
// (engine) para decidir qué responder.
// ==============================================================================

// Guarda IDs de mensajes enviados por el bot para evitar procesarlos como si fueran del cliente.
const botSentMessageIds = new Set();

// Caché en memoria de mensajes recientes (id → contenido).
// Baileys la usa en getMessage cuando el celular pide reintento de descifrado.
// Sin esto, el destinatario ve "Esperando mensaje..." con el reloj verde.
const recentMessages = new Map();
const RECENT_MESSAGES_MAX = 200;

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
    // silent en producción; BAILEYS_DEBUG=1 sube a debug para investigar descifrado
    const logger = pino({ level: BAILEYS_DEBUG ? 'debug' : 'silent' });

    console.log(`[BOOT] Proyecto: ${PROJECT_ROOT}`);
    console.log(`[BOOT] Auth: ${AUTH_DIR}`);
    console.log(`[BOOT] SQLite: ${SQLITE_PATH}`);
    console.log(`[BOOT] cwd: ${process.cwd()}`);
    console.log(`[BOOT] Node: ${process.version}`);
    console.log(`[BOOT] BAILEYS_DEBUG: ${BAILEYS_DEBUG}`);

    // AUTH_DIR es ruta absoluta → auth/ siempre en la raíz del repo
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[BOOT] WA version: ${version.join('.')} (isLatest=${isLatest})`);

    // Baileys 7: enableRecentMessageCache + enableAutoSessionRecreation
    // ayudan con "Esperando mensaje" (reintentos de descifrado / sesión Signal).
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
        // WhatsApp pide el contenido original para reintentar el envío cifrado
        const cached = key?.id ? recentMessages.get(key.id) : undefined;
        console.log(`[getMessage] id=${key?.id} jid=${key?.remoteJid} hit=${!!cached}`);
        if (cached) return cached;
        return undefined;
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Diagnóstico: estado de entrega (ACK). Si status avanza pero el celular no lee → fallo de descifrado.
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!u.key?.fromMe) continue;
        console.log(`[ACK] id=${u.key.id} jid=${u.key.remoteJid} status=${u.update?.status} err=${u.update?.error || '-'}`);
      }
    });

    // Si nunca llega open/close (cuelga en "connecting"), liberamos el flag a los 60s
    const connectingWatchdog = setTimeout(() => {
      if (!connectionSettled) {
        console.warn('[BOOT] Timeout esperando open/close; se libera isConnecting.');
        releaseConnecting();
      }
    }, 60000);

    // Listener de estado de conexión (QR, conectado, desconectado, reconexión automática).
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr: qrCode }) => {
      if (qrCode) {
        // En SSH el QR "small" casi nunca se escanea bien. Link de imagen + QR grande.
        console.log('');
        console.log('========== VINCULAR WHATSAPP ==========');
        console.log('Opción A — Abre este link en el navegador del PC y escanea la imagen:');
        console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrCode)}`);
        console.log('');
        console.log('Opción B — QR en terminal (amplía la ventana SSH):');
        console.log('WhatsApp > Dispositivos vinculados > Vincular dispositivo');
        qr.generate(qrCode, { small: false });
        console.log('======================================');
        console.log('');
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
        console.log('Conexión cerrada. ¿Intentar reconectar automáticamente?:', shouldReconnect, `(code=${statusCode})`);

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
    sock.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];

    if (!message || message.key.remoteJid === 'status@broadcast') {
      return;
    }

    // Guardamos el contenido por si WhatsApp pide reintento de descifrado (getMessage)
    if (message.message && message.key?.id) {
      rememberMessage(message.key.id, message.message);
    }

    const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';

    const botConfig = loadBotConfig();
    const adminList = botConfig.numeros_notificar || [];

    const isFromMe = message.key.fromMe;
    const senderJid = message.key.remoteJid;
    
    let isFromAdmin = adminList.includes(senderJid);
    if (!isFromAdmin && message.key.participant) {
      isFromAdmin = adminList.includes(message.key.participant);
    }

    const isAuthorized = isFromMe || isFromAdmin;

    // Si el mensaje viene de administradores o desde la propia cuenta del bot,
    // aquí manejamos comandos operativos como pausar/reanudar/reiniciar sesiones.
    if (isAuthorized) {
      if (botSentMessageIds.has(message.key.id)) return;

      let targetJid = message.key.remoteJid;

      const parts = text.trim().split(' ');
      const command = parts[0].toLowerCase();
      const validCommands = ['/detenerbot', '/iniciarbot', '/reiniciarbot'];

      if (validCommands.includes(command)) {
        let commandTargetJid = targetJid;
        let usingRemoteConsole = false;

        if (parts.length >= 2) {
          const rawTarget = parts[1];
          commandTargetJid = rawTarget.includes('@') ? rawTarget : `${rawTarget}@s.whatsapp.net`;
          usingRemoteConsole = true;
        }

        if (!usingRemoteConsole) {
          try {
            await sock.sendMessage(targetJid, { delete: message.key });
          } catch (e) { console.error("Error borrando comando:", e.message); }
        }

        const tgtSession = getSession(commandTargetJid);
        
        if (command === '/detenerbot') {
          tgtSession.isMuted = true;
          console.log(`🔇 Bot DETENIDO manualmente para: ${commandTargetJid}`);
          if (usingRemoteConsole) {
            const sent = await sock.sendMessage(targetJid, { text: `🔇 Cliente ${parts[1] || 'actual'} silenciado.` });
            rememberMessage(sent?.key?.id, sent?.message || { conversation: `🔇 Cliente ${parts[1] || 'actual'} silenciado.` });
          }
        } else if (command === '/iniciarbot') {
          tgtSession.isMuted = false;
          console.log(`🤖 Bot INICIADO manualmente para: ${commandTargetJid}`);
          if (usingRemoteConsole) {
            const sent = await sock.sendMessage(targetJid, { text: `🤖 Cliente ${parts[1] || 'actual'} iniciado.` });
            rememberMessage(sent?.key?.id, sent?.message || { conversation: `🤖 Cliente ${parts[1] || 'actual'} iniciado.` });
          }
        } else if (command === '/reiniciarbot') {
          resetSession(commandTargetJid);
          console.log(`🔄 Sesión REINICIADA para: ${commandTargetJid}`);
          if (usingRemoteConsole) {
            const sent = await sock.sendMessage(targetJid, { text: `✅ Sesión de ${parts[1] || 'actual'} reiniciada.` });
            rememberMessage(sent?.key?.id, sent?.message || { conversation: `✅ Sesión de ${parts[1] || 'actual'} reiniciada.` });
          }
          return;
        }
        saveSession(commandTargetJid, tgtSession);
        return;
      }

      // Si un humano escribe en el chat de un cliente, silenciamos al bot automáticamente
      // para no interrumpir la conversación del vendedor.
      const isClientChat = (targetJid.endsWith('@s.whatsapp.net') || targetJid.endsWith('@lid')) && !adminList.includes(targetJid);

      if (isClientChat) {
        const session = getSession(targetJid);
        if (!session.isMuted) {
          session.isMuted = true;
          session.silenciado_timestamp = Date.now();
          saveSession(targetJid, session);
          console.log(`🔇 Bot SILENCIADO automáticamente (Intervención humana en ${targetJid})`);
        }
        return;
      }
      
      if (isFromMe) {
        return;
      }
    }

    // Desde aquí en adelante: flujo normal para clientes.
    const session = getSession(message.key.remoteJid);
    if (session.isMuted) {
      console.log(`[MSG] Ignorado (mute): ${message.key.remoteJid}`);
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
      console.log(`[MSG] Sin texto usable de ${message.key.remoteJid} (¿solo media/sticker?)`);
      return;
    }

    console.log(`[MSG] De ${message.key.remoteJid}: "${cleanText.slice(0, 80)}"`);

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
            rememberMessage(sent?.key?.id, sent?.message || { conversation: mensajeFinal });
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

      // Asegura sesión Signal con el destinatario (reduce "Esperando mensaje" en primer contacto)
      try {
        await sock.assertSessions([targetJid], true);
      } catch (e) {
        console.warn(`[SEND] assertSessions falló para ${targetJid}:`, e.message);
      }

      for (const textPart of replies) {
        if (!textPart) continue;
        // Sin quoted: en algunos celulares el quote rompe el descifrado ("Esperando mensaje")
        const sentMsg = await sock.sendMessage(targetJid, { text: textPart });
        if (sentMsg?.key?.id) {
          botSentMessageIds.add(sentMsg.key.id);
          // Guardamos el mensaje saliente para getMessage (reintentos de WhatsApp)
          rememberMessage(sentMsg.key.id, sentMsg.message || { conversation: textPart });
          console.log(`[SEND] OK id=${sentMsg.key.id} to=${targetJid} len=${textPart.length}`);
        } else {
          console.warn(`[SEND] sin id de mensaje hacia ${targetJid}`);
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