// ==============================================================================
// OBJETIVO: Extraer atribución Meta Click-to-WhatsApp (ctwa_clid) desde Baileys.
// Meta manda el clic del anuncio en contextInfo.externalAdReply.ctwaClid (o
// campos hermanos). Lo guardamos en sesión y lo enviamos al CRM → CAPI.
// ==============================================================================

/**
 * pickString: Devuelve el primer string no vacío de una lista.
 *
 * @param {...unknown} values
 * @returns {string|null}
 */
function pickString(...values) {
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) return s;
  }
  return null;
}

/**
 * collectContextInfos: Recorre el payload del mensaje y junta todos los
 * contextInfo (extendedText, imagen, ephemeral, etc.).
 *
 * @param {unknown} node
 * @param {object[]} out
 * @param {number} depth
 */
function collectContextInfos(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;

  if (node.contextInfo && typeof node.contextInfo === 'object') {
    out.push(node.contextInfo);
  }

  // Wrappers típicos de Baileys / mensajes temporales / view-once
  const nestedKeys = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'templateMessage',
    'buttonsMessage',
    'listMessage',
    'interactiveMessage',
    'editedMessage',
  ];
  for (const key of nestedKeys) {
    if (node[key]?.message) collectContextInfos(node[key].message, out, depth + 1);
    else if (node[key]) collectContextInfos(node[key], out, depth + 1);
  }

  // Contenidos con caption / texto que suelen traer contextInfo
  const contentKeys = [
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'audioMessage',
    'buttonsResponseMessage',
    'listResponseMessage',
    'templateButtonReplyMessage',
    'conversation',
  ];
  for (const key of contentKeys) {
    if (node[key] && typeof node[key] === 'object') {
      collectContextInfos(node[key], out, depth + 1);
    }
  }

  // A veces el root es message.message
  if (node.message && typeof node.message === 'object') {
    collectContextInfos(node.message, out, depth + 1);
  }
}

/**
 * attributionFromContextInfo: Lee ctwaClid y metadatos útiles de un contextInfo.
 *
 * @param {object} ctx
 * @returns {{ ctwaClid: string|null, sourceId: string|null, sourceUrl: string|null, conversionSource: string|null, entryPoint: string|null }}
 */
function attributionFromContextInfo(ctx) {
  const ad = ctx?.externalAdReply || ctx?.quotedAd?.externalAdReply || null;
  return {
    ctwaClid: pickString(ad?.ctwaClid, ad?.ctwa_clid, ctx?.ctwaClid),
    sourceId: pickString(ad?.sourceId, ad?.source_id),
    sourceUrl: pickString(ad?.sourceUrl, ad?.source_url, ctx?.sourceUrl),
    conversionSource: pickString(
      ctx?.conversionSource,
      ctx?.entryPointConversionSource,
      ctx?.entryPointConversionExternalSource
    ),
    entryPoint: pickString(ctx?.entryPointConversionApp, ad?.sourceApp),
  };
}

/**
 * extractMetaCtwaAttribution: Busca el Click ID de Meta Ads (ctwa_clid) en un
 * mensaje Baileys. Si no hay clid claro, igual devuelve señales CTWA (conversionSource)
 * para logs — el CRM solo usa ctwaClid.
 *
 * @param {object|null|undefined} waMessage - Mensaje completo (key + message) o solo .message
 * @returns {{ ctwaClid: string|null, sourceId: string|null, sourceUrl: string|null, conversionSource: string|null, entryPoint: string|null, isCtwaSignal: boolean }}
 */
export function extractMetaCtwaAttribution(waMessage) {
  const empty = {
    ctwaClid: null,
    sourceId: null,
    sourceUrl: null,
    conversionSource: null,
    entryPoint: null,
    isCtwaSignal: false,
  };
  if (!waMessage || typeof waMessage !== 'object') return empty;

  const contexts = [];
  // Preferimos el contenido ya normalizado si el caller pasó message.message
  collectContextInfos(waMessage.message || waMessage, contexts);

  let best = { ...empty };
  for (const ctx of contexts) {
    const found = attributionFromContextInfo(ctx);
    if (found.ctwaClid && !best.ctwaClid) best.ctwaClid = found.ctwaClid;
    if (found.sourceId && !best.sourceId) best.sourceId = found.sourceId;
    if (found.sourceUrl && !best.sourceUrl) best.sourceUrl = found.sourceUrl;
    if (found.conversionSource && !best.conversionSource) {
      best.conversionSource = found.conversionSource;
    }
    if (found.entryPoint && !best.entryPoint) best.entryPoint = found.entryPoint;
  }

  const signalText = `${best.conversionSource || ''} ${best.entryPoint || ''}`.toLowerCase();
  best.isCtwaSignal = Boolean(
    best.ctwaClid ||
      /ctwa|fb_ads|facebook|instagram|ads/.test(signalText)
  );

  return best;
}

/**
 * applyMetaCtwaToSession: Guarda ctwa_clid en la sesión sin pisar uno previo.
 * Retorna true si la sesión cambió (hay que saveSession).
 *
 * @param {object} session
 * @param {ReturnType<typeof extractMetaCtwaAttribution>} attribution
 * @returns {boolean}
 */
export function applyMetaCtwaToSession(session, attribution) {
  if (!session || !attribution) return false;
  let changed = false;

  if (attribution.ctwaClid && !session.metaCtwaClid) {
    session.metaCtwaClid = attribution.ctwaClid;
    changed = true;
  }
  if (attribution.sourceId && !session.metaAdSourceId) {
    session.metaAdSourceId = attribution.sourceId;
    changed = true;
  }
  if (attribution.conversionSource && !session.metaConversionSource) {
    session.metaConversionSource = attribution.conversionSource;
    changed = true;
  }
  if (attribution.isCtwaSignal && !session.metaFromCtwa) {
    session.metaFromCtwa = true;
    changed = true;
  }

  return changed;
}
