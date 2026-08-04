// ==============================================================================
// OBJETIVO: Sync CRM (curious / engaged / nombre de perfil) hacia cocktailsontap.cl
// sin bloquear el bot.
// ==============================================================================
import { createContactViaApi, isCotApiConfigured } from './cot-api.js';

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
 *
 * @param {object} session
 * @param {{ touchpointType: string, extraPayload?: object }} opts
 */
function buildContactApiPayload(session, { touchpointType, extraPayload = {}, sendCapiLead = true }) {
  const firstName = contactFirstNameFromSession(session);
  return {
    phone: session.clientPhoneE164,
    touchpointType,
    sendCapiLead,
    ...(firstName ? { firstName } : {}),
    payload: {
      sessionId: session.sessionId || null,
      pushName: session.clientPushName || null,
      pushNameClean: firstName || null,
      ...extraPayload,
    },
  };
}

/**
 * syncCrmCurious: Primer contacto WA → stage curious + Lead CAPI (si aplica).
 * Idempotente a nivel session (crmCuriousSynced).
 *
 * @param {object} session
 * @returns {Promise<void>}
 */
export async function syncCrmCurious(session) {
  if (!session || session.crmCuriousSynced) return;
  if (!isCotApiConfigured()) return;

  const phone = session.clientPhoneE164;
  if (!phone) {
    console.warn('CRM curious sync omitido: sin teléfono E.164 en sesión', session.sessionId || '');
    return;
  }

  session.crmCuriousSynced = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, { touchpointType: 'bot_started' })
    );
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
      if (contactFirstNameFromSession(session)) session.crmNameSynced = true;
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
 * syncCrmEngaged: Cliente eligió menú / respondió → stage engaged + Contact CAPI.
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

  const phone = session.clientPhoneE164;
  if (!phone) {
    console.warn('CRM engaged sync omitido: sin teléfono E.164 en sesión', session.sessionId || '');
    return;
  }

  session.crmEngagedSynced = true;
  try {
    const res = await createContactViaApi(
      buildContactApiPayload(session, {
        touchpointType,
        extraPayload: {
          userIntent: session.userIntent || null,
          ...extraPayload,
        },
      })
    );
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
      if (contactFirstNameFromSession(session)) session.crmNameSynced = true;
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
 * Fire-and-forget wrappers so the conversation never waits on CRM/Meta.
 */
export function syncCrmCuriousAsync(session) {
  void syncCrmCurious(session);
}

export function syncCrmEngagedAsync(session, touchpointType, extraPayload) {
  void syncCrmEngaged(session, touchpointType, extraPayload);
}

export function syncCrmNameAsync(session) {
  void syncCrmName(session);
}

/**
 * Estados de “entrada” de cada flujo: el cliente ya vio el intro del bot aquí,
 * pero aún no avanzó (ej. clic Meta → EVENTOS_RECOGIDA_DATOS = sigue Curioso).
 */
const FLOW_ENTRY_STATES = new Set([
  'EVENTOS_RECOGIDA_DATOS',
  'BARRILES_FILTRO_CANAL',
]);

/**
 * notifyCrmOnBotStateChange: Dispara Engaged según transiciones reales del bot.
 *
 * Reglas:
 * - Curioso: lo marca el primer mensaje (syncCrmCurious), no este helper.
 * - Engaged A: sale del estado de entrada Eventos/Barriles hacia otro paso
 *   (el cliente respondió el intro y el flujo avanzó).
 * - Engaged B: desde el menú de bienvenida (routerMenuShown) elige Eventos,
 *   Barriles, Humano o cierra — ya respondió a nuestro welcome.
 * - No Engaged: primer clic Meta ESPERANDO_INTENCION → EVENTOS/BARRILES
 *   (routerMenuShown=false): solo Curioso.
 *
 * @param {object} session
 * @param {string} fromState
 * @param {string} toState
 */
export function notifyCrmOnBotStateChange(session, fromState, toState) {
  if (!session || !toState || fromState === toState) return;
  if (session.crmEngagedSynced) return;

  const from = String(fromState || '');
  const to = String(toState || '');

  // A) Avanzó dentro de Eventos / Barriles (salió del intro del flujo)
  if (FLOW_ENTRY_STATES.has(from) && to !== from) {
    syncCrmEngagedAsync(session, 'intent_selected', {
      choice: session.userIntent || to,
      fromState: from,
      toState: to,
      trigger: 'flow_entry_exit',
    });
    return;
  }

  // B) Eligió en el menú de bienvenida (ya hubo mensaje del bot)
  if (
    from === 'ESPERANDO_INTENCION' &&
    to !== 'ESPERANDO_INTENCION' &&
    session.routerMenuShown
  ) {
    syncCrmEngagedAsync(session, 'intent_selected', {
      choice: session.userIntent || to,
      fromState: from,
      toState: to,
      trigger: 'router_menu_choice',
    });
  }
}
