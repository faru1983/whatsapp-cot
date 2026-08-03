#!/usr/bin/env node
// ==============================================================================
// OBJETIVO: Diagnóstico del nudge sin enviar WhatsApp.
// Uso en el servidor: node scripts/nudge-diagnose.mjs
// Muestra hora Chile, cuántos quedarían elegibles si fuera hora cron, y motivos.
// ==============================================================================
import { loadBotConfig } from '../src/core/config.js';
import { closeDb } from '../src/core/db.js';
import { runNudgeScan } from '../src/core/nudge-runner.js';
import { getHourInTimezone } from '../src/logic/inactivity-nudge.js';

const now = Date.now();
const cfg = loadBotConfig().nudge;
const chileHour = getHourInTimezone(now, cfg.timezone || 'America/Santiago');

console.log('=== Diagnóstico nudge ===\n');
console.log(`enabled: ${cfg.enabled}`);
console.log(`hora Chile ahora: ${chileHour}`);
console.log(`cronHours: ${cfg.cronHours.join(', ')}`);
console.log(`minInactiveHours: ${cfg.minInactiveHours}`);
console.log(`maxInboundAgeHours: ${cfg.maxInboundAgeHours}`);
console.log(`states: ${cfg.states.join(', ')}`);
console.log(`en ventana cron ahora: ${cfg.cronHours.includes(chileHour) ? 'SÍ' : 'NO'}`);
console.log('');

// 1) Scan real (respeta cron)
const real = await runNudgeScan({
  sock: null,
  nudgeConfig: cfg,
  nowMs: now,
  dryRun: true
});
console.log(`\n--- Scan real (con cron) ---`);
console.log(`sent(dry)=${real.sent} checked=${real.checked} skipped=${real.skipped}`);

// 2) Scan ignorando cron: ¿quién estaría listo si fueran las 11 o 21?
const pretend = await runNudgeScan({
  sock: null,
  nudgeConfig: { ...cfg, enabled: true },
  nowMs: now,
  dryRun: true,
  ignoreCron: true
});
console.log(`\n--- Si ignoráramos cron (elegibles por inactividad) ---`);
console.log(`elegibles(dry)=${pretend.sent} checked=${pretend.checked} skipped=${pretend.skipped}`);

const byReason = {};
for (const d of pretend.details) {
  byReason[d.reason] = (byReason[d.reason] || 0) + 1;
}
console.log('motivos:', byReason);

const wouldSend = pretend.details.filter((d) => d.reason === 'dry_run_ok');
if (wouldSend.length) {
  console.log(`\nEjemplos elegibles (máx. 10):`);
  for (const d of wouldSend.slice(0, 10)) {
    console.log(`  - ${d.id} | ${d.state} | ${d.stallKey}`);
  }
} else {
  console.log('\nNingún lead elegible ahora (aunque fuera hora cron).');
  console.log('Causas típicas: missing_timestamps (sesión pre-nudge), muted, estado distinto, <4h o >24h.');
}

try {
  closeDb();
} catch (_) {}
process.exit(0);
