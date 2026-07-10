// ==============================================================================
// OBJETIVO: Etiquetas de WhatsApp Business (crear/asegurar y aplicar a un chat).
// Lo usa index.js / whatsapp-send.js para marcar chats (SOS, cotización, etc.).
// Los IDs estables vienen del .env (99, 98, 97…) porque las etiquetas del celular
// a menudo NO sincronizan hacia Baileys.
// ==============================================================================

// ==============================================================================
// 1. CACHÉ DE ETIQUETAS (id → nombre)
// ==============================================================================

/** @type {Map<string, string>} */
const businessLabelsById = new Map();

/**
 * rememberLabel: Guarda una etiqueta Business en caché (id + nombre).
 * Baileys las emite en el evento labels.edit al sincronizar o editar.
 *
 * @param {{ id?: string, name?: string, deleted?: boolean }} label
 */
export function rememberLabel(label) {
  if (!label?.id) return;
  if (label.deleted) {
    businessLabelsById.delete(String(label.id));
    return;
  }
  businessLabelsById.set(String(label.id), String(label.name || '').trim());
}

/**
 * findLabelIdByName: Busca en caché una etiqueta por nombre (minúsculas, trim).
 *
 * @param {string} name
 * @returns {string|null}
 */
export function findLabelIdByName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  for (const [id, labelName] of businessLabelsById.entries()) {
    if (String(labelName).trim().toLowerCase() === wanted) return id;
  }
  return null;
}

/**
 * resolveLabelIdFromConfig: Elige el ID a usar (config → caché por nombre → id default).
 *
 * @param {{ id?: string, name?: string }} labelConfig
 * @returns {string|null}
 */
export function resolveLabelIdFromConfig(labelConfig) {
  if (!labelConfig) return null;
  if (labelConfig.id) return String(labelConfig.id);
  return findLabelIdByName(labelConfig.name || '');
}

// ==============================================================================
// 2. CREAR / ASEGURAR ETIQUETA EN EL DISPOSITIVO VINCULADO
// ==============================================================================

/**
 * ensureLabel: Asegura que exista un labelId usable y que la etiqueta esté
 * creada desde Baileys (addLabel es idempotente con el mismo id).
 *
 * @param {object} sock - Socket Baileys
 * @param {{ id?: string, name: string, color?: number }} labelConfig
 * @returns {Promise<string|null>} ID asegurado, o null si no hay nombre
 */
export async function ensureLabel(sock, labelConfig) {
  const name = String(labelConfig?.name || '').trim();
  if (!name) return null;

  // Preferimos ID del .env; si no, el de caché por nombre; si no, el id pasado o '99'
  const createId = String(
    labelConfig.id
    || findLabelIdByName(name)
    || '99'
  );
  const color = Number.isFinite(labelConfig.color) ? labelConfig.color : 6;

  // Siempre re-aseguramos con addLabel: evita addChatLabel sobre un ID
  // que el dispositivo vinculado nunca vio.
  try {
    await sock.addLabel('', {
      id: createId,
      name,
      color,
      deleted: false
    });
    rememberLabel({ id: createId, name, deleted: false });
    console.log(`🏷️ Etiqueta Business asegurada: id=${createId} name="${name}"`);
  } catch (e) {
    console.warn(`No se pudo asegurar etiqueta "${name}" (id=${createId}):`, e.message);
  }

  return createId;
}

// ==============================================================================
// 3. RESOLVER JIDs DEL CHAT A ETIQUETAR
// ==============================================================================

/**
 * resolveLabelTargetJids: JIDs a etiquetar. Prioriza @lid (WhatsApp Web/Business
 * suele asociar etiquetas por LID; el PN solo a veces se refleja en el celular).
 *
 * @param {object} sock
 * @param {object} message - Mensaje Baileys del cliente
 * @param {string} sessionId - ID de sesión (puede ser PN)
 * @returns {Promise<string[]>} Orden: LID primero, luego PN
 */
export async function resolveLabelTargetJids(sock, message, sessionId) {
  const remoteJid = message.key?.remoteJid || '';
  const pnCandidates = new Set();
  const lidCandidates = new Set();

  const classify = (jid) => {
    if (!jid) return;
    if (jid.endsWith('@lid')) lidCandidates.add(jid);
    else if (jid.endsWith('@s.whatsapp.net')) pnCandidates.add(jid);
  };

  classify(remoteJid);
  classify(sessionId);
  classify(message.key?.remoteJidAlt);

  try {
    for (const pn of [...pnCandidates]) {
      const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pn);
      if (lid) lidCandidates.add(lid);
    }
    for (const lid of [...lidCandidates]) {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
      if (pn) pnCandidates.add(pn);
    }
  } catch (_) { /* ignore */ }

  // LID primero (más fiable en Baileys 7), luego PN (dual-write)
  return [...lidCandidates, ...pnCandidates];
}

// ==============================================================================
// 4. APLICAR ETIQUETA AL CHAT
// ==============================================================================

/**
 * applyChatLabel: Asegura la etiqueta y la aplica a los JIDs del chat del cliente.
 *
 * @param {object} sock
 * @param {object} message
 * @param {string} sessionId
 * @param {{ id?: string, name: string, color?: number }} labelConfig
 * @returns {Promise<string|null>} labelId usado, o null si falló
 */
export async function applyChatLabel(sock, message, sessionId, labelConfig) {
  const name = String(labelConfig?.name || '').trim();
  if (!name) {
    console.warn('⚠️ applyChatLabel: falta nombre de etiqueta en config.');
    return null;
  }

  const targetJids = await resolveLabelTargetJids(sock, message, sessionId);
  const labelId = await ensureLabel(sock, labelConfig);

  if (!labelId) {
    console.warn(
      `⚠️ Etiqueta no disponible (nombre="${name}"). `
      + 'Define LABEL_*_ID en .env o revisa permisos de etiquetas en WhatsApp Business.'
    );
    return null;
  }

  if (targetJids.length === 0) {
    console.warn('⚠️ applyChatLabel: no hay JIDs destino para etiquetar.');
    return labelId;
  }

  let labeledOk = 0;
  for (const jid of targetJids) {
    try {
      await sock.addChatLabel(jid, labelId);
      labeledOk += 1;
      console.log(`🏷️ Etiqueta id=${labelId} ("${name}") aplicada a ${jid}`);
    } catch (e) {
      console.warn(`No se pudo etiquetar ${jid}:`, e.message);
    }
  }

  if (labeledOk === 0) {
    console.warn('⚠️ addChatLabel no aplicó a ningún JID. Revisa sync de etiquetas Business.');
  }

  return labelId;
}
