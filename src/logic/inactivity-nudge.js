// ==============================================================================
// OBJETIVO: Elegibilidad y copy del nudge por inactividad (v1).
// Solo primer paso de Barriles/Eventos; 1 nudge por sesión hasta que el cliente
// escriba de nuevo. No mutea: el bot sigue disponible si el lead vuelve.
// ==============================================================================

import { getPendingFlowRequirement } from './flow-stall.js';
import { getOnMissHint, formatMenuBlock, MENU_WRITE_CTA } from './flow-rails.js';

/** URL web por flujo (misma que usan los estados de entrada). */
const WEB_BY_STATE = {
  BARRILES_FILTRO_CANAL: 'https://cocktailsontap.cl/barriles',
  EVENTOS_RECOGIDA_DATOS: 'https://cocktailsontap.cl/eventos'
};

const INSTAGRAM_URL = 'https://instagram.com/cocktailsontap.chile';

const HOUR_MS = 60 * 60 * 1000;

/**
 * getHourInTimezone: Hora local 0–23 en la zona configurada (ej. America/Santiago).
 *
 * @param {number} nowMs - Timestamp actual
 * @param {string} timeZone - IANA timezone
 * @returns {number} Hora 0–23, o -1 si falla
 */
export function getHourInTimezone(nowMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(nowMs));
    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = parseInt(hourPart?.value, 10);
    return Number.isFinite(hour) ? hour : -1;
  } catch {
    return -1;
  }
}

/**
 * buildStallKey: Identificador del “bloqueo” actual (estado + dato pendiente).
 * Sirve para saber si el nudge ya cubrió este mismo atasco.
 *
 * @param {string} stateId
 * @param {string|null} pendingKey
 * @returns {string|null}
 */
export function buildStallKey(stateId, pendingKey) {
  if (!stateId || !pendingKey) return null;
  return `${stateId}:${pendingKey}`;
}

/**
 * clearNudgeFlag: Borra el registro de nudge (cuando el cliente vuelve a escribir).
 *
 * @param {object} session
 */
export function clearNudgeFlag(session) {
  if (!session) return;
  session.nudge = null;
}

/**
 * markNudgeSent: Marca que ya enviamos el único nudge de esta sesión/bloqueo.
 * No mutea: solo evita un segundo envío automático.
 *
 * @param {object} session
 * @param {string} stallKey
 * @param {number} [nowMs]
 */
export function markNudgeSent(session, stallKey, nowMs = Date.now()) {
  session.nudge = {
    sentAt: nowMs,
    stateId: session.currentState || null,
    stallKey: stallKey || null
  };
}

/**
 * isNudgeAlreadySent: ¿Ya mandamos nudge y el cliente aún no respondió?
 * Con maxPerStall=1, cualquier nudge previo en la sesión bloquea otro envío.
 *
 * @param {object} session
 * @param {object} nudgeConfig
 * @param {string|null} stallKey
 * @returns {boolean}
 */
export function isNudgeAlreadySent(session, nudgeConfig, stallKey) {
  const sentAt = session?.nudge?.sentAt;
  if (!sentAt) return false;

  const maxPer = Number(nudgeConfig?.maxPerStall || 1);
  if (maxPer <= 1) return true;

  // Por si en el futuro permiten >1: mismo stallKey cuenta como ya enviado
  const prevKey = session.nudge?.stallKey;
  return Boolean(prevKey && stallKey && prevKey === stallKey);
}

/**
 * evaluateNudgeEligibility: Decide si esta sesión debe recibir un nudge ahora.
 * Reglas (todas deben cumplirse):
 * - NUDGE_ENABLED
 * - estado en NUDGE_STATES y con dato pendiente
 * - no mute / no CERRADO
 * - bot ya respondió después del último mensaje del cliente
 * - inactivo ≥ minInactiveHours y último inbound < maxInboundAgeHours
 * - hora local en cronHours
 * - aún no se envió nudge (flag session.nudge)
 *
 * @param {object} session
 * @param {object} nudgeConfig - loadBotConfig().nudge
 * @param {number} [nowMs]
 * @returns {{ ok: boolean, reason?: string, stallKey?: string|null }}
 */
export function evaluateNudgeEligibility(session, nudgeConfig, nowMs = Date.now()) {
  if (!nudgeConfig?.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (!session || session.isMuted) {
    return { ok: false, reason: 'muted_or_missing' };
  }

  const stateId = session.currentState;
  if (!stateId || stateId === 'CERRADO') {
    return { ok: false, reason: 'closed_or_no_state' };
  }

  const allowed = Array.isArray(nudgeConfig.states) ? nudgeConfig.states : [];
  if (!allowed.includes(stateId)) {
    return { ok: false, reason: 'state_not_allowed' };
  }

  const pendingKey = getPendingFlowRequirement(session, stateId);
  if (!pendingKey) {
    return { ok: false, reason: 'no_pending' };
  }

  const stallKey = buildStallKey(stateId, pendingKey);

  if (isNudgeAlreadySent(session, nudgeConfig, stallKey)) {
    return { ok: false, reason: 'already_sent', stallKey };
  }

  const lastInboundAt = Number(session.lastInboundAt || 0);
  const lastOutboundAt = Number(session.lastOutboundAt || 0);
  if (!lastInboundAt || !lastOutboundAt) {
    return { ok: false, reason: 'missing_timestamps', stallKey };
  }

  // Esperamos respuesta del cliente: el bot ya habló después del último inbound
  if (lastOutboundAt < lastInboundAt) {
    return { ok: false, reason: 'bot_not_waiting', stallKey };
  }

  const inactiveMs = nowMs - lastInboundAt;
  const minMs = (nudgeConfig.minInactiveHours || 4) * HOUR_MS;
  if (inactiveMs < minMs) {
    return { ok: false, reason: 'too_soon', stallKey };
  }

  const maxAgeMs = (nudgeConfig.maxInboundAgeHours || 24) * HOUR_MS;
  if (inactiveMs > maxAgeMs) {
    return { ok: false, reason: 'outside_24h', stallKey };
  }

  const hour = getHourInTimezone(nowMs, nudgeConfig.timezone || 'America/Santiago');
  const cronHours = Array.isArray(nudgeConfig.cronHours) ? nudgeConfig.cronHours : [];
  if (hour < 0 || !cronHours.includes(hour)) {
    return { ok: false, reason: 'outside_cron_hour', stallKey };
  }

  return { ok: true, stallKey };
}

/**
 * resumeHeadline: Primera línea del nudge según el flujo.
 *
 * @param {string} stateId
 * @returns {string}
 */
function resumeHeadline(stateId) {
  if (stateId === 'BARRILES_FILTRO_CANAL') {
    return '¿Seguimos con tus *Barriles Desechables*? 🍸';
  }
  if (stateId === 'EVENTOS_RECOGIDA_DATOS') {
    return '¿Seguimos con tu cotización de *Servicio para Eventos*? 🥂';
  }
  return '¿Seguimos con tu cotización? 🍸';
}

/**
 * buildNudgeMessage: Texto del nudge (retomar + dato pendiente + web + IG).
 *
 * @param {object} session
 * @param {object} nudgeConfig
 * @returns {string|null}
 */
export function buildNudgeMessage(session, nudgeConfig) {
  const stateId = session?.currentState;
  if (!stateId) return null;

  const pendingKey = getPendingFlowRequirement(session, stateId);
  const hint = getOnMissHint(stateId, session, pendingKey)
    || 'Para avanzar, responde con el dato que te pedí.';

  const lines = [
    resumeHeadline(stateId),
    '',
    hint
  ];

  // Tip concreto por flujo (ejemplos que ya usa el bot)
  if (stateId === 'EVENTOS_RECOGIDA_DATOS') {
    lines.push('');
    if (pendingKey === 'celebration') {
      lines.push('Ejemplo: escribe *1* Cumpleaños, *2* Matrimonio, *3* Empresa o el tipo.');
    } else if (pendingKey === 'guests') {
      lines.push('Ejemplo: _"50 invitados"_ o _"unas 80 personas"_');
    } else {
      lines.push('Ejemplo: _"15 de mayo, Las Condes"_ (o *ok* para seguir)');
    }
  } else if (stateId === 'BARRILES_FILTRO_CANAL') {
    lines.push('');
    lines.push('Ejemplo: _"Providencia, 15 de mayo"_');
  }

  if (nudgeConfig?.includeWeb) {
    const web = WEB_BY_STATE[stateId];
    if (web) {
      lines.push('');
      lines.push('¿Prefieres ver todo con calma?');
      lines.push(`👉 ${web}`);
    }
  }

  if (nudgeConfig?.includeInstagram) {
    lines.push(`📸 ${INSTAGRAM_URL}`);
  }

  // Si quedó en menú raro, recordamos escribir opción (no aplica en v1, pero no molesta)
  if (pendingKey === 'intent') {
    lines.push('');
    lines.push(MENU_WRITE_CTA);
    lines.push(formatMenuBlock(['Servicio para Eventos', 'Barriles Desechables']));
  }

  return lines.join('\n').trim();
}
