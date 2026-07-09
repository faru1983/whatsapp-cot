// ==============================================================================
// OBJETIVO: Rutas absolutas del proyecto (independientes del cwd de PM2).
// process.cwd() cambia según desde dónde arranques el bot; import.meta.url
// siempre apunta a este archivo, así auth/, SQLite y db/*.json quedan fijos.
// ==============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Este archivo vive en src/core/ → subimos dos niveles hasta la raíz del repo
const thisDir = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(thisDir, '../..');

/** Carpeta de sesión WhatsApp (creds + keys de Baileys) */
export const AUTH_DIR = path.join(PROJECT_ROOT, 'auth');

/** Base SQLite de conversaciones */
export const SQLITE_PATH = path.join(PROJECT_ROOT, 'conversation-memory.sqlite');

/** Precios y catálogo */
export const DATOS_JSON_PATH = path.join(PROJECT_ROOT, 'db', 'datos.json');

/** Preguntas frecuentes */
export const FAQ_JSON_PATH = path.join(PROJECT_ROOT, 'db', 'faq.json');
