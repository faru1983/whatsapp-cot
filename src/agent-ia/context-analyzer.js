// ==============================================================================
// OBJETIVO: Analizador de Contexto de Conversación y Anuncios Meta CTWA.
// Interpreta mensajes previos de WhatsApp Business (icebreakers, auto-replies),
// señales de anuncios y extrae pistas de intención del cliente.
// ==============================================================================

import { parseGuestsFromText } from '../logic/operator-draft.js';
import { parseCelebrationType } from '../logic/eventos-helpers.js';
import { parseDate, findLocationByFuzzyMatch } from '../logic/utils.js';

/**
 * analyzeMessageContext: Analiza el contexto de la conversación leyendo todo el chat
 * para extraer invitados, fecha, comuna, tragos por persona y estado del flujo.
 * 
 * @param {object} session - Sesión SQLite del cliente
 * @param {string} currentText - Texto que acaba de enviar el cliente
 * @returns {object} Contexto enriquecido
 */
export function analyzeMessageContext(session, currentText) {
  const turns = session?.history?.turns || [];
  const text = String(currentText || '').trim();

  // Historial de mensajes enviados por el cliente
  const userTurns = turns.filter((t) => t.role === 'user').map((t) => t.text);
  const allUserTexts = [...userTurns, text].filter(Boolean);

  // 1. Detectar si viene de anuncio Meta
  const isFromMetaAd = Boolean(
    session?.metaFromCtwa ||
    session?.metaCtwaClid ||
    session?.metaAdSourceId
  );

  // 2. Extraer qué estaba esperando el asistente en su último mensaje
  let waitingForGuests = false;
  let waitingForDrinksPerPerson = false;
  let waitingForFlavors = false;

  const lastBotTurn = [...turns].reverse().find((t) => t.role === 'model');
  if (lastBotTurn) {
    const botText = lastBotTurn.text.toLowerCase();
    if (botText.includes('invitados') || botText.includes('personas') || botText.includes('cuántos') || botText.includes('cuantos') || botText.includes('gente') || botText.includes('calcularlo')) {
      waitingForGuests = true;
    } else if (botText.includes('tragos') || botText.includes('cócteles') || botText.includes('cocteles') || botText.includes('copas') || botText.includes('p/p') || botText.includes('por persona')) {
      waitingForDrinksPerPerson = true;
    } else if (botText.includes('variedades') || botText.includes('fecha') || botText.includes('sabores') || botText.includes('favoritos') || botText.includes('carta') || botText.includes('propuesta') || botText.includes('acomoda')) {
      waitingForFlavors = true;
    }
  }

  // 3. Extracción de señales en el mensaje actual y memoria del chat
  const isTragosOnly = /\b(?:tragos?|c[oó]cteles?|copas?|p\/p|por persona|pp)\b/i.test(text);

  // Extracción de invitados: busca en mensaje actual o en turnos previos del cliente
  const explicitGuestMention = /\b(?:personas?|invitados?|adultos?|amigos?|pax|pers\.?)\b/i.test(text);
  const guestCandidate = parseGuestsFromText(text);
  const isLargeNumber = Boolean(guestCandidate && guestCandidate >= 10);

  let detectedGuests = (isTragosOnly || (waitingForDrinksPerPerson && !explicitGuestMention && !isLargeNumber))
    ? null
    : guestCandidate;

  if (!detectedGuests && !session?.guests) {
    for (const pastMsg of [...userTurns].reverse()) {
      const g = parseGuestsFromText(pastMsg);
      if (g) {
        detectedGuests = g;
        break;
      }
    }
  }

  const isApproxClarification = /^(?:aprox|aproximadamente|m[aá]s\s+o\s+menos)$/i.test(text);

  // Extracción de fecha tentativa: busca en mensaje actual o en turnos previos
  let detectedDate = parseDate(text);
  if (!detectedDate && !session?.eventDate) {
    for (const pastMsg of [...userTurns].reverse()) {
      const d = parseDate(pastMsg);
      if (d) {
        detectedDate = d;
        break;
      }
    }
  }

  // Extracción de comuna o ciudad: busca en mensaje actual o en turnos previos
  let detectedCommune = findLocationByFuzzyMatch(text)?.name || null;
  if (!detectedCommune && !session?.commune) {
    for (const pastMsg of [...userTurns].reverse()) {
      const loc = findLocationByFuzzyMatch(pastMsg)?.name;
      if (loc) {
        detectedCommune = loc;
        break;
      }
    }
  }

  const detectedCelebration = parseCelebrationType(text) || (session?.celebrationType ? null : parseCelebrationType(allUserTexts.join(' ')));

  // Detección de tragos por persona (ej: "2", "3", "3 tragos", "3 trago por persona", "dos", "tres")
  let detectedDrinksPerPerson = null;
  const wordMap = { uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
  const pMatch = text.match(/\b([1-6]|uno|dos|tres|cuatro|cinco|seis)\s*(?:c[oó]cteles?|tragos?|copas?|por persona|p\/p|pp)?\b/i);
  if (pMatch && (!detectedGuests || session?.guests || isTragosOnly || waitingForDrinksPerPerson)) {
    const rawNum = pMatch[1].toLowerCase();
    const num = wordMap[rawNum] || parseInt(rawNum, 10);
    if (num >= 1 && num <= 6) {
      detectedDrinksPerPerson = num;
    }
  }

  // Detección de preguntas típicas de anuncios Meta Ads (icebreakers)
  const isPriceInquiry = /cu[aá]nto\s+cuesta(\s+el\s+servicio)?|cu[aá]les\s+son\s+los\s+(valores|precios)|precios?\b|valor(es)?\b/i.test(text);
  const isHowItWorksInquiry = /c[oó]mo\s+funciona(\s+el\s+servicio)?/i.test(text);

  // Detección de intención directa vs eventos
  const isDirectBarrelQuery = /\b(desechable|barril(?:es)? de 5\s*l|5\s*l|para la casa|para mi casa|asado)\b/i.test(text);

  return {
    isFromMetaAd,
    isPriceInquiry,
    isHowItWorksInquiry,
    waitingForGuests,
    waitingForDrinksPerPerson,
    waitingForFlavors,
    detectedGuests,
    detectedDate,
    detectedCommune,
    detectedCelebration,
    detectedDrinksPerPerson,
    isDirectBarrelQuery,
    isApproxClarification
  };
}

/**
 * isPaymentConfirmationText: Detecta si el mensaje entrante es una confirmación de pago,
 * comprobante de transferencia bancaria o aviso de compra realizada (ej: barril desechable).
 *
 * @param {string} rawText - Texto o descripción del mensaje recibido
 * @returns {boolean} true si corresponde a un comprobante o confirmación de pago
 */
export function isPaymentConfirmationText(rawText) {
  const original = String(rawText || '').trim();
  if (!original) return false;

  // Si es un adjunto multimedia (imagen o documento de comprobante)
  if (original.includes('[comprobante') || original.includes('[adjunto') || original.includes('imagen adjunta') || original.includes('documento adjunto')) {
    return true;
  }

  // Normalizar a minúsculas y sin acentos para regex con límites de palabra ASCII (\b) seguros
  const text = original
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Descartar consultas de datos de pago o preguntas de cómo pagar
  const isQuestion = original.includes('?') || original.includes('¿');
  if (isQuestion && /\b(como|cuales|aceptan|se puede|puedo|donde|cuando|cuanto|tienen)\b/i.test(text)) {
    return false;
  }
  if (/\b(datos|cuenta|datos de transferencia|datos para transferir)\b/i.test(text) && !/\b(ya|listo|adjunto|hice|mande|envie|aqui)\b/i.test(text)) {
    return false;
  }

  // 1. Mención explícita de comprobante
  if (/\bcomprobantes?\b/i.test(text)) {
    return true;
  }

  // 2. Verbos de pago en pasado / acción realizada
  if (/\b(?:ya\s+pague|acabo\s+de\s+pagar|pago\s+realizado|pago\s+listo|listo\s+el\s+pago|pagado|pagada|pague\s+el\s+barril|pague\s+mi\s+barril|pague\s+por\s+la\s+web|pago\s+del\s+barril|pago\s+de\s+mi\s+barril|pago\s+de\s+la\s+compra|pago\s+confirmado|pague)\b/i.test(text)) {
    return true;
  }

  // 3. Verbos de transferencia en pasado / acción realizada
  if (/\b(?:ya\s+transferi|acabo\s+de\s+transferir|transferi|hice\s+la\s+transferencia|transferencia\s+realizada|transferencia\s+lista|te\s+transferi|te\s+hice\s+la\s+transferencia|envio\s+la\s+transferencia|mande\s+la\s+transferencia)\b/i.test(text)) {
    return true;
  }

  // 4. Depósito realizado
  if (/\b(?:ya\s+deposite|deposito\s+realizado|hice\s+el\s+deposito|deposite)\b/i.test(text)) {
    return true;
  }

  return false;
}

