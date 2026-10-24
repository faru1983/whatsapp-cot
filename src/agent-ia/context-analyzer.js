// ==============================================================================
// OBJETIVO: Analizador de Contexto de Conversación y Anuncios Meta CTWA.
// Interpreta mensajes previos de WhatsApp Business (icebreakers, auto-replies),
// señales de anuncios y extrae pistas de intención del cliente.
// ==============================================================================

import { parseGuestsFromText } from '../logic/operator-draft.js';
import { parseCelebrationType } from '../logic/eventos-helpers.js';
import { parseDate, findLocationByFuzzyMatch, preciosData } from '../logic/utils.js';

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
  const locMatch = findLocationByFuzzyMatch(text);
  let detectedCommune = locMatch?.name || null;
  let detectedOutOfRM = false;
  let outOfRMLabel = null;

  if (locMatch && locMatch.isRM === false) {
    detectedOutOfRM = true;
    outOfRMLabel = locMatch.name;
  } else {
    // Regex para menciones explícitas de regiones o ciudades fuera de RM
    const regionRegex = /\b(?:vi[nñ]a(\s+del\s+mar)?|valpara[ií]so|rancagua|machal[ií]|la\s+serena|coquimbo|concepci[oó]n|temuco|antofagasta|iquique|talca|chill[aá]n|puerto\s+montt|v\s+regi[oó]n|iv\s+regi[oó]n|viii\s+regi[oó]n|de\s+regi[oó]n|otra\s+regi[oó]n)\b/i;
    const rMatch = text.match(regionRegex);
    if (rMatch) {
      detectedOutOfRM = true;
      outOfRMLabel = rMatch[0];
    }
  }

  let rawSector = null;
  if (/las\s+vizcachas|vizcachas/i.test(text)) rawSector = 'Las Vizcachas';
  else if (/chicureo/i.test(text)) rawSector = 'Chicureo';
  else if (/chamiseros/i.test(text)) rawSector = 'Chamiseros';
  else if (/piedra\s+roja/i.test(text)) rawSector = 'Piedra Roja';
  else if (/\bnos\b/i.test(text)) rawSector = 'Nos';

  if (!detectedCommune && !session?.commune) {
    for (const pastMsg of [...userTurns].reverse()) {
      const pastLoc = findLocationByFuzzyMatch(pastMsg);
      if (pastLoc?.name) {
        detectedCommune = pastLoc.name;
        if (pastLoc.isRM === false) {
          detectedOutOfRM = true;
          outOfRMLabel = pastLoc.name;
        }
        break;
      }
    }
  }

  const detectedCelebration = parseCelebrationType(text) || (session?.celebrationType ? null : parseCelebrationType(allUserTexts.join(' ')));

  // Detección de tragos por persona (ej: "2", "3", "2 o 3", "2 a 3", "entre 2 y 3", "3 tragos", "dos", "tres")
  let detectedDrinksPerPerson = null;
  const wordMap = { uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };

  // 1. Rango explícito: "2 o 3", "2 a 3", "2-3", "entre 2 y 3" -> tomar el valor superior recomendado (3)
  const rangeMatch = text.match(/\b(?:entre\s+)?([1-6]|uno|dos|tres|cuatro|cinco|seis)\s*(?:o|a|-|\/)\s*([1-6]|uno|dos|tres|cuatro|cinco|seis)\b/i);
  if (rangeMatch && (!detectedGuests || session?.guests || isTragosOnly || waitingForDrinksPerPerson)) {
    const rawNum2 = rangeMatch[2].toLowerCase();
    const num2 = wordMap[rawNum2] || parseInt(rawNum2, 10);
    if (num2 >= 1 && num2 <= 6) {
      detectedDrinksPerPerson = num2;
    }
  } else {
    // 2. Valor individual: "2", "3", "3 tragos", "dos", etc.
    const pMatch = text.match(/\b([1-6]|uno|dos|tres|cuatro|cinco|seis)\s*(?:c[oó]cteles?|tragos?|copas?|por persona|p\/p|pp)?\b/i);
    if (pMatch && (!detectedGuests || session?.guests || isTragosOnly || waitingForDrinksPerPerson)) {
      const rawNum = pMatch[1].toLowerCase();
      const num = wordMap[rawNum] || parseInt(rawNum, 10);
      if (num >= 1 && num <= 6) {
        detectedDrinksPerPerson = num;
      }
    }
  }

  // Detección de selección de cócteles o pedido de sugerencia
  const detectedCocktails = extractRequestedCocktails(text, session);

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
    detectedSector: rawSector,
    detectedCelebration,
    detectedDrinksPerPerson,
    detectedCocktails,
    isDirectBarrelQuery,
    isApproxClarification,
    detectedOutOfRM,
    outOfRMLabel
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

/**
 * extractRequestedCocktails: Extrae cócteles, litrajes o peticiones de recomendación/sugerida
 * directamente desde el texto del cliente contra el catálogo oficial.
 *
 * @param {string} text - Mensaje del cliente
 * @param {object} session - Sesión actual
 * @returns {object|null} { isSuggested, items: [{ flavor, liters }], totalLiters, unrecognizedFlavors }
 */
export function extractRequestedCocktails(text, session = {}) {
  if (!text) return null;
  const raw = String(text).trim();

  // 1. Detección de solicitud de sugerencia / recomendación / los más populares
  const wantsSuggested = /\b(sugerid[ao]|sugerencia|recomiend[ao]|recomi[eé]ndame|populares|m[aá]s\s+pedidos|los\s+mejores|qu[eé]\s+me\s+recomiendas)\b/i.test(raw);

  const guests = session?.guests || 20;
  const drinks = session?.drinksPerGuest || 3;
  const calcLiters = Math.max(10, Math.ceil((guests * drinks * 0.2) / 5) * 5);
  const targetLiters = Math.max(10, session?.lastTotalLiters || session?.cartLiters || calcLiters);

  if (wantsSuggested) {
    if (targetLiters <= 10) {
      return {
        isSuggested: true,
        items: [
          { flavor: 'Mojito Tradicional', liters: 10 }
        ],
        totalLiters: 10,
        unrecognizedFlavors: []
      };
    } else if (targetLiters <= 15) {
      return {
        isSuggested: true,
        items: [
          { flavor: 'Mojito Tradicional', liters: 10 },
          { flavor: 'Sangría', liters: 5 }
        ],
        totalLiters: 15,
        unrecognizedFlavors: []
      };
    } else if (targetLiters <= 20) {
      return {
        isSuggested: true,
        items: [
          { flavor: 'Mojito Tradicional', liters: 10 },
          { flavor: 'Aperol Spritz', liters: 10 }
        ],
        totalLiters: 20,
        unrecognizedFlavors: []
      };
    } else if (targetLiters <= 25) {
      return {
        isSuggested: true,
        items: [
          { flavor: 'Mojito Tradicional', liters: 10 },
          { flavor: 'Aperol Spritz', liters: 10 },
          { flavor: 'Sangría', liters: 5 }
        ],
        totalLiters: 25,
        unrecognizedFlavors: []
      };
    } else {
      const mitad = Math.round(targetLiters / 20) * 10;
      const resto = targetLiters - mitad;
      return {
        isSuggested: true,
        items: [
          { flavor: 'Mojito Tradicional', liters: mitad },
          { flavor: 'Aperol Spritz', liters: resto }
        ],
        totalLiters: targetLiters,
        unrecognizedFlavors: []
      };
    }
  }

  // 2. Extracción de cócteles específicos del texto
  const recognizedNames = [];
  const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const flavorMappings = [
    { regex: /\b(mojito\s+maracuya|mojito\s+de\s+maracuya)\b/i, official: 'Mojito Maracuyá' },
    { regex: /\b(mojito\s+frambuesa|mojito\s+de\s+frambuesa)\b/i, official: 'Mojito Frambuesa' },
    { regex: /\b(mojito\s+mango|mojito\s+de\s+mango)\b/i, official: 'Mojito Mango' },
    { regex: /\b(mojito\s+tradicional|mojito\s+clasico|mojito)\b/i, official: 'Mojito Tradicional' },
    { regex: /\b(aperol\s+spritz|aperol)\b/i, official: 'Aperol Spritz' },
    { regex: /\b(ramazzotti\s+spritz|ramazzotti)\b/i, official: 'Ramazzotti Spritz' },
    { regex: /\b(pisco\s+sour\s+clasico|pisco\s+sour|sour)\b/i, official: 'Pisco Sour Clásico' },
    { regex: /\b(moscow\s+mule|mule)\b/i, official: 'Moscow Mule' },
    { regex: /\b(tropical\s+gin)\b/i, official: 'Tropical Gin' },
    { regex: /\b(gin\s+tonic|gin\s*&\s*tonic|gin)\b/i, official: 'Gin & Tonic' },
    { regex: /\b(sangria|sangr[ií]a)\b/i, official: 'Sangría' },
    { regex: /\b(tequila\s+margarita|margarita)\b/i, official: 'Tequila Margarita' },
    { regex: /\b(caipiri[nñ]a|caipirinha)\b/i, official: 'Caipiriña' },
    { regex: /\b(piscola|piscolas)\b/i, official: 'Piscola Mistral 35°' },
    { regex: /\b(whiskcola|whiscola)\b/i, official: 'Whiskcola J.W. Black' }
  ];

  for (const fm of flavorMappings) {
    if (fm.regex.test(raw)) {
      if (!recognizedNames.includes(fm.official)) {
        recognizedNames.push(fm.official);
      }
    }
  }

  // Detectar si mencionó sabores no existentes en la carta
  const unrecognized = [];
  const fakeFlavors = [
    'pina colada', 'piña colada', 'colada', 'fernet', 'daiquiri',
    'cosmopolitan', 'manhattan', 'negroni', 'bellini', 'bloody mary'
  ];
  for (const fake of fakeFlavors) {
    if (new RegExp(`\\b${fake}\\b`, 'i').test(lower)) {
      unrecognized.push(fake);
    }
  }

  if (recognizedNames.length === 0 && unrecognized.length === 0) {
    return null;
  }

  // Buscar litrajes explícitos para los nombres reconocidos
  const items = [];
  let allocatedTotal = 0;

  for (const name of recognizedNames) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const litMatch = raw.match(new RegExp(`(\\d+)\\s*(?:l|lt|lts|litros?)[^\\w]+${escName}`, 'i'))
      || raw.match(new RegExp(`${escName}[^\\d\\w]*(\\d+)\\s*(?:l|lt|lts|litros?)`, 'i'))
      || raw.match(new RegExp(`(\\d+)\\s*(?:de\\s+)?${escName}`, 'i'));

    let liters = null;
    if (litMatch) {
      const parsedL = parseInt(litMatch[1], 10);
      if (parsedL >= 5 && parsedL <= 100) {
        liters = parsedL;
      }
    }
    items.push({ flavor: name, liters });
    if (liters) allocatedTotal += liters;
  }

  // Si los ítems no traían litrajes explícitos (ej: "Mojito y Aperol"), repartir targetLiters
  const unassigned = items.filter((it) => !it.liters);
  if (unassigned.length > 0) {
    const remainingLiters = Math.max(unassigned.length * 5, targetLiters - allocatedTotal);
    const step = remainingLiters >= 20 ? 10 : 5;
    let perFlavor = Math.floor(remainingLiters / (unassigned.length * step)) * step;
    if (perFlavor < step) perFlavor = step;

    let distributed = 0;
    unassigned.forEach((it, idx) => {
      if (idx === unassigned.length - 1) {
        it.liters = Math.max(step, remainingLiters - distributed);
      } else {
        it.liters = perFlavor;
        distributed += perFlavor;
      }
    });
  }

  const finalTotalLiters = items.reduce((acc, it) => acc + (it.liters || 0), 0);

  return {
    isSuggested: false,
    items,
    totalLiters: finalTotalLiters,
    unrecognizedFlavors: unrecognized
  };
}
