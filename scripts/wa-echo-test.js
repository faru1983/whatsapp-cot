// ==============================================================================
// OBJETIVO: Prueba mínima de Baileys (sin motor del bot).
// Sirve para saber si el "Esperando mensaje" es de Baileys/sesión o del flujo COT.
// Uso en el VPS:
//   cd ~/whatsapp-cot
//   node scripts/wa-echo-test.js
// Escanea QR, escribe "hola" desde otro celular → el script responde "ECHO: hola".
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

console.log('=== WA ECHO TEST (Baileys aislado) ===');
console.log('Auth temporal:', authDir);
console.log('Node:', process.version);
console.log('Cierra WhatsApp Web / otros vínculos del mismo número antes de escanear.');
console.log('');

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
    console.log('Conectado. Escribe desde OTRO número. Ctrl+C para salir.');
  }
  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    console.log('Conexión cerrada. code=', code, 'loggedOut?', code === DisconnectReason.loggedOut);
    process.exit(1);
  }
});

// Recibos de entrega / lectura (1 check, 2 checks, etc.)
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
    // Asegura sesión Signal con el destinatario antes de enviar
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
