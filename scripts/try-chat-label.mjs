#!/usr/bin/env node
// ==============================================================================
// OBJETIVO: Probar addChatLabel con un ID concreto (sin crear/reescribir la etiqueta).
//
// IMPORTANTE:
// - Detén el bot principal antes (npm start / pm2). Dos sockets = reconexiones.
// - NO llama a addLabel/ensureLabel: solo aplica el id existente al chat.
//
// Uso en el servidor:
//   node scripts/try-chat-label.mjs --phone 56912345678 --label 1
//   node scripts/try-chat-label.mjs --phone +56912345678 --label 3
//
// Luego mira ese chat en WhatsApp Web: ¿aparece "Cliente potencial"?
// ==============================================================================
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import process from 'node:process';
import { AUTH_DIR } from '../src/core/paths.js';

function parseArgs(argv) {
  const out = { phone: '', label: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--phone' || a === '-p') out.phone = String(argv[++i] || '').trim();
    else if (a === '--label' || a === '-l') out.label = String(argv[++i] || '').trim();
  }
  return out;
}

function toWhatsAppJid(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

const { phone, label } = parseArgs(process.argv.slice(2));
const jid = toWhatsAppJid(phone);
const labelId = String(label || '').trim();

if (!jid || !labelId) {
  console.error('Uso: node scripts/try-chat-label.mjs --phone 569XXXXXXXX --label 1');
  process.exit(1);
}

console.log('=== try-chat-label ===');
console.log(`auth: ${AUTH_DIR}`);
console.log(`chat: ${jid}`);
console.log(`labelId: ${labelId} (solo apply, sin addLabel)`);
console.log('Escuchando labels.edit 12s tras conectar...\n');

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();

const seenLabels = new Map();
let settled = false;

const sock = makeWASocket({
  version,
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
  },
  logger: pino({ level: 'silent' }),
  browser: Browsers.ubuntu('Chrome'),
  markOnlineOnConnect: false,
  syncFullHistory: false
});

sock.ev.on('creds.update', saveCreds);

sock.ev.on('labels.edit', (labelRow) => {
  if (!labelRow?.id) return;
  const id = String(labelRow.id);
  const name = String(labelRow.name || '').trim();
  if (labelRow.deleted) {
    seenLabels.delete(id);
    console.log(`🏷️ sync DELETE id=${id}`);
    return;
  }
  seenLabels.set(id, name);
  console.log(`🏷️ sync id=${id} name="${name}"`);
});

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    console.error('Hay QR: la sesión auth no está lista. Vincula el bot primero y reintenta.');
    process.exit(2);
  }

  if (connection === 'open' && !settled) {
    settled = true;
    console.log('WhatsApp conectado. Aplicando etiqueta...\n');

    try {
      await sock.addChatLabel(jid, labelId);
      console.log(`OK: addChatLabel(${jid}, "${labelId}") sin error.`);
      console.log('Revisa WhatsApp Web/celular: ¿qué etiqueta recibió ese chat?\n');
    } catch (err) {
      console.error('FALLO addChatLabel:', err?.message || err);
    }

    // Espera un poco por sync tardío de labels.edit
    setTimeout(() => {
      console.log('--- dump labels vistas en esta sesión ---');
      if (seenLabels.size === 0) {
        console.log('(ninguna: labels.edit no sincronizó, igual que el bot)');
      } else {
        for (const [id, name] of [...seenLabels.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
          console.log(`  id=${id} name="${name}"`);
        }
      }
      console.log('\nListo. Cierra este proceso (Ctrl+C) o espera salida.');
      try {
        sock.end(undefined);
      } catch (_) { /* ignore */ }
      process.exit(0);
    }, 12000);
  }

  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = code !== DisconnectReason.loggedOut;
    console.warn(`Conexión cerrada (code=${code}). reconnect sugerido=${shouldReconnect}`);
    if (!settled) process.exit(3);
  }
});
