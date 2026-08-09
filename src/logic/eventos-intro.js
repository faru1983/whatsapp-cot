// ==============================================================================
// OBJETIVO: Helpers del intro Eventos — formato primero (Dispensador / Muro).
// Copy fase A (tipo) y B (invitados), menú cotizar/duda y assets.
// Lo usan router, ELECCION_FORMATO, RECOGIDA_DATOS e INTRO_MENU.
// ==============================================================================
import { img, vid } from './media.js';
import { formatPrice, preciosData } from './utils.js';
import { formatMenuBlock, MENU_WRITE_CTA } from './flow-rails.js';
import {
  getEventFormatKey,
  ensureEventOrderBuilder,
  getMinLitersForFormat
} from './eventos-helpers.js';

/** Labels canónicos de sesión. */
export const FORMATO_DISPENSADOR = 'Dispensador Portátil';
export const FORMATO_MURO = 'Muro de Coctelería';

/**
 * Precios de marketing “servicio desde” (pedido mínimo comercial del formato).
 * Dispensador: desde $109.990 · Muro: desde $239.990.
 * No usamos el 5L/mocktail más barato del JSON.
 */
export const EVENT_DISPENSADOR_FROM_PRICE = 109990;
export const EVENT_MURO_FROM_PRICE = 239990;
/** Alias legacy (precio “desde” del Muro). Preferir eventFormatFromPrice(formatKey). */
export const EVENT_SERVICE_FROM_PRICE = EVENT_MURO_FROM_PRICE;

/**
 * eventFormatFromPrice: Precio “servicio desde” del pitch de entrada por formato.
 *
 * @param {'dispensador'|'muro'} [formatKey='dispensador']
 * @returns {number} Precio en pesos
 */
export function eventFormatFromPrice(formatKey = 'dispensador') {
  return formatKey === 'muro' ? EVENT_MURO_FROM_PRICE : EVENT_DISPENSADOR_FROM_PRICE;
}

/** Alias legacy del mismo precio de marketing. */
export function lowestEventFormatPrice(formatKey) {
  return eventFormatFromPrice(formatKey);
}

/**
 * instalacionMuroFormatted: Precio de instalación del muro ya formateado.
 *
 * @returns {string} Ej. "$50.000"
 */
export function instalacionMuroFormatted() {
  return formatPrice(preciosData.instalacion_muro || 50000);
}

/**
 * eventFormatPhaseAMedia: Media de la intro (fase A), sin caption.
 * Dispensador = foto pitch; Muro = video pitch. El copy va en otra burbuja.
 *
 * @param {'dispensador'|'muro'} formatKey
 * @returns {object} Parte img/vid para customReplies
 */
export function eventFormatPhaseAMedia(formatKey) {
  if (formatKey === 'muro') {
    return vid('eventos_muro.mp4');
  }
  return img('eventos_dispensador1.webp');
}

/**
 * eventFormatPhaseBAssetFile: Imagen de la fase B (incluido + invitados).
 *
 * @param {'dispensador'|'muro'} formatKey
 * @returns {string}
 */
export function eventFormatPhaseBAssetFile(formatKey) {
  return formatKey === 'muro'
    ? 'muro_de_cocteleria.webp'
    : 'dispensador_portatil.webp';
}

/**
 * eventFormatAssetFile: Alias de la imagen fase B (compat).
 *
 * @param {'dispensador'|'muro'} formatKey
 * @returns {string}
 */
export function eventFormatAssetFile(formatKey) {
  return eventFormatPhaseBAssetFile(formatKey);
}

/**
 * askCelebrationCopy: Pregunta canónica del tipo de evento.
 *
 * @returns {string}
 */
export function askCelebrationCopy() {
  return `*¿Qué tipo de evento estás organizando?*
_(ej: matrimonio, cumpleaños, empresa, etc.)_`;
}

/**
 * askGuestsCopyCanonical: Pregunta canónica de invitados.
 *
 * @returns {string}
 */
export function askGuestsCopyCanonical() {
  return `*¿Cuántos invitados serán aproximadamente?*
_(ej: 10, 25, 50 personas)_`;
}

/**
 * buildFormatPhaseAText: Caption fase A (intro + tipo de evento).
 *
 * @param {'dispensador'|'muro'} formatKey
 * @returns {string}
 */
export function buildFormatPhaseAText(formatKey) {
  const isMuro = formatKey === 'muro';
  const nombre = isMuro ? 'Muro de Coctelería' : 'Dispensador Portátil';
  const emoji = isMuro ? '🍹' : '🍸';
  const ideal = isMuro
    ? 'Es ideal para matrimonios, empresas y eventos *grandes o masivos*. Tus invitados se sirven cócteles preparados al instante, con una barra premium que se convierte en el punto de atracción.'
    : 'Es ideal para cumpleaños, matrimonios, empresas y eventos de *cualquier tamaño*. Tus invitados pueden servirse cócteles preparados al instante, sin filas y sin bartender.';
  const minL = getMinLitersForFormat(formatKey);
  const desde = formatPrice(eventFormatFromPrice(formatKey));
  const instalacionLine = isMuro
    ? `🔧 Instalación: ${instalacionMuroFormatted()}`
    : `🔧 Instalación: *gratis*`;

  return `${emoji} Te cuento sobre nuestro *${nombre}*.

${ideal}

🍹 Pedido mínimo: *${minL}L* de cócteles
💰 Servicio desde *${desde}*
${instalacionLine}

Para orientarte, ${askCelebrationCopy()}`;
}

/**
 * buildFormatPhaseBText: Texto fase B (incluido + pedir invitados).
 * Integra el ack del tipo con el recordatorio de instalación (sin “Perfecto” + “¡Genial!”).
 *
 * @param {'dispensador'|'muro'} formatKey
 * @param {object} [session] - Para ack del tipo de evento
 * @returns {string}
 */
export function buildFormatPhaseBText(formatKey, session = null) {
  const isMuro = formatKey === 'muro';
  const nombreCorto = isMuro ? 'muro' : 'dispensador';
  // En fase A ya dijimos gratis / costo: aquí solo recordamos, en una sola frase con el ack.
  const installReminder = isMuro
    ? `te recuerdo que la instalación del *${nombreCorto}* tiene un costo de *${instalacionMuroFormatted()}* y solo pagas por los cócteles que elijas.`
    : `te recuerdo que la instalación del *${nombreCorto}* es *gratis* y solo pagas por los cócteles que elijas.`;

  let lead = '';
  if (session?.celebrationType) {
    lead = `Genial, anoté *${session.celebrationType}*: ${installReminder}`;
  } else if (session?.eventosCelebrationSkipped) {
    lead = `Sin problema, el tipo lo dejamos por confirmar. ${installReminder.charAt(0).toUpperCase()}${installReminder.slice(1)}`;
  } else {
    lead = `Genial 🍸 ${installReminder.charAt(0).toUpperCase()}${installReminder.slice(1)}`;
  }

  return `${lead}

✨ Además, todo esto está incluido sin costo adicional:
🧊 Hielo · 🍊 Garnish · 🥂 Vasos/copas · 🧰 Accesorios de bar

⏰ Instalamos horas antes del evento y retiramos como máximo al día siguiente.

${askGuestsCopyCanonical()}`;
}

/**
 * buildFormatPhaseAReplies: Media primero + texto después (2 burbujas, sin caption).
 * Dispensador → eventos_dispensador1.webp; Muro → eventos_muro.mp4.
 *
 * @param {'dispensador'|'muro'|string} formatKeyOrLabel
 * @returns {Array}
 */
export function buildFormatPhaseAReplies(formatKeyOrLabel) {
  const formatKey = (formatKeyOrLabel === 'muro' || formatKeyOrLabel === 'dispensador')
    ? formatKeyOrLabel
    : getEventFormatKey(formatKeyOrLabel);
  return [
    eventFormatPhaseAMedia(formatKey),
    buildFormatPhaseAText(formatKey)
  ];
}

/**
 * buildFormatPhaseBReplies: Imagen primero + texto después (2 burbujas, sin caption).
 * Misma pauta que fase A: media sola, luego el copy.
 *
 * @param {'dispensador'|'muro'|string} formatKeyOrLabel
 * @param {object} [session]
 * @returns {Array}
 */
export function buildFormatPhaseBReplies(formatKeyOrLabel, session = null) {
  const formatKey = (formatKeyOrLabel === 'muro' || formatKeyOrLabel === 'dispensador')
    ? formatKeyOrLabel
    : getEventFormatKey(formatKeyOrLabel);
  return [
    img(eventFormatPhaseBAssetFile(formatKey)),
    buildFormatPhaseBText(formatKey, session)
  ];
}

/**
 * getEventFormatChoiceCaption: Caption de elección Dispensador/Muro (sin invitados).
 * Recomienda por tamaño de evento (pequeño/mediano vs grande/masivo).
 *
 * @returns {string}
 */
export function getEventFormatChoiceCaption() {
  const instalacion = instalacionMuroFormatted();
  const desdeDisp = formatPrice(eventFormatFromPrice('dispensador'));
  const desdeMuro = formatPrice(eventFormatFromPrice('muro'));
  return `En *Servicio para Eventos* puedes elegir el formato que mejor calza con tu celebración:

1️⃣ *Dispensador Portátil* — ideal para eventos de *cualquier tamaño*. Instalación gratis, pedido mín. 10L, desde *${desdeDisp}*

2️⃣ *Muro de Coctelería* — ideal para eventos *grandes o masivos*. Instalación ${instalacion}, pedido mín. 30L, desde *${desdeMuro}*

${MENU_WRITE_CTA}

${formatMenuBlock(['Dispensador', 'Muro'])}`;
}

/**
 * buildEventFormatChoiceReplies: Imagen ambas + menú de elección.
 *
 * @returns {Array}
 */
export function buildEventFormatChoiceReplies() {
  return [img('eventos_ambas.webp', getEventFormatChoiceCaption())];
}

/**
 * eventosIntroMenuBlock: Menú 1️⃣ cotización / 2️⃣ duda.
 *
 * @returns {string}
 */
export function eventosIntroMenuBlock() {
  return formatMenuBlock(['Quiero hacer una cotización', 'Tengo una duda']);
}

/**
 * eventosIntroMenuQuestion: Pregunta + menú post-datos (tipo + invitados).
 *
 * @returns {string}
 */
export function eventosIntroMenuQuestion() {
  return `*Para continuar, ¿qué estás buscando?*

${eventosIntroMenuBlock()}`;
}

/**
 * buildEventosAskDoubtReply: Opción 2️⃣ — pide el texto de la duda (aún no mute).
 *
 * @returns {string}
 */
export function buildEventosAskDoubtReply() {
  return `Perfecto. 😊 Escríbeme tu duda y te respondemos enseguida.`;
}

/**
 * EVENTOS_COTIZAR_SYNONYMS: Equivale a 1️⃣ (hacer cotización).
 */
export const EVENTOS_COTIZAR_SYNONYMS =
  /hacer\s+((una|la)\s+)?cotizaci[oó]n|\bcotizar\b|\bcotizaci[oó]n\b|quiero\s+(cotizar|seguir|continuar)|armar\s+((una|la)\s+)?cotizaci[oó]n|ver\s+(la\s+)?(carta|precios)|opci[oó]n\s*1|^(uno|primera?)$/i;

/**
 * EVENTOS_DUDA_SYNONYMS: Equivale a 2️⃣ (tengo una duda).
 */
export const EVENTOS_DUDA_SYNONYMS =
  /\b(duda|dudas|consulta|consultas|pregunta|preguntas|ayuda)\b|tengo\s+(una\s+)?(duda|consulta|pregunta)|hablar\s+con\s+(un\s+)?humano|opci[oó]n\s*2|^(dos|segunda?)$/i;

/**
 * applyEventFormatToSession: Fija formato + orderBuilder en la sesión.
 *
 * @param {object} session
 * @param {'dispensador'|'muro'} formatKey
 */
export function applyEventFormatToSession(session, formatKey) {
  session.eventoFormato = formatKey === 'muro' ? FORMATO_MURO : FORMATO_DISPENSADOR;
  ensureEventOrderBuilder(session, formatKey);
}

/**
 * enterEventosWithFormat: Resultado de transición listo (router / elección).
 * Fija formato y envía burbujas fase A → RECOGIDA_DATOS.
 *
 * @param {object} session
 * @param {'dispensador'|'muro'} formatKey
 * @returns {object}
 */
export function enterEventosWithFormat(session, formatKey) {
  applyEventFormatToSession(session, formatKey);
  return {
    success: true,
    nextState: 'EVENTOS_RECOGIDA_DATOS',
    customReplies: buildFormatPhaseAReplies(formatKey),
    flowProgress: true
  };
}
