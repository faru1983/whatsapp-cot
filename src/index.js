import makeWASocket, {
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
// Sin esto, el destinatario ve "Esperando mensaje..." con el reloj verde.
const recentMessages = new Map();
const RECENT_MESSAGES_MAX = 200;

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

// Inicializa conexión con WhatsApp y registra todos los listeners de eventos.
async function startBot() {
  const config = loadBotConfig();
  const logger = pino({ level: 'silent' });

  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  // makeCacheableSignalKeyStore: cachea claves Signal en RAM (más estable y menos I/O a disco).
  // getMessage: obligatorio para que WhatsApp pueda pedir reenvío si falla el descifrado.
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60000,
    getMessage: async (key) => {
      // 1) Buscamos en nuestra caché de mensajes recientes
      const cached = key?.id ? recentMessages.get(key.id) : undefined;
      if (cached) return cached;
      // 2) Fallback vacío: evita crash; WhatsApp puede pedir otro reintento
      return undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Listener de estado de conexión (QR, conectado, desconectado, reconexión automática).
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr: qrCode }) => {
    if (qrCode) {
      console.log('Escanea este QR con WhatsApp > Dispositivos vinculados:');
      qr.generate(qrCode, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado. El bot está listo para trabajar.');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. ¿Intentar reconectar automáticamente?:', shouldReconnect);

      if (shouldReconnect) {
        startBot().catch((error) => {
          console.error('Error fatal al intentar reconectar:', error.message);
        });
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
      for (const textPart of replies) {
        if (!textPart) continue;
        // Sin quoted: en algunos celulares el quote rompe el descifrado ("Esperando mensaje")
        const sentMsg = await sock.sendMessage(message.key.remoteJid, { text: textPart });
        if (sentMsg?.key?.id) {
          botSentMessageIds.add(sentMsg.key.id);
          // Guardamos el mensaje saliente para getMessage (reintentos de WhatsApp)
          rememberMessage(sentMsg.key.id, sentMsg.message || { conversation: textPart });
        }
      }

    } catch (error) {
      console.error('Error procesando mensaje de WhatsApp:', error.message);
    }
  });
}

// Arranque de la app.
startBot().catch((error) => {
  console.error('No se pudo iniciar el bot de WhatsApp:', error.message);
  process.exit(1);
});