// ==============================================================================
// OBJETIVO: Prueba mínima de Baileys (sin motor del bot).
// Sirve para saber si el "Esperando mensaje" es de Baileys/sesión o del flujo COT.
//
// Uso en el VPS:
//   cd ~/whatsapp-cot
//   npm run test:wa-echo
//
// Tras escanear el QR, WhatsApp suele cerrar con código 515 ("restart required").
// Eso es NORMAL: el script reconecta solo con las creds guardadas.
// Luego escribe "hola" desde otro celular → debe responder "ECHO: hola".
// ==============================================================================
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qr from 'qrcode-terminal';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authDir = path.join(root, 'auth-echo-test');
const recent = new Map();

let reconnectTimer = null;
let isConnecting = false;

console.log('=== WA ECHO TEST (Baileys aislado) ===');
console.log('Auth temporal:', authDir);
console.log('Node:', process.version);
console.log('Cierra WhatsApp Web / otros vínculos del mismo número antes de escanear.');
console.log('Nota: tras el QR puede aparecer error 515; el script reconecta solo.');
console.log('');

/**
 * startEcho: Abre (o reabre) el socket Baileys.
 * Tras el primer QR, WhatsApp manda stream error 515 → hay que reconectar.
 */
async function startEcho() {
  if (isConnecting) return;
  isConnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[BOOT] WA version: ${version.join('.')} (isLatest=${isLatest})`);

  const logger = pino({ level: process.env.BAILEYS_DEBUG === '1' ? 'debug' : 'info' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => {
      console.log(`[getMessage] pedido reintento id=${key?.id} jid=${key?.remoteJid}`);
      return key?.id ? recent.get(key.id) : undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr: qrCode }) => {
    if (qrCode) {
      console.log('Escanea este QR (solo para esta prueba):');
      qr.generate(qrCode, { small: true });
    }

    if (connection === 'open') {
      isConnecting = false;
      console.log('Conectado. Escribe desde OTRO número. Ctrl+C para salir.');
    }

    if (connection === 'close') {
      isConnecting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`Conexión cerrada. code=${code} loggedOut=${loggedOut}`);

      // 515 = restart required tras pairing (esperado). Reconectamos.
      // loggedOut = hay que borrar auth y escanear de nuevo.
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('messages.update');
        sock.ev.removeAllListeners('creds.update');
      } catch (_) { /* ignore */ }

      if (loggedOut) {
        console.log('Sesión invalidada. Borra auth-echo-test y vuelve a correr el script:');
        console.log('  rm -rf auth-echo-test && npm run test:wa-echo');
        process.exit(1);
        return;
      }

      if (reconnectTimer) return;
      console.log('Reconectando en 2s...');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startEcho().catch((e) => {
          console.error('Error al reconectar:', e.message);
          process.exit(1);
        });
      }, 2000);
    }
  });

  // Recibos de entrega / lectura
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      console.log('[messages.update]', JSON.stringify({
        id: u.key?.id,
        jid: u.key?.remoteJid,
        fromMe: u.key?.fromMe,
        status: u.update?.status,
        error: u.update?.error
      }));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const m = messages[0];
    if (!m || m.key.remoteJid === 'status@broadcast') return;

    if (m.message && m.key.id) recent.set(m.key.id, m.message);

    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      '';

    console.log('[upsert]', {
      type,
      fromMe: m.key.fromMe,
      jid: m.key.remoteJid,
      id: m.key.id,
      hasMessage: !!m.message,
      text: text.slice(0, 80)
    });

    if (m.key.fromMe || !text) return;

    const reply = `ECHO: ${text}`;
    try {
      await sock.assertSessions([m.key.remoteJid], true);
      const sent = await sock.sendMessage(m.key.remoteJid, { text: reply });
      if (sent?.key?.id) {
        recent.set(sent.key.id, sent.message || { conversation: reply });
      }
      console.log('[SEND OK]', {
        to: m.key.remoteJid,
        id: sent?.key?.id,
        status: sent?.status
      });
    } catch (e) {
      console.error('[SEND FAIL]', e?.message || e);
    }
  });
}

startEcho().catch((e) => {
  console.error('No se pudo iniciar la prueba:', e.message);
  process.exit(1);
});
