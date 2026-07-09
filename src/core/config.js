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

  return {
    triggerPrefix: "", // Si escribes por ejemplo "!bot", el bot solo responderá mensajes que empiecen con "!bot". Vacío responde a todo.
    allowGroups: false, // Si es 'false', el bot ignorará los mensajes de chats grupales y solo responderá privados.
    temperature: 0.8, // Regula la creatividad del bot (0.0 es muy robótico/fijo, 1.0 es muy creativo/diverso)
    maxOutputTokens: 400, // Limita el largo de las respuestas del bot para evitar que responda textos gigantescos.
    numeros_notificar: adminNumbers, // Lista de números administradores que recibirán alertas de SOS o conversiones

    // Pausa entre mensajes seguidos (customReplies). Evita bloqueos de WhatsApp Web por envío demasiado rápido.
    messageSendDelayMs: parsePositiveInt(process.env.MESSAGE_SEND_DELAY_MS, 1500),

    // Umbrales de la red de seguridad (engine.js). Ver sección SECURITY_* en .env
    security: {
      // Anti-loop: cuántas respuestas "no entendidas" seguidas antes de silenciar y avisar al admin
      maxConsecutiveErrors: parsePositiveInt(process.env.SECURITY_MAX_CONSECUTIVE_ERRORS, 2),
      // Cambio de intención: cuántas veces puede alternar barriles ↔ eventos antes de silenciar
      maxIntentSwitches: parsePositiveInt(process.env.SECURITY_MAX_INTENT_SWITCHES, 2),
    }
  };
}