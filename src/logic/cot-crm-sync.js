// ==============================================================================
// OBJETIVO: Sync CRM (curious / engaged) hacia cocktailsontap.cl sin bloquear el bot.
// ==============================================================================
import { createContactViaApi, isCotApiConfigured } from './cot-api.js';

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
  if (!phone) return;

  session.crmCuriousSynced = true;
  try {
    const res = await createContactViaApi({
      phone,
      touchpointType: 'bot_started',
      sendCapiLead: true,
      payload: { sessionId: session.sessionId || null }
    });
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
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
  if (!phone) return;

  session.crmEngagedSynced = true;
  try {
    const res = await createContactViaApi({
      phone,
      touchpointType,
      sendCapiLead: true,
      payload: {
        sessionId: session.sessionId || null,
        userIntent: session.userIntent || null,
        ...extraPayload
      }
    });
    if (res.success && res.clientId) {
      session.crmClientId = res.clientId;
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
 * Fire-and-forget wrappers so the conversation never waits on CRM/Meta.
 */
export function syncCrmCuriousAsync(session) {
  void syncCrmCurious(session);
}

export function syncCrmEngagedAsync(session, touchpointType, extraPayload) {
  void syncCrmEngaged(session, touchpointType, extraPayload);
}
