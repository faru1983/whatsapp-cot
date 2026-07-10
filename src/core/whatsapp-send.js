// ==============================================================================
// OBJETIVO: Envío de mensajes WhatsApp con tracking + alertas a administradores.
// Centraliza sendMessage + anti-eco + caché getMessage, y el fan-out a admins
// (texto + etiqueta Business + opcional marcar no leído).
// ==============================================================================

import { composeAdminAlertMessage } from '../views/templates.js';
import { applyChatLabel, findLabelIdByName } from './business-labels.js';

// ==============================================================================
// 1. TRACKING DE MENSAJES (anti-eco + reintentos de descifrado)
// ==============================================================================

/** IDs enviados por el bot: si vuelven en messages.upsert con fromMe, los ignoramos. */
const botSentMessageIds = new Set();

/** Caché id → contenido para getMessage de Baileys (reintento de descifrado). */
const recentMessages = new Map();
const RECENT_MESSAGES_MAX = 200;

/**
 * rememberMessage: Guarda un mensaje enviado/recibido para reintentos de WhatsApp.
 * Si el celular no pudo descifrar, Baileys llama getMessage y reenvía este contenido.
 *
 * @param {string|undefined} id - ID del mensaje (message.key.id)
 * @param {object|undefined} content - Contenido proto del mensaje
 */
export function rememberMessage(id, content) {
  if (!id || !content) return;
  recentMessages.set(id, content);
  // Evitamos que la Map crezca sin límite en un servidor 24/7
  if (recentMessages.size > RECENT_MESSAGES_MAX) {
    const oldestKey = recentMessages.keys().next().value;
    recentMessages.delete(oldestKey);
  }
}

/**
 * wasSentByBot: ¿Este message.id lo enviamos nosotros?
 * Sirve para ignorar ecos fromMe en messages.upsert.
 *
 * @param {string|undefined} id
 * @returns {boolean}
 */
export function wasSentByBot(id) {
  if (!id) return false;
  return botSentMessageIds.has(id);
}

/**
 * getCachedMessage: Contenido guardado para getMessage de Baileys.
 *
 * @param {string|undefined} id
 * @returns {object|undefined}
 */
export function getCachedMessage(id) {
  if (!id) return undefined;
  return recentMessages.get(id);
}

/**
 * trackOutgoing: Marca un mensaje como enviado por el bot y lo guarda en caché.
 *
 * @param {object|null|undefined} sent - Resultado de sock.sendMessage
 * @param {object|string} fallbackContent - Contenido si sent.message viene vacío
 */
function trackOutgoing(sent, fallbackContent) {
  if (!sent?.key?.id) return;
  botSentMessageIds.add(sent.key.id);
  rememberMessage(sent.key.id, sent.message || fallbackContent);
}

// ==============================================================================
// 2. ENVÍO CON TRACKING
// ==============================================================================

/**
 * sendTracked: Envía un mensaje y registra su ID (anti-eco + getMessage).
 *
 * @param {object} sock - Socket Baileys
 * @param {string} jid - Destinatario
 * @param {object} content - Payload Baileys ({ text }, { image }, etc.)
 * @returns {Promise<object|null>} Resultado de sendMessage, o null si falló
 */
export async function sendTracked(sock, jid, content) {
  try {
    const sent = await sock.sendMessage(jid, content);
    // Para texto usamos conversation; para otros, el propio content
    const fallback = content?.text != null
      ? { conversation: content.text }
      : content;
    trackOutgoing(sent, fallback);
    return sent;
  } catch (e) {
    console.error(`Error enviando mensaje a ${jid}:`, e.message);
    return null;
  }
}

// ==============================================================================
// 3. MARCAR CHAT COMO NO LEÍDO
// ==============================================================================

/**
 * markChatUnread: Marca el chat como no leído (punto verde / badge).
 * Útil en SOS para que el vendedor vea el chat pendiente.
 *
 * @param {object} sock
 * @param {object} message - Mensaje del cliente (para lastMessages)
 * @param {string} chatJid - Chat a marcar
 */
export async function markChatUnread(sock, message, chatJid) {
  const lastMsg = {
    key: message.key,
    messageTimestamp: message.messageTimestamp
  };
  await sock.chatModify(
    { markRead: false, lastMessages: [lastMsg] },
    chatJid
  );
}

// ==============================================================================
// 4. ALERTAS A ADMINISTRADORES
// ==============================================================================

/**
 * resolveAlertLabelKey: Decide qué etiqueta aplicar según el alert.
 * - Si viene labelKey explícito, se usa.
 * - Si type es SOS (o falta type), usamos "asistencia".
 *
 * @param {object} alertData
 * @returns {string|null}
 */
function resolveAlertLabelKey(alertData) {
  if (alertData?.labelKey) return String(alertData.labelKey);
  const type = alertData?.type || 'SOS';
  if (type === 'SOS') return 'asistencia';
  return null;
}

/**
 * notifyAdmins: Avisa a todos los ADMIN_NUMBERS y, si corresponde, etiqueta
 * el chat del cliente (y opcionalmente lo marca no leído).
 *
 * alertData = { type: 'SUCCESS'|'SOS', title, body, labelKey? }
 *
 * @param {object} opts
 * @param {object} opts.sock
 * @param {object} opts.message - Mensaje del cliente (para JIDs / unread)
 * @param {string} opts.sessionId
 * @param {string[]} opts.adminList - JIDs de administradores
 * @param {object} opts.alertData - Payload desde engine / flujos
 * @param {object} opts.labels - botConfig.labels (asistencia, cotizacionBarriles, …)
 * @param {(message: object, sock: object, sessionId: string) => Promise<string>} opts.resolveClientPhoneLabel
 */
export async function notifyAdmins({
  sock,
  message,
  sessionId,
  adminList,
  alertData,
  labels,
  resolveClientPhoneLabel
}) {
  const clientLabel = await resolveClientPhoneLabel(message, sock, sessionId);
  const alertType = alertData?.type || 'SOS';

  // Misma cabecera para SOS y cotizaciones (templates.js)
  const mensajeFinal = composeAdminAlertMessage({
    type: alertType,
    title: alertData?.title || '',
    clientLabel,
    body: alertData?.body || alertData?.message || ''
  });

  // Una copia idéntica a cada administrador
  for (const adminNum of adminList || []) {
    await sendTracked(sock, adminNum, { text: mensajeFinal });
  }

  // Etiqueta Business según labelKey (o SOS → asistencia)
  const labelKey = resolveAlertLabelKey(alertData);
  const labelConfig = labelKey && labels ? labels[labelKey] : null;

  if (labelConfig) {
    try {
      await applyChatLabel(sock, message, sessionId, labelConfig);
    } catch (e) {
      console.warn(`No se pudo etiquetar chat (${labelKey}):`, e.message);
    }

    // Mark unread solo si esa etiqueta lo pide en .env
    if (labelConfig.markUnread) {
      const unreadJid = message.key?.remoteJid || sessionId;
      if (unreadJid) {
        try {
          await markChatUnread(sock, message, unreadJid);
          console.log(`📩 Chat marcado como no leído: ${unreadJid}`);
        } catch (e) {
          console.warn(`No se pudo marcar no leído ${unreadJid}:`, e.message);
        }
      }
    }
  }
}

/**
 * logLabelReadyStatus: Tras conectar, informa si ya resolvemos la etiqueta de asistencia.
 * (Solo log de arranque; no crea la etiqueta todavía.)
 *
 * @param {{ name: string, id: string }} asistenciaConfig
 */
export function logLabelReadyStatus(asistenciaConfig) {
  const name = asistenciaConfig?.name || 'Asistencia';
  const id = asistenciaConfig?.id || findLabelIdByName(name);
  if (id) {
    console.log(`🏷️ Etiquetas: asistencia usará id=${id} (nombre="${name}")`);
  } else {
    console.log(
      `🏷️ Etiquetas: aún no hay "${name}" en caché. `
      + 'Se creará al primer SOS/cierre con LABEL_ASISTENCIA_ID del .env.'
    );
  }
}
