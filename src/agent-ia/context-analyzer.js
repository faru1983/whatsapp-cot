// ==============================================================================
// OBJETIVO: Analizador de Contexto de Conversación y Anuncios Meta CTWA.
// Interpreta mensajes previos de WhatsApp Business (icebreakers, auto-replies),
// señales de anuncios y extrae pistas de intención del cliente.
// ==============================================================================

import { parseGuestsFromText } from '../logic/operator-draft.js';
import { parseCelebrationType } from '../logic/eventos-helpers.js';

/**
 * analyzeMessageContext: Analiza el contexto de la conversación.
 * 
 * @param {object} session - Sesión SQLite del cliente
 * @param {string} currentText - Texto que acaba de enviar el cliente
 * @returns {object} Contexto enriquecido
 */
export function analyzeMessageContext(session, currentText) {
  const turns = session?.history?.turns || [];
  const text = String(currentText || '').trim();

  // 1. Detectar si viene de anuncio Meta
  const isFromMetaAd = Boolean(
    session?.metaFromCtwa ||
    session?.metaCtwaClid ||
    session?.metaAdSourceId
  );

  // 2. Extraer si el último mensaje previo del asistente preguntaba por invitados
  let waitingForGuests = false;
  let waitingForDrinksPerPerson = false;
  let waitingForFlavors = false;

  const lastBotTurn = [...turns].reverse().find((t) => t.role === 'model');
  if (lastBotTurn) {
    const botText = lastBotTurn.text.toLowerCase();
    if (botText.includes('cuántos invitados') || botText.includes('cuantos invitados') || botText.includes('invitados aprox') || botText.includes('tendrás en tu evento')) {
      waitingForGuests = true;
    } else if (botText.includes('cócteles por persona') || botText.includes('tragos por persona')) {
      waitingForDrinksPerPerson = true;
    } else if (botText.includes('favoritos') || botText.includes('qué cócteles') || botText.includes('sabores')) {
      waitingForFlavors = true;
    }
  }

  // 3. Extracción de señales en el mensaje del cliente
  const isTragosOnly = /\b(?:tragos?|c[oó]cteles?|copas?|p\/p|por persona|pp)\b/i.test(text);
  const detectedGuests = (isTragosOnly || waitingForDrinksPerPerson || (session?.guests && !waitingForGuests))
    ? null
    : parseGuestsFromText(text);
  const detectedCelebration = parseCelebrationType(text);

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

  // Detección de intención directa vs eventos
  const isDirectBarrelQuery = /\b(desechable|barril(?:es)? de 5\s*l|5\s*l|para la casa|para mi casa|asado)\b/i.test(text);

  return {
    isFromMetaAd,
    waitingForGuests,
    waitingForDrinksPerPerson,
    waitingForFlavors,
    detectedGuests,
    detectedCelebration,
    detectedDrinksPerPerson,
    isDirectBarrelQuery
  };
}
