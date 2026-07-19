// ==============================================================================
// OBJETIVO: Helper para enviar imágenes en los flujos del bot.
// Los estados usan img('archivo.ext') dentro de customReplies; engine e index.js
// resuelven la ruta en assets/ y envían (o silencian + SOS si el archivo no existe).
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from '../core/paths.js';

// ==============================================================================
// 1. CONSTRUIR UN BLOQUE DE IMAGEN PARA customReplies
// ==============================================================================

/**
 * img: Arma un objeto imagen para customReply / customReplies.
 * En el flujo solo escribes el nombre del archivo (con extensión) y, si quieres, un caption.
 *
 * Ejemplo:
 *   customReplies: [img('barril_desechable_precios.webp'), '¿Cotizamos?']
 *
 * @param {string} fileName - Nombre completo del archivo dentro de assets/ (ej. "foto.webp")
 * @param {string} [caption] - Texto opcional pegado a la foto en WhatsApp
 * @returns {{ type: 'image', file: string, caption?: string }}
 */
export function img(fileName, caption) {
  const part = { type: 'image', file: String(fileName || '').trim() };
  // Solo agregamos caption si el flujo lo pasó (imagen sola = sin texto)
  if (caption != null && String(caption).trim() !== '') {
    part.caption = String(caption).trim();
  }
  return part;
}

/**
 * isImagePart: ¿Este ítem de reply es una imagen (no un string de texto)?
 *
 * @param {unknown} part - Elemento de customReplies o customReply
 * @returns {boolean}
 */
export function isImagePart(part) {
  return Boolean(
    part
    && typeof part === 'object'
    && part.type === 'image'
    && typeof part.file === 'string'
    && part.file.trim() !== ''
  );
}

/**
 * album: Arma un objeto álbum para agrupar múltiples imágenes.
 *
 * Ejemplo:
 *   customReplies: [album(['foto1.webp', 'foto2.webp', 'foto3.webp'])]
 *
 * @param {string[]} fileNames - Nombres de los archivos
 * @returns {{ type: 'album', files: string[] }}
 */
export function album(fileNames) {
  return { 
    type: 'album', 
    files: (Array.isArray(fileNames) ? fileNames : []).map(f => String(f).trim()).filter(Boolean) 
  };
}

/**
 * isAlbumPart: ¿Este ítem de reply es un álbum?
 *
 * @param {unknown} part
 * @returns {boolean}
 */
export function isAlbumPart(part) {
  return Boolean(
    part
    && typeof part === 'object'
    && part.type === 'album'
    && Array.isArray(part.files)
    && part.files.length > 0
  );
}

// ==============================================================================
// 2. RESOLVER RUTA Y COMPROBAR QUE EL ARCHIVO EXISTE
// ==============================================================================

/**
 * resolveImagePath: Une assets/ + nombre de archivo en una ruta absoluta.
 * Así el bot encuentra la foto aunque PM2 arranque desde otra carpeta.
 *
 * @param {string} fileName - Nombre del archivo (ej. "barril_desechable_precios.webp")
 * @returns {string} Ruta absoluta esperada
 */
export function resolveImagePath(fileName) {
  // path.basename evita que alguien pase "../algo" y salga de assets/
  const safeName = path.basename(String(fileName || '').trim());
  return path.join(ASSETS_DIR, safeName);
}

/**
 * assertImageExists: Comprueba si el archivo está en assets/.
 * Si no está, el engine silencia el chat y avisa al admin (SOS).
 *
 * @param {string} fileName - Nombre del archivo pedido por img()
 * @returns {{ ok: true, absolutePath: string } | { ok: false, expectedPath: string }}
 */
export function assertImageExists(fileName) {
  const absolutePath = resolveImagePath(fileName);
  // Ruta relativa al proyecto para el mensaje SOS (más legible que la absoluta)
  const expectedPath = path.join('assets', path.basename(absolutePath)).replace(/\\/g, '/');

  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    return { ok: true, absolutePath };
  }
  return { ok: false, expectedPath };
}
