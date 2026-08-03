// ==============================================================================
// OBJETIVO: Escaneo periódico de sesiones y envío de nudges por inactividad.
// Se arranca al conectar WhatsApp y se detiene al cerrar la conexión.
// ==============================================================================

import { listAllSessions, getSession, saveSession } from './db.js';
import {
  evaluateNudgeEligibility,
  buildNudgeMessage,
  markNudgeSent,
  getHourInTimezone
} from '../logic/inactivity-nudge.js';
import { sendTracked } from './whatsapp-send.js';

/** ID del setInterval activo (uno solo; se limpia en reconnect). */
let nudgeIntervalId = null;

/** Evita spamear el mismo resumen "fuera de cron" cada 5 minutos. */
let lastOutsideCronLogAt = 0;
const OUTSIDE_CRON_LOG_EVERY_MS = 30 * 60 * 1000;

/**
 * stopNudgeRunner: Cancela el escaneo (al desconectar WhatsApp).
 */
export function stopNudgeRunner() {
  if (nudgeIntervalId != null) {
    clearInterval(nudgeIntervalId);
    nudgeIntervalId = null;
  }
}

/**
 * countReasons: Agrupa motivos de skip para el log.
 *
 * @param {object[]} details
 * @returns {string}
 */
function formatReasonCounts(details) {
  const counts = {};
  for (const d of details) {
    const key = d.reason || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ');
}

/**
 * runNudgeScan: Revisa todas las sesiones y envía nudges elegibles.
 * Pensado para llamarse desde el interval o en tests (sin WhatsApp real).
 *
 * @param {object} opts
 * @param {object} opts.sock - Socket Baileys (puede ser null en dry-run)
 * @param {object} opts.nudgeConfig - loadBotConfig().nudge
 * @param {number} [opts.nowMs]
 * @param {boolean} [opts.dryRun] - Si true, no envía ni marca (solo evalúa)
 * @param {boolean} [opts.ignoreCron] - Si true, no exige hora cron (solo diagnóstico)
 * @returns {Promise<{ checked: number, sent: number, skipped: number, details: object[], chileHour: number }>}
 */
export async function runNudgeScan({
  sock,
  nudgeConfig,
  nowMs = Date.now(),
  dryRun = false,
  ignoreCron = false
} = {}) {
  const summary = { checked: 0, sent: 0, skipped: 0, details: [], chileHour: -1 };

  if (!nudgeConfig?.enabled && !ignoreCron) {
    return summary;
  }

  const chileHour = getHourInTimezone(nowMs, nudgeConfig.timezone || 'America/Santiago');
  summary.chileHour = chileHour;
  const cronHours = Array.isArray(nudgeConfig.cronHours) ? nudgeConfig.cronHours : [];
  const inCronWindow = ignoreCron || cronHours.includes(chileHour);

  // Fuera de 11/21: no hace falta recorrer 500+ sesiones cada 5 min
  if (!inCronWindow) {
    summary.skipped = 1;
    summary.details.push({ id: '*', reason: 'outside_cron_hour' });
    if (nowMs - lastOutsideCronLogAt >= OUTSIDE_CRON_LOG_EVERY_MS) {
      lastOutsideCronLogAt = nowMs;
      console.log(
        `[nudge] fuera de ventana cron (hora Chile=${chileHour}, cron=${cronHours.join(',')}) — sin envíos`
      );
    }
    return summary;
  }

  const cfgForEval = ignoreCron
    ? { ...nudgeConfig, enabled: true, cronHours: [chileHour >= 0 ? chileHour : 12] }
    : nudgeConfig;

  const rows = listAllSessions();
  for (const { id, session } of rows) {
    summary.checked += 1;
    const verdict = evaluateNudgeEligibility(session, cfgForEval, nowMs);
    if (!verdict.ok) {
      summary.skipped += 1;
      summary.details.push({ id, reason: verdict.reason });
      continue;
    }

    const text = buildNudgeMessage(session, nudgeConfig);
    if (!text) {
      summary.skipped += 1;
      summary.details.push({ id, reason: 'empty_message' });
      continue;
    }

    if (dryRun) {
      summary.sent += 1;
      summary.details.push({
        id,
        reason: 'dry_run_ok',
        stallKey: verdict.stallKey,
        state: session.currentState
      });
      continue;
    }

    if (!sock) {
      summary.skipped += 1;
      summary.details.push({ id, reason: 'no_sock' });
      continue;
    }

    try {
      // Releemos por si el cliente escribió entre el listado y el envío
      const live = getSession(id);
      const liveVerdict = evaluateNudgeEligibility(live, cfgForEval, nowMs);
      if (!liveVerdict.ok) {
        summary.skipped += 1;
        summary.details.push({ id, reason: liveVerdict.reason });
        continue;
      }

      await sendTracked(sock, id, { text });

      // Marcamos para evitar el 2º nudge; no muteamos
      markNudgeSent(live, liveVerdict.stallKey, nowMs);
      live.lastOutboundAt = Date.now();
      live.history = live.history || { turns: [] };
      live.history.turns = live.history.turns || [];
      live.history.turns.push({ role: 'model', text });
      saveSession(id, live);

      summary.sent += 1;
      summary.details.push({ id, reason: 'sent', stallKey: liveVerdict.stallKey });
      console.log(`[nudge] enviado a ${id} (${live.currentState})`);
    } catch (err) {
      summary.skipped += 1;
      summary.details.push({ id, reason: 'send_error' });
      console.error(`[nudge] error enviando a ${id}:`, err?.message || err);
    }
  }

  const reasons = formatReasonCounts(summary.details);
  console.log(
    `[nudge] scan: horaChile=${chileHour} checked=${summary.checked} `
    + `sent=${summary.sent} skipped=${summary.skipped}`
    + (reasons ? ` | ${reasons}` : '')
  );

  return summary;
}

/**
 * startNudgeRunner: Interval que llama runNudgeScan según NUDGE_SCAN_SECONDS.
 * Si NUDGE_ENABLED=false, no arranca. Al reconectar, llamar stop + start.
 *
 * @param {object} sock - Socket Baileys conectado
 * @param {() => object} getNudgeConfig - Función que devuelve la config actual
 */
export function startNudgeRunner(sock, getNudgeConfig) {
  stopNudgeRunner();

  const initial = typeof getNudgeConfig === 'function' ? getNudgeConfig() : getNudgeConfig;
  if (!initial?.enabled) {
    console.log('[nudge] desactivado (NUDGE_ENABLED=false)');
    return;
  }

  const scanMs = Math.max(30, Number(initial.scanSeconds || 300)) * 1000;
  console.log(
    `[nudge] activo: scan cada ${scanMs / 1000}s | cron horas=${(initial.cronHours || []).join(',')} | `
    + `min inactivo=${initial.minInactiveHours}h | tz=${initial.timezone}`
  );

  const tick = () => {
    const cfg = typeof getNudgeConfig === 'function' ? getNudgeConfig() : getNudgeConfig;
    if (!cfg?.enabled) return;
    void runNudgeScan({ sock, nudgeConfig: cfg }).catch((err) => {
      console.error('[nudge] error en scan:', err?.message || err);
    });
  };

  // Primer tick diferido: deja asentar la conexión
  setTimeout(tick, 15_000);
  nudgeIntervalId = setInterval(tick, scanMs);
}
