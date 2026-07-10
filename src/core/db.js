// ==============================================================================
// OBJETIVO: Memoria Local a Corto Plazo (Base de Datos SQLite).
// Aquí se guarda y recupera todo el historial de la conversación de cada cliente, 
// asegurando que la IA siempre tenga el contexto del chat aunque el servidor se reinicie.
// ==============================================================================
import Database from 'better-sqlite3'; // better-sqlite3 es la librería que maneja la base de datos local SQLite.
import { SQLITE_PATH } from './paths.js';

// Ruta fija a la raíz del repo (no depende de process.cwd() / PM2).
const dbPath = SQLITE_PATH;

// Abrimos (o creamos, si no existe) el archivo de base de datos SQLite.
const db = new Database(dbPath);

// Activamos el modo WAL (Write-Ahead Logging).
// En términos simples: guarda los cambios en un archivo de bitácora antes de escribirlos en la base de datos principal.
// Esto hace que la base de datos sea mucho más rápida y evita que la información se corrompa (rompa) si el servidor se apaga de golpe.
db.pragma('journal_mode = WAL');

// Creamos la tabla principal "sessions" si es la primera vez que se ejecuta el programa.
// - "id": es la clave primaria (PRIMARY KEY), que corresponde al número de teléfono del cliente de WhatsApp (único).
// - "data": es un bloque de texto que guarda todo el historial y variables de esa conversación en formato JSON (como un archivador).
db.prepare('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT)').run();

/**
 * createSession: Genera una estructura de datos vacía y limpia para clientes nuevos.
 * Arranca en ESPERANDO_INTENCION para que el debug/CLI no muestre "(sin estado)".
 *
 * @returns {object} Una sesión vacía inicializada.
 */
function createSession() {
  return {
    history: { turns: [] }, // Aquí se guardará la conversación de WhatsApp en formato [{role, text}]
    currentState: 'ESPERANDO_INTENCION', // Primer paso del embudo (barriles vs eventos)
    errores_paso: 0, // Contador de errores en el paso actual
    silenciado_timestamp: null, // Marca de tiempo (milisegundos) de cuándo se silenciò al bot
    isMuted: false // Si es 'true', el bot no responde automáticamente en este chat
  };
}

/**
 * migrateSession: Función de seguridad encargada de adaptar sesiones antiguas
 * si es que actualizas la versión de tu bot.
 * Evita que el bot falle por leer datos estructurados en formatos antiguos.
 * 
 * @param {object} session - Los datos del cliente leídos desde la base de datos.
 * @returns {object} Los datos del cliente adaptados al formato más reciente.
 */
function migrateSession(session) {
  // Migración de formato de historial de chat antiguo (user: [], bot: []) a formato moderno (turns: [{role, text}])
  if (session.history && !session.history.turns) {
    const turns = [];
    const userMsgs = session.history.user || [];
    const botMsgs = session.history.bot || [];
    const len = Math.min(userMsgs.length, botMsgs.length);
    for (let i = 0; i < len; i++) {
      if (userMsgs[i]) turns.push({ role: 'user', text: userMsgs[i] });
      if (botMsgs[i]) turns.push({ role: 'model', text: botMsgs[i] });
    }
    session.history = { turns };
  }
  
  // Rellenamos variables que falten con valores por defecto para evitar errores de tipo "undefined" (indefinido)
  if (!session.history) session.history = { turns: [] };
  if (!session.history.turns) session.history.turns = [];
  if (!session.currentState) session.currentState = 'ESPERANDO_INTENCION';
  if (session.errores_paso === undefined) session.errores_paso = 0;
  if (session.silenciado_timestamp === undefined) session.silenciado_timestamp = null;
  if (session.isMuted === undefined) session.isMuted = false;

  return session;
}

/**
 * getSession: Carga la sesión/historial de un cliente desde la base de datos SQLite.
 * Si el cliente es nuevo, crea una sesión limpia automáticamente.
 * 
 * @param {string} sessionId - Número de WhatsApp del cliente
 * @returns {object} Los datos estructurados de la conversación de este cliente.
 */
export function getSession(sessionId) {
  // Buscamos en la base de datos una fila con la ID del cliente
  const row = db.prepare('SELECT data FROM sessions WHERE id = ?').get(sessionId);
  if (row) {
    try {
      // Intentamos leer el texto guardado en SQLite y transformarlo en un objeto de JavaScript
      const parsed = JSON.parse(row.data);
      return migrateSession(parsed); // Validamos que el formato sea el correcto antes de devolverlo
    } catch {
      // Si la información estaba corrupta o rota en el archivo, reseteamos la sesión para ese cliente
      return createSession();
    }
  }
  // Si no se encontró ningún dato del cliente, significa que es la primera vez que habla
  return createSession();
}

/**
 * saveSession: Guarda los cambios de una conversación en el disco duro.
 * Convierte el objeto de datos a formato de texto JSON para escribirlo en SQLite.
 * 
 * @param {string} sessionId - Número de WhatsApp del cliente
 * @param {object} session - Datos de la conversación
 */
export function saveSession(sessionId, session) {
  const data = JSON.stringify(session);
  // INSERT OR REPLACE: Si el cliente ya existe en SQLite, sobrescribe sus datos. Si es nuevo, lo crea.
  db.prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)').run(sessionId, data);
}

/**
 * resetSession: Borra todo el historial de chat y datos guardados de un cliente.
 * Se usa para pruebas locales o si el cliente solicita reiniciar el flujo de compra.
 * 
 * @param {string} sessionId - Número de WhatsApp del cliente
 */
export function resetSession(sessionId = 'default') {
  saveSession(sessionId, createSession());
}

/**
 * listSessionIds: Lista todos los IDs de sesión guardados en SQLite.
 * Sirve para comandos admin que deben actuar sobre PN y también sobre @lid.
 *
 * @returns {string[]} IDs de sesión (JIDs)
 */
export function listSessionIds() {
  const rows = db.prepare('SELECT id FROM sessions').all();
  return rows.map((row) => row.id);
}

/**
 * findSessionIdsForPhone: Busca sesiones cuyo ID contenga el número de teléfono.
 * WhatsApp a veces guarda el chat como 569...@s.whatsapp.net y otras como ...@lid;
 * el comando admin usa el número público, así que buscamos coincidencias.
 *
 * @param {string} phoneDigits - Solo dígitos (ej. "56929672978")
 * @returns {string[]} IDs de sesión que coinciden
 */
export function findSessionIdsForPhone(phoneDigits) {
  const digits = String(phoneDigits || '').replace(/\D/g, '');
  if (!digits) return [];
  return listSessionIds().filter((id) => {
    const idDigits = String(id).replace(/\D/g, '');
    // Coincidencia exacta de dígitos del usuario (sin device) o el número aparece en el id PN
    return id === `${digits}@s.whatsapp.net` || id.startsWith(`${digits}@`) || idDigits === digits;
  });
}
