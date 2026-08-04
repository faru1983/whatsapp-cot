#!/usr/bin/env node
// ==============================================================================
// OBJETIVO: Descubrir IDs reales de etiquetas Business vía Baileys.
//
// Modo A — WATCH (recomendado si addChatLabel falló):
 //   1) Detén el bot principal.
 //   2) En WhatsApp Web, QUITA y vuelve a PONER "Cliente potencial" en TU chat
 //      (o el teléfono indicado) MIENTRAS corre este script.
 //   3) Baileys debería emitir labels.association con el labelId real.
//
 //   node scripts/try-chat-label.mjs --watch --phone 569XXXXXXXX
 //   node scripts/try-chat-label.mjs --watch --phone 569XXXXXXXX --seconds 90
//
 // Modo B — APPLY (solo prueba escribir un id, sin crear etiqueta):
 //   node scripts/try-chat-label.mjs --phone 569XXXXXXXX --label 1
//
 // IMPORTANTE: no uses addLabel aquí; no queremos pisar etiquetas default.
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
  const out = {
    phone: '',
    label: '',
    watch: false,
    seconds: 60
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--phone' || a === '-p') out.phone = String(argv[++i] || '').trim();
    else if (a === '--label' || a === '-l') out.label = String(argv[++i] || '').trim();
    else if (a === '--watch' || a === '-w') out.watch = true;
    else if (a === '--seconds' || a === '-s') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.seconds = Math.min(300, Math.floor(n));
    }
  }
  return out;
}

function toWhatsAppJid(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function jidMatchesTarget(chatId, targets) {
  if (!chatId) return false;
  if (!targets.size) return true; // sin filtro: mostrar todo
  const id = String(chatId);
  if (targets.has(id)) return true;
  // match por dígitos (por si llega con sufijos raros)
  const digits = id.replace(/\D/g, '');
  for (const t of targets) {
    if (digits && t.replace(/\D/g, '') === digits) return true;
  }
  return false;
}

function dumpJson(label, value) {
  console.log(`\n===== ${label} =====`);
  try {
    console.log(JSON.stringify(value, null, 2));
  } catch {
    console.log(value);
  }
}

const args = parseArgs(process.argv.slice(2));
const jid = toWhatsAppJid(args.phone);
const labelId = String(args.label || '').trim();
const watchMode = Boolean(args.watch) || !labelId;

if (!jid) {
  console.error('Uso watch: node scripts/try-chat-label.mjs --watch --phone 569XXXXXXXX');
  console.error('Uso apply: node scripts/try-chat-label.mjs --phone 569XXXXXXXX --label 1');
  process.exit(1);
}

if (!watchMode && !labelId) {
  console.error('Falta --label o usa --watch');
  process.exit(1);
}

console.log('=== try-chat-label ===');
console.log(`modo: ${watchMode ? 'WATCH (leer asociaciones)' : 'APPLY (solo addChatLabel)'}`);
console.log(`auth: ${AUTH_DIR}`);
console.log(`chat PN: ${jid}`);
if (!watchMode) console.log(`labelId a aplicar: ${labelId}`);
console.log(`ventana: ${args.seconds}s tras conectar\n`);

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();

/** @type {Map<string, object>} */
const seenLabels = new Map();
/** @type {Set<string>} */
const targetJids = new Set([jid]);
let settled = false;
let exitTimer = null;

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
  if (labelRow.deleted) {
    seenLabels.delete(id);
    console.log(`🏷️ labels.edit DELETE id=${id}`);
    return;
  }
  seenLabels.set(id, labelRow);
  console.log(
    `🏷️ labels.edit id=${id} name="${labelRow.name || ''}"`
    + ` color=${labelRow.color}`
    + (labelRow.predefinedId != null ? ` predefinedId=${labelRow.predefinedId}` : '')
  );
});

sock.ev.on('labels.association', (evt) => {
  const assoc = evt?.association || {};
  const type = evt?.type || '?';
  const chatId = assoc.chatId || assoc.chat || '';
  const lid = assoc.labelId;

  if (!jidMatchesTarget(chatId, targetJids)) {
    console.log(`(labels.association ignorada: chat=${chatId} type=${type} labelId=${lid})`);
    return;
  }

  dumpJson(`labels.association type=${type}`, evt);
  console.log(`→ chatId=${chatId} labelId=${lid}`);
  if (lid && seenLabels.has(String(lid))) {
    dumpJson('label conocida (labels.edit previo)', seenLabels.get(String(lid)));
  } else if (lid) {
    console.log('(aún no conocemos el nombre de ese labelId; mira si llega labels.edit)');
  }
});

// Por si el sync histórico trae labels en chats
sock.ev.on('chats.upsert', (chats) => {
  for (const chat of chats || []) {
    const id = chat?.id;
    if (!jidMatchesTarget(id, targetJids)) continue;
    if (chat.labels || chat.labelIds || chat.labeled) {
      dumpJson('chats.upsert (match)', chat);
    } else {
      console.log(`chats.upsert match ${id} (sin campo labels visible)`);
    }
  }
});

sock.ev.on('chats.update', (updates) => {
  for (const chat of updates || []) {
    const id = chat?.id;
    if (!jidMatchesTarget(id, targetJids)) continue;
    dumpJson('chats.update (match)', chat);
  }
});

sock.ev.on('messaging-history.set', (payload) => {
  const chats = payload?.chats || [];
  let hits = 0;
  for (const chat of chats) {
    if (!jidMatchesTarget(chat?.id, targetJids)) continue;
    hits += 1;
    dumpJson('history chat match', {
      id: chat.id,
      name: chat.name,
      labels: chat.labels,
      labelIds: chat.labelIds,
      keys: Object.keys(chat || {})
    });
  }
  if (hits === 0) {
    console.log(`messaging-history.set: ${chats.length} chats, ninguno del teléfono objetivo`);
  }
});

async function resolveLidTargets() {
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(jid);
    if (lid) {
      targetJids.add(lid);
      console.log(`LID mapeado: ${lid}`);
    } else {
      console.log('Sin LID mapeado aún (normal); si etiquetas por @lid, igual veremos el evento).');
    }
  } catch (e) {
    console.warn('No se pudo resolver LID:', e?.message || e);
  }
}

function finish(reason) {
  console.log(`\n--- fin (${reason}) ---`);
  console.log('labels.edit vistos:');
  if (seenLabels.size === 0) {
    console.log('  (ninguno)');
  } else {
    for (const [id, row] of [...seenLabels.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(
        `  id=${id} name="${row.name || ''}"`
        + (row.predefinedId != null ? ` predefinedId=${row.predefinedId}` : '')
      );
    }
  }
  try {
    sock.end(undefined);
  } catch (_) { /* ignore */ }
  process.exit(0);
}

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    console.error('Hay QR: la sesión auth no está lista. Vincula el bot primero y reintenta.');
    process.exit(2);
  }

  if (connection === 'open' && !settled) {
    settled = true;
    console.log('WhatsApp conectado.\n');
    await resolveLidTargets();

    if (watchMode) {
      console.log('MODO WATCH');
      console.log(`1) Abre WhatsApp Web.`);
      console.log(`2) En el chat de ${args.phone}, QUITA "Cliente potencial" si ya está.`);
      console.log(`3) Vuelve a PONER "Cliente potencial" (y/o "Nuevo pedido").`);
      console.log(`4) Espera hasta ${args.seconds}s: deberíamos ver labels.association + labelId.\n`);
    } else {
      console.log('MODO APPLY (sin addLabel)...');
      try {
        await sock.addChatLabel(jid, labelId);
        console.log(`OK: addChatLabel(${jid}, "${labelId}")`);
        // También intenta LID si existe
        for (const t of targetJids) {
          if (t === jid) continue;
          try {
            await sock.addChatLabel(t, labelId);
            console.log(`OK: addChatLabel(${t}, "${labelId}")`);
          } catch (e) {
            console.warn(`FALLO addChatLabel ${t}:`, e?.message || e);
          }
        }
      } catch (err) {
        console.error('FALLO addChatLabel:', err?.message || err);
      }
      console.log(`Escuchando eventos ${args.seconds}s por si igual llega sync...\n`);
    }

    exitTimer = setTimeout(() => finish('timeout'), args.seconds * 1000);
  }

  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = code !== DisconnectReason.loggedOut;
    console.warn(`Conexión cerrada (code=${code}). reconnect sugerido=${shouldReconnect}`);
    if (exitTimer) clearTimeout(exitTimer);
    if (!settled) process.exit(3);
    finish('connection_close');
  }
});
