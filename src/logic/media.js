// ==============================================================================
// OBJETIVO: Helper para enviar imágenes/videos en los flujos del bot.
// Los estados usan img('archivo.ext') o vid('archivo.mp4') dentro de customReplies;
// engine e index.js resuelven la ruta en assets/ y envían (o silencian + SOS si falta).
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from '../core/paths.js';

// ==============================================================================
// 1. CONSTRUIR BLOQUES DE MEDIA PARA customReplies
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
 * vid: Arma un objeto video para customReply / customReplies.
 * Igual que img(), pero para mp4 (u otro video) en assets/.
 *
 * Ejemplo:
 *   customReplies: [vid('eventos_muro.mp4', 'Pitch del muro…')]
 *
 * @param {string} fileName - Nombre del archivo en assets/ (ej. "eventos_muro.mp4")
 * @param {string} [caption] - Texto opcional bajo el video en WhatsApp
 * @returns {{ type: 'video', file: string, caption?: string }}
 */
export function vid(fileName, caption) {
  const part = { type: 'video', file: String(fileName || '').trim() };
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
 * isVideoPart: ¿Este ítem de reply es un video?
 *
 * @param {unknown} part
 * @returns {boolean}
 */
export function isVideoPart(part) {
  return Boolean(
    part
    && typeof part === 'object'
    && part.type === 'video'
    && typeof part.file === 'string'
    && part.file.trim() !== ''
  );
}

/**
 * isMediaPart: ¿Es imagen o video (bloque de archivo desde assets/)?
 *
 * @param {unknown} part
 * @returns {boolean}
 */
export function isMediaPart(part) {
  return isImagePart(part) || isVideoPart(part);
}

// ==============================================================================
// 2. RESOLVER RUTA Y COMPROBAR QUE EL ARCHIVO EXISTE
// ==============================================================================

/**
 * resolveImagePath: Une assets/ + nombre de archivo en una ruta absoluta.
 * Sirve igual para fotos y videos (cualquier archivo en assets/).
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
 * Nombre histórico: también valida videos (vid).
 *
 * @param {string} fileName - Nombre del archivo pedido por img()/vid()
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
