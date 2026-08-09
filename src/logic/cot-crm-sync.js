// ==============================================================================
// OBJETIVO: Sync CRM (curious / engaged / nombre de perfil) hacia cocktailsontap.cl
// sin bloquear el bot.
// ==============================================================================
import { createContactViaApi, isCotApiConfigured } from './cot-api.js';
import { isTestDebug } from '../core/debug-log.js';

/** Nombres basura que no deben quedar como first_name en el CRM. */
const PLACEHOLDER_NAMES = new Set(['whatsapp', 'whats app', 'cliente', 'cliente wa', 'lead']);

/**
 * sanitizeWaPushName: Limpia el pushName de WhatsApp para usarlo como nombre CRM.
 * Ej: "~Mona 🐵" → "Mona 🐵"; "WhatsApp" → undefined.
 *
 * @param {unknown} raw
 * @returns {string|undefined}
 */
export function sanitizeWaPushName(raw) {
  let name = String(raw || '').trim();
  // WA marca contactos no guardados con "~" delante del nombre de perfil
  name = name.replace(/^~\s*/, '').trim();
  if (name.length < 1) return undefined;
  if (PLACEHOLDER_NAMES.has(name.toLowerCase())) return undefined;
  // Evitar nombres que son solo el canal
  if (/^whatsapp$/i.test(name)) return undefined;
  return name;
}

/**
 * contactFirstNameFromSession: Nombre de perfil WA (pushName) si es usable.
 *
 * @param {object} session
 * @returns {string|undefined}
 */
function contactFirstNameFromSession(session) {
  return sanitizeWaPushName(session?.clientPushName);
}

/**
 * buildContactApiPayload: Body común para POST /api/v1/contacts.
 * Si la sesión trae metaCtwaClid (clic Meta Ads → WA), lo manda para CAPI.
 *
 * @param {object} session
 * @param {{ touchpointType: string, extraPayload?: object, sendCapiLead?: boolean, engagedContext?: object }} opts
 */
function buildContactApiPayload(session, {
  touchpointType,
  extraPayload = {},
  sendCapiLead = true,
  engagedContext = null,
}) {
  const firstName = contactFirstNameFromSession(session);
  const ctwaClid = String(session?.metaCtwaClid || '').trim() || undefined;
  const ctx = engagedContext || {};

  return {
    phone: session.clientPhoneE164,
    touchpointType,
    sendCapiLead,
    ...(firstName ? { firstName } : {}),
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(ctx.intent ? { intent: ctx.intent } : {}),
    ...(ctx.crmNote ? { crmNote: ctx.crmNote } : {}),
    ...(ctx.guests != null && ctx.guests > 0 ? { engagedGuests: ctx.guests } : {}),
    ...(ctx.celebration ? { engagedCelebration: ctx.celebration } : {}),
    ...(ctx.eventDate ? { engagedEventDate: ctx.eventDate } : {}),
    ...(ctx.comuna ? { engagedComuna: ctx.comuna } : {}),
    payload: {
      sessionId: session.sessionId || null,
      pushName: session.clientPushName || null,
      pushNameClean: firstName || null,
      ...(session?.metaAdSourceId ? { metaAdSourceId: session.metaAdSourceId } : {}),
      ...(session?.metaConversionSource
        ? { metaConversionSource: session.metaConversionSource }
        : {}),
      ...(session?.metaFromCtwa ? { metaFromCtwa: true } : {}),
      ...extraPayload,
    },
  };
}

/**
 * resolveCrmIntentFromSession: Mapea userIntent / estado del bot → intent CRM (event | direct).
 *
 * @param {object} session
 * @returns {'event'|'direct'|undefined}
 */
function resolveCrmIntentFromSession(session) {
  const ui = String(session?.userIntent || '').toUpperCase();
  if (ui === 'EVENTOS') return 'event';
  if (ui === 'BARRILES') return 'direct';
  const sid = String(session?.currentState || '');
  if (sid.startsWith('EVENTOS_')) return 'event';
  if (sid.startsWith('BARRILES_')) return 'direct';
  return undefined;
}

/**
 * buildEngagedLeadContext: Snapshot de datos del flujo al pasar a Interesado.
 *
 * @param {object} session
 * @returns {{ intent?: 'event'|'direct', snapshot: object, crmNote?: string, guests?: number, comuna?: string }}
 */
export function buildEngagedLeadContext(session) {
  const intent = resolveCrmIntentFromSession(session);
  const snapshot = {
    userIntent: session?.userIntent || null,
  };

  if (intent === 'event' || session.guests || session.celebrationType || session.date || session.location) {
    if (session.guests != null) snapshot.guests = session.guests;
    if (session.celebrationType) snapshot.celebration = session.celebrationType;
    if (session.date) snapshot.eventDate = session.date;
    if (session.location) snapshot.comuna = session.location;
  }

  const cd = session?.orderBuilder?.clientData;
  if (intent === 'direct' || cd?.date || cd?.location) {
    if (cd?.location) snapshot.comuna = cd.location;
    if (cd?.date) snapshot.deliveryDate = cd.date;
    if (!snapshot.eventDate && cd?.date) snapshot.eventDate = cd.date;
  }

  const crmNote = buildEngagedCrmNote(intent, snapshot);

  return {
    intent,
    snapshot,
    crmNote,
    guests: snapshot.guests,
    celebration: snapshot.celebration,
    eventDate: snapshot.eventDate || snapshot.deliveryDate,
    comuna: snapshot.comuna,
  };
}

/**
 * buildEngagedCrmNote: Una línea para clients.notes en el CRM.
 *
 * @param {'event'|'direct'|undefined} intent
 * @param {object} snapshot
 * @returns {string|undefined}
 */
function buildEngagedCrmNote(intent, snapshot) {
  const parts = [];
  if (intent === 'event') parts.push('Eventos');
  else if (intent === 'direct') parts.push('Barriles');
  if (snapshot.guests != null) parts.push(`${snapshot.guests} invitados`);
  if (snapshot.celebration) parts.push(snapshot.celebration);
  if (snapshot.eventDate) parts.push(snapshot.eventDate);
  if (snapshot.comuna) parts.push(snapshot.comuna);
  if (!parts.length) return undefined;
  return `WA Interesado: ${parts.join(', ')}`;
}

/**
 * syncCrmCurious: Primer contacto WA → stage curious (CRM/touchpoint; CAPI solo en engaged).
 * Si la sesión ya tiene carril (Eventos/Barriles), envía `intent` en el mismo POST.
 * Idempotente a nivel session (crmCuriousSynced).
 *
 * @param {object} session
 * @returns {Promise<void>}
 */
export async function syncCrmCurious(session) {
  if (!session || session.crmCuriousSynced) return;
  if (!isCotApiConfigured()) return;
  // Simulador local: no crear contactos reales en el CRM (mismo teléfono fijo siempre)
  if (isTestDebug()) return;

  const phone = session.clientPhoneE164;
  if (!phone) {
    console.warn('CRM curious sync omitido: sin teléfono E.164 en sesión', session.sessionId || '');
    return;
  }

  const intent = resolveCrmIntentFromSession(session);
  session.crmCuriousSynced = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, {
        touchpointType: 'bot_started',
        engagedContext: intent
          ? { intent, snapshot: { userIntent: session.userIntent || null } }
          : null,
      })
    );
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
      if (contactFirstNameFromSession(session)) session.crmNameSynced = true;
      if (intent) session.crmIntentSynced = true;
    } else if (!res.success) {
      session.crmCuriousSynced = false;
      console.error('CRM curious sync falló:', res.error);
    }
  } catch (err) {
    session.crmCuriousSynced = false;
    console.error('CRM curious sync error:', err);
  }
}

/**
 * syncCrmIntent: Parchea clients.intent cuando el carril ya se conoce (sigue Curioso).
 * Cubre el caso: Curioso se envió en el 1er mensaje sin intent, y luego eligió Barriles/Eventos.
 * Idempotente (crmIntentSynced). Al cambiar de carril, el caller debe resetear esa bandera.
 *
 * @param {object} session
 * @returns {Promise<void>}
 */
export async function syncCrmIntent(session) {
  if (!session || session.crmIntentSynced) return;
  const intent = resolveCrmIntentFromSession(session);
  if (!intent) return;
  if (!isCotApiConfigured()) return;
  if (isTestDebug()) return;

  const phone = session.clientPhoneE164;
  if (!phone) {
    console.warn('CRM intent sync omitido: sin teléfono E.164 en sesión', session.sessionId || '');
    return;
  }

  // Aún no hubo Curioso: un solo POST con intent incluido
  if (!session.crmCuriousSynced) {
    await syncCrmCurious(session);
    return;
  }

  session.crmIntentSynced = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, {
        touchpointType: 'bot_started',
        sendCapiLead: false,
        engagedContext: {
          intent,
          snapshot: { userIntent: session.userIntent || null },
        },
        extraPayload: {
          userIntent: session.userIntent || null,
          intentPatch: true,
        },
      })
    );
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
    } else if (!res.success) {
      session.crmIntentSynced = false;
      console.error('CRM intent sync falló:', res.error);
    }
  } catch (err) {
    session.crmIntentSynced = false;
    console.error('CRM intent sync error:', err);
  }
}

/**
 * syncCrmEngaged: Cliente con datos mínimos del flujo → stage Interesado + Contact CAPI.
 * Idempotente a nivel session (crmEngagedSynced).
 *
 * @param {object} session
 * @param {string} [touchpointType='intent_selected']
 * @param {object} [extraPayload]
 * @returns {Promise<void>}
 */
export async function syncCrmEngaged(session, touchpointType = 'intent_selected', extraPayload = {}) {
  if (!session || session.crmEngagedSynced) return;
  if (!isCotApiConfigured()) return;
  if (isTestDebug()) return;

  const phone = session.clientPhoneE164;
  if (!phone) {
    console.warn('CRM engaged sync omitido: sin teléfono E.164 en sesión', session.sessionId || '');
    return;
  }

  const engagedContext = buildEngagedLeadContext(session);

  session.crmEngagedSynced = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, {
        touchpointType,
        engagedContext,
        extraPayload: {
          ...engagedContext.snapshot,
          ...extraPayload,
        },
      })
    );
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
      if (contactFirstNameFromSession(session)) session.crmNameSynced = true;
      if (engagedContext.intent) session.crmIntentSynced = true;
    } else if (!res.success) {
      session.crmEngagedSynced = false;
      console.error('CRM engaged sync falló:', res.error);
    }
  } catch (err) {
    session.crmEngagedSynced = false;
    console.error('CRM engaged sync error:', err);
  }
}

/**
 * syncCrmName: Actualiza el nombre CRM cuando el pushName llega después del primer sync
 * (Baileys a veces no manda pushName en el 1er mensaje; el SOS sí lo muestra después).
 *
 * @param {object} session
 * @returns {Promise<void>}
 */
export async function syncCrmName(session) {
  if (!session || session.crmNameSynced) return;
  if (!isCotApiConfigured()) return;
  if (isTestDebug()) return;

  const phone = session.clientPhoneE164;
  const firstName = contactFirstNameFromSession(session);
  if (!phone || !firstName) return;

  session.crmNameSynced = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, {
        touchpointType: 'profile_name',
        sendCapiLead: false,
        extraPayload: { nameBackfill: true },
      })
    );
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
    } else if (!res.success) {
      session.crmNameSynced = false;
      console.error('CRM name sync falló:', res.error);
    }
  } catch (err) {
    session.crmNameSynced = false;
    console.error('CRM name sync error:', err);
  }
}

/**
 * syncCrmCtwaAttribution: Si el ctwa_clid llegó *después* del primer sync curious
 * (típico en resend CTWA de Baileys), guarda un touchpoint con el clid sin CAPI.
 * Contact/Purchase de cotización sí atribuyen con ese touchpoint.
 *
 * @param {object} session
 * @returns {Promise<void>}
 */
export async function syncCrmCtwaAttribution(session) {
  if (!session || session.metaCtwaSyncedToCrm) return;
  const ctwaClid = String(session.metaCtwaClid || '').trim();
  if (!ctwaClid) return;
  if (!session.crmCuriousSynced) {
    // El primer sync (curious) ya llevará el clid; solo marcamos para no duplicar touchpoint
    session.metaCtwaSyncedToCrm = true;
    return;
  }
  if (!isCotApiConfigured()) return;
  if (isTestDebug()) return;

  const phone = session.clientPhoneE164;
  if (!phone) return;

  session.metaCtwaSyncedToCrm = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, {
        touchpointType: 'ctwa_attribution',
        sendCapiLead: false,
        extraPayload: { ctwaBackfill: true },
      })
    );
    if (!res.success) {
      session.metaCtwaSyncedToCrm = false;
      console.error('CRM CTWA attribution sync falló:', res.error);
    }
  } catch (err) {
    session.metaCtwaSyncedToCrm = false;
    console.error('CRM CTWA attribution sync error:', err);
  }
}

/**
 * Fire-and-forget wrappers so the conversation never waits on CRM/Meta.
 */
export function syncCrmCuriousAsync(session) {
  void syncCrmCurious(session);
}

export function syncCrmIntentAsync(session) {
  void syncCrmIntent(session);
}

export function syncCrmEngagedAsync(session, touchpointType, extraPayload) {
  void syncCrmEngaged(session, touchpointType, extraPayload);
}

export function syncCrmNameAsync(session) {
  void syncCrmName(session);
}

export function syncCrmCtwaAttributionAsync(session) {
  void syncCrmCtwaAttribution(session);
}

/**
 * ¿Esta transición debe marcar Interesado (engaged) en el CRM?
 *
 * Eventos: recién al confirmar datos → elegir formato (ya hay invitados + resumen OK).
 * Barriles: al elegir 1️⃣ Pedido (o sí tras precios) → RECOGIDA_PRODUCTOS, o al nombrar
 * un sabor concreto desde la entrada (atajo) — eso ya es intención de compra clara.
 * Solo ver precios o dejar una duda sigue siendo Curioso.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function shouldEngageCrmOnTransition(from, to) {
  if (!from || !to || from === to) return false;
  // Eventos: Interesado con el snapshot completo al pasar a formato
  if (from === 'EVENTOS_CONFIRMAR_DATOS' && to === 'EVENTOS_ELECCION_FORMATO') return true;
  // Barriles: Interesado al elegir pedir (FILTRO o post-precios) / atajo sabor
  if (to === 'BARRILES_RECOGIDA_PRODUCTOS'
      && (from === 'BARRILES_INTRO_MENU' || from === 'BARRILES_FILTRO_CANAL')) return true;
  return false;
}

/**
 * notifyCrmOnBotStateChange: Dispara Interesado en la transición correcta del flujo.
 *
 * Reglas:
 * - Curioso: primer mensaje / menú (syncCrmCurious; con intent si ya hay carril).
 * - Intent CRM: al elegir Barriles/Eventos (mismo stage Curioso, syncCrmIntent).
 * - Interesado Eventos: CONFIRMAR_DATOS → ELECCION_FORMATO (datos ya confirmados).
 * - Interesado Barriles: FILTRO/INTRO → RECOGIDA_PRODUCTOS (elige pedido o atajo sabor).
 * - No Interesado: solo ver precios, duda/SOS, o solo avanzar recogida Eventos.
 *
 * @param {object} session
 * @param {string} fromState
 * @param {string} toState
 * @returns {boolean} true si este turno debe etiquetar "Cliente potencial" (una vez)
 */
export function notifyCrmOnBotStateChange(session, fromState, toState) {
  if (!session || !toState || fromState === toState) return false;

  const from = String(fromState || '');
  const to = String(toState || '');

  if (!shouldEngageCrmOnTransition(from, to)) return false;

  const engageMeta = {
    choice: session.userIntent || to,
    fromState: from,
    toState: to,
    trigger: from === 'EVENTOS_CONFIRMAR_DATOS'
      ? 'eventos_datos_confirmados'
      : from === 'BARRILES_INTRO_MENU'
        ? 'barriles_elige_pedido_post_precios'
        : from === 'BARRILES_FILTRO_CANAL'
          ? 'barriles_elige_pedido_o_sabor'
          : 'flow_entry_exit',
  };

  if (!session.crmEngagedSynced) {
    syncCrmEngagedAsync(session, 'intent_selected', engageMeta);
  }

  if (session.waLabelClientePotencialApplied) return false;
  return true;
}
