// ==============================================================================
// OBJETIVO: Interruptores globales del bot (respuestas a clientes y escrituras API).
// Se leen del .env al arrancar y se pueden cambiar con /respuestas y /cotapi
// desde self-chat o ADMIN_NUMBERS. Los overrides se guardan en db/bot-runtime.json.
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/paths.js';

/** @type {{ customerBotEnabled: boolean, cotApiWritesEnabled: boolean }|null} */
let cachedFlags = null;

const FLAGS_PATH = path.join(PROJECT_ROOT, 'db', 'bot-runtime.json');

/**
 * parseEnvBool: Solo la cadena "false" (cualquier mayúscula) es falso.
 *
 * @param {string|undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseEnvBool(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  return String(value).toLowerCase() !== 'false';
}

/**
 * readPersistedOverrides: Lee overrides guardados en disco (si existen).
 *
 * @returns {{ customerBotEnabled?: boolean, cotApiWritesEnabled?: boolean }}
 */
function readPersistedOverrides() {
  try {
    if (!fs.existsSync(FLAGS_PATH)) return {};
    const raw = fs.readFileSync(FLAGS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data ? data : {};
  } catch (err) {
    console.warn('bot-runtime-flags: no se pudo leer', FLAGS_PATH, err?.message || err);
    return {};
  }
}

/**
 * writePersistedOverrides: Guarda overrides en disco.
 *
 * @param {{ customerBotEnabled: boolean, cotApiWritesEnabled: boolean }} flags
 */
function writePersistedOverrides(flags) {
  try {
    fs.mkdirSync(path.dirname(FLAGS_PATH), { recursive: true });
    fs.writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2), 'utf8');
  } catch (err) {
    console.error('bot-runtime-flags: no se pudo guardar', FLAGS_PATH, err?.message || err);
  }
}

/**
 * getDefaultRuntimeFlags: Valores base desde .env (sin overrides en memoria).
 *
 * @returns {{ customerBotEnabled: boolean, cotApiWritesEnabled: boolean }}
 */
export function getDefaultRuntimeFlags() {
  const persisted = readPersistedOverrides();
  return {
    customerBotEnabled: persisted.customerBotEnabled
      ?? parseEnvBool(process.env.CUSTOMER_BOT_ENABLED, true),
    cotApiWritesEnabled: persisted.cotApiWritesEnabled
      ?? parseEnvBool(process.env.COT_API_WRITES_ENABLED, true)
  };
}

/**
 * getRuntimeFlags: Flags efectivos (caché en memoria + persistencia).
 *
 * @returns {{ customerBotEnabled: boolean, cotApiWritesEnabled: boolean }}
 */
export function getRuntimeFlags() {
  if (!cachedFlags) {
    cachedFlags = getDefaultRuntimeFlags();
  }
  return { ...cachedFlags };
}

/**
 * isCustomerBotEnabled: ¿El bot responde a chats que no son consola operador?
 *
 * @returns {boolean}
 */
export function isCustomerBotEnabled() {
  return getRuntimeFlags().customerBotEnabled;
}

/**
 * areCotApiWritesEnabled: ¿Se permiten POST de cotización/venta?
 *
 * @returns {boolean}
 */
export function areCotApiWritesEnabled() {
  return getRuntimeFlags().cotApiWritesEnabled;
}

/**
 * setCustomerBotEnabled: Activa/desactiva respuestas automáticas a clientes.
 *
 * @param {boolean} enabled
 */
export function setCustomerBotEnabled(enabled) {
  const next = { ...getRuntimeFlags(), customerBotEnabled: Boolean(enabled) };
  cachedFlags = next;
  writePersistedOverrides(next);
}

/**
 * setCotApiWritesEnabled: Activa/desactiva escrituras a la API web.
 *
 * @param {boolean} enabled
 */
export function setCotApiWritesEnabled(enabled) {
  const next = { ...getRuntimeFlags(), cotApiWritesEnabled: Boolean(enabled) };
  cachedFlags = next;
  writePersistedOverrides(next);
}

/**
 * formatRuntimeFlagsStatus: Texto corto para el menú operador.
 *
 * @returns {string}
 */
export function formatRuntimeFlagsStatus() {
  const f = getRuntimeFlags();
  const resp = f.customerBotEnabled ? 'ON' : 'OFF';
  const api = f.cotApiWritesEnabled ? 'ON' : 'OFF';
  return `Respuestas clientes: *${resp}* | API cotizaciones/ventas: *${api}*`;
}

/**
 * handleRuntimeToggleCommand: Procesa /respuestas y /cotapi (on|off).
 *
 * @param {string} text - Mensaje completo
 * @returns {string|null} Respuesta al admin o null si no es comando
 */
export function handleRuntimeToggleCommand(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = (parts[1] || '').toLowerCase();

  if (cmd === '/respuestas') {
    if (arg !== 'on' && arg !== 'off') {
      return 'Uso: /respuestas on | /respuestas off';
    }
    setCustomerBotEnabled(arg === 'on');
    return `Respuestas automáticas a clientes: *${arg === 'on' ? 'ON' : 'OFF'}*.`;
  }

  if (cmd === '/cotapi') {
    if (arg !== 'on' && arg !== 'off') {
      return 'Uso: /cotapi on | /cotapi off';
    }
    setCotApiWritesEnabled(arg === 'on');
    return `Escrituras a la API (cotizaciones/ventas): *${arg === 'on' ? 'ON' : 'OFF'}*.`;
  }

  return null;
}

export function resetRuntimeFlagsCache() {
  cachedFlags = null;
}

/**
 * shouldProcessCustomerChat: ¿Debe el engine atender este chat como cliente?
 *
 * @param {{ inOperatorConsole?: boolean }} opts
 * @returns {boolean}
 */
export function shouldProcessCustomerChat(opts = {}) {
  if (opts.inOperatorConsole) return false;
  return isCustomerBotEnabled();
}
