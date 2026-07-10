// ==============================================================================
// OBJETIVO: Configuración del Sistema (Variables de Entorno).
// Este archivo centraliza la lectura del archivo .env y expone de forma segura 
// los tokens, API keys y preferencias generales que necesita la aplicación.
// ==============================================================================
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

/**
 * getEnv: Lee y valida qué Inteligencia Artificial vamos a usar y sus credenciales (API Keys).
 * Es una buena práctica no escribir las API Keys directamente en el código para que no se filtren
 * si subes el código a plataformas como GitHub (por seguridad).
 * 
 * @returns {object} Un objeto con la API Key, el modelo de IA seleccionado y el proveedor.
 */
export function getEnv() {
  // Leemos qué proveedor de Inteligencia Artificial se eligió en el archivo .env (por defecto es 'gemini')
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

  // Caso 1: Si configuraste usar Nvidia (para modelos de código abierto como Llama 3)
  if (provider === 'nvidia') {
    const apiKey = process.env.NVIDIA_API_KEY;
    const model = process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
    
    // Si olvidaste poner la clave de Nvidia en el archivo .env, detenemos el bot con un error descriptivo
    if (!apiKey) throw new Error('Falta NVIDIA_API_KEY en el archivo .env');
    
    return { apiKey, model, provider };
  }

  // Caso 2: Si configuraste usar Google Gemini (el valor predeterminado del bot)
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  
  // Si olvidaste poner la clave de Gemini en el archivo .env, detenemos el bot con un error
  if (!apiKey) throw new Error('Falta GEMINI_API_KEY en el archivo .env');
  
  return { apiKey, model, provider };
}

/**
 * parsePositiveInt: Lee un número entero positivo desde .env con valor por defecto.
 * Si el valor es inválido o menor a 1, usa el default (evita romper el bot con typos).
 *
 * @param {string|undefined} value - Texto del .env
 * @param {number} defaultValue - Valor seguro si falta o es inválido
 * @returns {number}
 */
function parsePositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }
  return parsed;
}

/**
 * parseEnvBool: Lee true/false desde .env. Solo "false" (cualquier mayúscula) es falso.
 *
 * @param {string|undefined} value - Texto del .env
 * @param {boolean} defaultValue - Si la variable no existe
 * @returns {boolean}
 */
function parseEnvBool(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  return String(value).toLowerCase() !== 'false';
}

/**
 * resolveLabelConfig: Arma { name, id, markUnread } para una etiqueta Business.
 * Prioriza LABEL_* ; para asistencia también acepta alias legacy SOS_LABEL_*.
 *
 * @param {object} opts
 * @param {string} opts.envNameKey - Ej. LABEL_ASISTENCIA_NAME
 * @param {string} opts.envIdKey - Ej. LABEL_ASISTENCIA_ID
 * @param {string} opts.envMarkKey - Ej. LABEL_ASISTENCIA_MARK_UNREAD
 * @param {string} opts.defaultName
 * @param {string} opts.defaultId
 * @param {boolean} opts.defaultMarkUnread
 * @param {string} [opts.legacyNameKey] - Alias opcional (SOS_LABEL_NAME)
 * @param {string} [opts.legacyIdKey]
 * @param {string} [opts.legacyMarkKey]
 * @returns {{ name: string, id: string, markUnread: boolean }}
 */
function resolveLabelConfig({
  envNameKey,
  envIdKey,
  envMarkKey,
  defaultName,
  defaultId,
  defaultMarkUnread,
  legacyNameKey,
  legacyIdKey,
  legacyMarkKey
}) {
  // Nombre: LABEL_* primero; si vacío, alias SOS_* (solo asistencia); si no, default
  const name = (
    process.env[envNameKey]
    || (legacyNameKey ? process.env[legacyNameKey] : undefined)
    || defaultName
  ).trim() || defaultName;

  const id = (
    process.env[envIdKey]
    || (legacyIdKey ? process.env[legacyIdKey] : undefined)
    || defaultId
  ).trim() || defaultId;

  // Mark unread: si existe LABEL_*_MARK_UNREAD úsalo; si no, alias legacy; si no, default
  let markUnread = defaultMarkUnread;
  if (process.env[envMarkKey] !== undefined && String(process.env[envMarkKey]).trim() !== '') {
    markUnread = parseEnvBool(process.env[envMarkKey], defaultMarkUnread);
  } else if (legacyMarkKey && process.env[legacyMarkKey] !== undefined
    && String(process.env[legacyMarkKey]).trim() !== '') {
    markUnread = parseEnvBool(process.env[legacyMarkKey], defaultMarkUnread);
  }

  return { name, id, markUnread };
}

/**
 * loadBotConfig: Retorna la configuración básica del bot, su comportamiento en chat
 * y la lista de teléfonos de administradores.
 * 
 * @returns {object} Las opciones configuradas para regular el comportamiento del chat.
 */
export function loadBotConfig() {
  // ADMIN_NUMBERS contiene los números de WhatsApp de los dueños/vendedores del negocio.
  // En el archivo .env se escriben separados por comas (ej. 56912345678,56987654321).
  const adminNumbers = process.env.ADMIN_NUMBERS 
    ? process.env.ADMIN_NUMBERS.split(',').map(n => n.trim() + '@s.whatsapp.net') // Les añadimos la terminación de WhatsApp
    : [];

  // Etiquetas Business: IDs estables que el bot crea/asegura (el celular a menudo no sincroniza).
  // Asistencia acepta alias legacy SOS_LABEL_* / SOS_MARK_UNREAD.
  const labels = {
    asistencia: resolveLabelConfig({
      envNameKey: 'LABEL_ASISTENCIA_NAME',
      envIdKey: 'LABEL_ASISTENCIA_ID',
      envMarkKey: 'LABEL_ASISTENCIA_MARK_UNREAD',
      defaultName: 'Asistencia',
      defaultId: '99',
      defaultMarkUnread: true,
      legacyNameKey: 'SOS_LABEL_NAME',
      legacyIdKey: 'SOS_LABEL_ID',
      legacyMarkKey: 'SOS_MARK_UNREAD'
    }),
    cotizacionBarriles: resolveLabelConfig({
      envNameKey: 'LABEL_COTIZACION_BARRILES_NAME',
      envIdKey: 'LABEL_COTIZACION_BARRILES_ID',
      envMarkKey: 'LABEL_COTIZACION_BARRILES_MARK_UNREAD',
      defaultName: 'Cotizacion Barriles',
      defaultId: '98',
      defaultMarkUnread: false
    }),
    cotizacionEventos: resolveLabelConfig({
      envNameKey: 'LABEL_COTIZACION_EVENTOS_NAME',
      envIdKey: 'LABEL_COTIZACION_EVENTOS_ID',
      envMarkKey: 'LABEL_COTIZACION_EVENTOS_MARK_UNREAD',
      defaultName: 'Cotizacion Eventos',
      defaultId: '97',
      defaultMarkUnread: false
    })
  };

  return {
    triggerPrefix: "", // Si escribes por ejemplo "!bot", el bot solo responderá mensajes que empiecen con "!bot". Vacío responde a todo.
    allowGroups: false, // Si es 'false', el bot ignorará los mensajes de chats grupales y solo responderá privados.
    temperature: 0.8, // Regula la creatividad del bot (0.0 es muy robótico/fijo, 1.0 es muy creativo/diverso)
    maxOutputTokens: 400, // Limita el largo de las respuestas del bot para evitar que responda textos gigantescos.
    numeros_notificar: adminNumbers, // Lista de números administradores que recibirán alertas de SOS o conversiones

    // Etiquetas WhatsApp Business (SOS + cierres de cotización). Ver LABEL_* en .env
    labels,

    // Umbrales de la red de seguridad (engine.js). Ver sección SECURITY_* en .env
    security: {
      // Anti-loop: cuántas respuestas "no entendidas" seguidas antes de silenciar y avisar al admin
      maxConsecutiveErrors: parsePositiveInt(process.env.SECURITY_MAX_CONSECUTIVE_ERRORS, 2),
      // Cambio de intención: cuántas veces puede alternar barriles ↔ eventos antes de silenciar
      maxIntentSwitches: parsePositiveInt(process.env.SECURITY_MAX_INTENT_SWITCHES, 2),
    }
  };
}