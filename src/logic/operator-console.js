// ==============================================================================
// OBJETIVO: Detectar si un mensaje viene de la consola operador (/menu).
// Self-chat, fromMe propio o ADMIN_NUMBERS (JID PN, LID o dígitos).
// ==============================================================================

/**
 * jidUserPart: Parte numérica del JID (sin device ni dominio).
 *
 * @param {string} jid
 * @returns {string}
 */
function jidUserPart(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

/**
 * extractPhoneDigits: Solo dígitos de un JID o número.
 *
 * @param {string} raw
 * @returns {string}
 */
function extractPhoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * adminDigitsFromList: Teléfonos configurados en ADMIN_NUMBERS (solo dígitos).
 *
 * @param {string[]} adminList
 * @returns {string[]}
 */
function adminDigitsFromList(adminList) {
  return (adminList || [])
    .map((jid) => extractPhoneDigits(jidUserPart(jid)))
    .filter((d) => d.length >= 8);
}

/**
 * isSelfChat: Chat "Mensaje para ti mismo" del número Business.
 *
 * @param {string} remoteJid
 * @param {object|null} sock
 * @param {object} [message]
 * @returns {boolean}
 */
export function isSelfChat(remoteJid, sock, message = null) {
  if (!remoteJid || !sock?.user?.id) return false;
  const meUser = jidUserPart(sock.user.id);
  const remoteUser = jidUserPart(remoteJid);
  if (meUser && remoteUser && meUser === remoteUser) return true;

  const meLid = sock.user.lid ? jidUserPart(sock.user.lid) : '';
  if (meLid && remoteUser && meLid === remoteUser) return true;

  const alt = message?.key?.remoteJidAlt || message?.key?.senderPn || '';
  if (alt) {
    const altUser = jidUserPart(alt);
    if (meUser && altUser === meUser) return true;
    if (meLid && altUser === meLid) return true;
  }

  // fromMe hacia el propio número (self-chat en Business)
  if (message?.key?.fromMe && meUser && remoteUser === meUser) return true;

  return false;
}

/**
 * resolveSenderPhoneDigits: Dígitos del remitente (PN o mapping LID).
 *
 * @param {object} message
 * @param {object} sock
 * @param {string} remoteJid
 * @returns {Promise<string>}
 */
async function resolveSenderPhoneDigits(message, sock, remoteJid) {
  const key = message?.key || {};
  let mappedPn = null;

  try {
    if (String(remoteJid || '').endsWith('@lid')) {
      mappedPn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(remoteJid) || null;
    }
  } catch {
    // ignore
  }

  const candidates = [
    key.remoteJidAlt,
    key.senderPn,
    mappedPn,
    remoteJid
  ].filter(Boolean);

  for (const jid of candidates) {
    if (String(jid).endsWith('@lid')) continue;
    const digits = extractPhoneDigits(jidUserPart(jid));
    if (digits.length >= 8) return digits;
  }

  return extractPhoneDigits(jidUserPart(remoteJid));
}

/**
 * isSenderAdmin: ¿El remitente está en ADMIN_NUMBERS?
 *
 * @param {object} params
 * @returns {Promise<boolean>}
 */
export async function isSenderAdmin({ message, sock, remoteJid, adminList }) {
  if (!remoteJid || !Array.isArray(adminList)) return false;

  if (adminList.includes(remoteJid)) return true;

  const alt = message?.key?.remoteJidAlt || message?.key?.senderPn || '';
  if (alt && adminList.includes(alt)) return true;

  const senderDigits = await resolveSenderPhoneDigits(message, sock, remoteJid);
  if (!senderDigits) return false;

  return adminDigitsFromList(adminList).includes(senderDigits);
}

/**
 * isOperatorConsoleChannel: Canal válido para /menu y comandos operador.
 * No incluye chats de clientes (aunque el vendedor escriba fromMe ahí).
 *
 * @param {object} params
 * @param {string} params.remoteJid
 * @param {object} params.message
 * @param {object} params.sock
 * @param {string[]} params.adminList
 * @param {boolean} params.isFromMe
 * @returns {Promise<boolean>}
 */
export async function isOperatorConsoleChannel({
  remoteJid,
  message,
  sock,
  adminList,
  isFromMe
}) {
  if (isSelfChat(remoteJid, sock, message)) return true;

  const senderIsAdmin = await isSenderAdmin({ message, sock, remoteJid, adminList });
  if (senderIsAdmin && !isFromMe) {
    // Admin personal escribiendo al número Business
    return true;
  }

  if (isFromMe && isSelfChat(remoteJid, sock, message)) return true;

  // fromMe en self-chat aunque isSelfChat falle por LID: comparar alt
  if (isFromMe) {
    const meUser = jidUserPart(sock?.user?.id);
    const alt = message?.key?.remoteJidAlt || message?.key?.senderPn || '';
    const altUser = jidUserPart(alt);
    if (meUser && altUser && meUser === altUser) return true;
    if (meUser && jidUserPart(remoteJid) === meUser) return true;
  }

  return false;
}

/**
 * isClientCustomerChat: Chat de un lead/cliente (no consola operador).
 *
 * @param {string} remoteJid
 * @param {string[]} adminList
 * @param {object|null} sock
 * @param {object} [message]
 * @returns {boolean}
 */
export function isClientCustomerChat(remoteJid, adminList, sock = null, message = null) {
  if (!remoteJid) return false;
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return false;
  if (adminList.includes(remoteJid)) return false;
  if (isSelfChat(remoteJid, sock, message)) return false;

  const alt = message?.key?.remoteJidAlt || message?.key?.senderPn || '';
  if (alt && adminList.includes(alt)) return false;

  return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
}
