// ==============================================================================
// OBJETIVO: Paso EVENTOS_RECOGIDA_DATOS — intro Eventos con formato ya fijado.
// Fase A) tipo de evento → B) invitados. Luego → INTRO_MENU (cotizar / duda).
// Fecha/comuna ya no se piden aquí (quedan opcionales más adelante / Por confirmar).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getBrowseOnlyGoodbye, getEventLitersSuggestion } from '../../../views/templates.js';
import {
  asksPriceOrCatalog,
  buildContextualPriceOrCatalogTip,
  wantsBrowseOnlyClose
} from '../../../logic/interruptions.js';
import { matchKeywordIntent, rulesWebVsChat } from '../../../logic/keyword-intent.js';
import {
  applyEventDataFromMessage,
  extractGuestsFromMessage,
  asksEventServiceFormatQuestion,
  asksCoverageAreaQuestion,
  buildEventosCoverageReply,
  normalizeCelebrationLabel,
  wantsSkipCelebrationType,
  wantsEventInfoOnly,
  wantsUnknownGuestsCount,
  looksLikeCelebrationUncertainty,
  asksEquipmentOrResaleQuestion,
  getEventFormatKey
} from '../../../logic/eventos-helpers.js';
import { isLikelyThirdPartyBotReply, isGreetingOrNoise } from '../../../logic/interruptions.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  extractCelebrationTypeWithAI,
  classifyEventosInfoOnlyWithAI,
  lastBotText
} from '../../../logic/nlu-intent.js';
import {
  askCelebrationCopy,
  askGuestsCopyCanonical,
  buildFormatPhaseAReplies,
  buildFormatPhaseBReplies,
  eventosIntroMenuQuestion
} from '../../../logic/eventos-intro.js';

/** Cierre suave: sin evento concreto, solo info/precios → web. */
const REPLY_INFO_ONLY_WEB = `Entiendo: si aún no tienes un evento o celebración definida y solo necesitas información, te invitamos a revisar nuestra web. En *Cotizar* puedes simular distintas opciones y ver precios:

👉 https://www.cocktailsontap.cl/

Cuando tengas más claro el evento (invitados, fecha), escríbeme y te ayudo por aquí. 🥂`;

/** Si no sabe invitados: pedir un aproximado (no cerrar). */
const ASK_GUESTS_APPROX = `Sin problema: un *aproximado* sirve perfecto.

*¿Cuántos invitados calculas más o menos?*
_(ej: 50 o unas 80)_`;

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DEL EVENTO (formato ya elegido)]
Eres el asistente virtual de Cocktails on Tap. El cliente YA eligió Dispensador o Muro.
Orden: (A) tipo de evento (pregunta abierta + parser/NLU; o skip → Por confirmar), (B) invitados.
Si el cliente NO tiene evento y solo quiere precios/info a futuro → invitar a la web (Cotizar), no insistir con datos.
0. NO digas "hola" ni te presentes como asistente virtual.
1. Responde dudas breves y amigables.
2. REGLA DE COBERTURA: RM = todas las comunas. Fuera de RM = evaluar según tamaño del evento y fecha; seguir cotizando para que el equipo confirme viaje. NUNCA digas cobertura fija en La Serena/Coquimbo.
3. REGLA DE LOGÍSTICA: Instalación Dispensador gratis, Muro $50.000. NUNCA inventes tarifas de envío.
4. NUNCA cotices ni calcules precios finales todavía.
5. Puedes mencionar www.cocktailsontap.cl/eventos si pregunta precios; no lo presentes como menú obligatorio.
6. Si faltan invitados, pídelos (un aproximado sirve). Si no tiene evento y solo quiere precios/info a futuro, invítalo a cotizar en la web.
7. Al final, re-pregunta solo el dato pendiente (tipo o invitados).`;

/**
 * hasGuests: ¿Ya hay cantidad de invitados en sesión?
 *
 * @param {object} session
 * @returns {boolean}
 */
function hasGuests(session) {
  return session?.guests != null && session.guests !== '';
}

/**
 * needsCelebrationType: ¿Todavía debemos pedir el tipo de evento?
 *
 * @param {object} session
 * @returns {boolean}
 */
function needsCelebrationType(session) {
  return !session?.celebrationType && !session?.eventosCelebrationSkipped;
}

/**
 * formatKeyFromSession: Clave dispensador|muro (fallback dispensador).
 *
 * @param {object} session
 * @returns {'dispensador'|'muro'}
 */
function formatKeyFromSession(session) {
  return getEventFormatKey(session?.eventoFormato);
}

/**
 * welcomeForSession: Si ya hay formato, reenvía intro fase A; si no, pide tipo.
 *
 * @param {object} session
 * @returns {string|Array}
 */
function welcomeForSession(session) {
  if (session?.eventoFormato) {
    return buildFormatPhaseAReplies(formatKeyFromSession(session));
  }
  return askCelebrationCopy();
}

/**
 * shortQuestionForSession: Re-pregunta según el dato pendiente (A → B).
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (needsCelebrationType(session) && !hasGuests(session)) {
    return withAssistantFooter(askCelebrationCopy());
  }
  if (!hasGuests(session)) {
    return withAssistantFooter(askGuestsCopyCanonical());
  }
  return withAssistantFooter(eventosIntroMenuQuestion());
}

/**
 * messageLooksLikeGuests: ¿El mensaje trae un número que parece invitados?
 *
 * @param {string} messageText
 * @returns {boolean}
 */
function messageLooksLikeGuests(messageText) {
  return extractGuestsFromMessage(messageText) !== null;
}

/**
 * goInfoOnlyWeb: Cliente sin evento real / solo precios → web + mute.
 *
 * @returns {object}
 */
function goInfoOnlyWeb() {
  return {
    success: true,
    nextState: 'CERRADO',
    customReply: REPLY_INFO_ONLY_WEB,
    mute: true
  };
}

/**
 * goIntroMenu: Tras tipo + invitados → sugerencia de litros + menú cotizar / duda.
 *
 * @param {object} session
 * @returns {object}
 */
function goIntroMenu(session) {
  const type = session.celebrationType;
  const guests = session.guests;
  let ack = `Perfecto`;
  if (type) ack += `, *${type}*`;
  if (guests) ack += ` con *${guests}* invitados`;
  ack += `. 🍸`;

  // Orientación de consumo según invitados (antes estaba al abrir la carta)
  const formatKey = formatKeyFromSession(session);
  const litersHint = getEventLitersSuggestion(session.guests, formatKey);

  return {
    success: true,
    nextState: 'EVENTOS_INTRO_MENU',
    customReplies: [
      `${ack}\n\n${litersHint}`,
      eventosIntroMenuQuestion()
    ],
    flowProgress: true
  };
}

/**
 * skipCelebrationAndAskGuests: Marca tipo omitido y pide invitados (fase B con imagen).
 *
 * @param {object} session
 * @returns {object}
 */
function skipCelebrationAndAskGuests(session) {
  session.eventosCelebrationSkipped = true;
  session.celebrationType = null;
  return {
    success: true,
    nextState: 'EVENTOS_RECOGIDA_DATOS',
    customReplies: buildFormatPhaseBReplies(formatKeyFromSession(session), session),
    flowProgress: true
  };
}

/**
 * askGuestsPhaseB: Pasa a fase B (imagen + incluido + invitados).
 *
 * @param {object} session
 * @returns {object}
 */
function askGuestsPhaseB(session) {
  return {
    success: true,
    nextState: 'EVENTOS_RECOGIDA_DATOS',
    customReplies: buildFormatPhaseBReplies(formatKeyFromSession(session), session),
    flowProgress: true
  };
}

export const EVENTOS_RECOGIDA_DATOS = defineState({
  id: 'EVENTOS_RECOGIDA_DATOS',
  texts: welcomeForSession,
  shortQuestion: shortQuestionForSession,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    const trimmed = String(messageText || '').trim();

    // "NO"/"SOS" puro → success:false para handoff humano
    if (/^(no|sos)$/i.test(trimmed)) {
      return { success: false };
    }

    // Mirón / Instagram → despedida + mute
    if (wantsBrowseOnlyClose(messageText)
        && !/^(no|nop|nope|nah)$/i.test(trimmed)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    // Quiere ir a la web (sin estar dando datos) → link + cierre suave
    const webLabel = matchKeywordIntent(messageText, rulesWebVsChat().filter((r) => r.label === 'WEB'));
    if (webLabel === 'WEB' && !hasGuests(session) && !messageLooksLikeGuests(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: `¡Listo! Cotiza aquí: https://cocktailsontap.cl/eventos\nSi surge una duda, escríbeme. 🥂`,
        mute: true
      };
    }

    // Sin evento real / solo precios o info a futuro → web
    if (!hasGuests(session) && !messageLooksLikeGuests(messageText)
        && !asksEquipmentOrResaleQuestion(messageText)
        && wantsEventInfoOnly(messageText)) {
      return goInfoOnlyWeb();
    }

    // Cobertura (¿llegan a X?): respuesta programática
    if (asksCoverageAreaQuestion(messageText) && !messageLooksLikeGuests(messageText)) {
      const coverage = buildEventosCoverageReply(messageText);
      const pendingAsk = needsCelebrationType(session) && !hasGuests(session)
        ? askCelebrationCopy()
        : askGuestsCopyCanonical();
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `${coverage}\n\n${pendingAsk}`,
        flowProgress: true
      };
    }

    // Mensaje de otro bot: re-preguntar el dato pendiente
    if (isLikelyThirdPartyBotReply(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Parece que ese mensaje no trae datos de tu evento 😊\n\n${shortQuestionForSession(session).replace(/\n\n_\(Soy asistente virtual[^_]*\)_\s*$/i, '').trim()}`,
        flowProgress: true
      };
    }

    // Skip de tipo (“aún no lo sé”) → Por confirmar + invitados
    if (needsCelebrationType(session) && wantsSkipCelebrationType(messageText)) {
      return skipCelebrationAndAskGuests(session);
    }

    // Extraemos lo que venga (tipo / invitados; fecha/comuna se guardan si vienen)
    const hasNewInfo = applyEventDataFromMessage(messageText, session);
    const guestsJustParsed = messageLooksLikeGuests(messageText);

    // Si el dump traía "empresa/corporativo", unificamos etiqueta
    if (session.celebrationType && /corporativ/i.test(session.celebrationType)) {
      session.celebrationType = 'Empresa';
    }

    // Precios sin invitados: tip + dato pendiente
    const isAskingForPriceWithoutData = asksPriceOrCatalog(messageText)
      && !hasGuests(session)
      && !guestsJustParsed;
    if (isAskingForPriceWithoutData) {
      if (wantsEventInfoOnly(messageText)) {
        return goInfoOnlyWeb();
      }
      const tip = buildContextualPriceOrCatalogTip(session, 'EVENTOS_RECOGIDA_DATOS', messageText);
      const pending = needsCelebrationType(session)
        ? askCelebrationCopy()
        : askGuestsCopyCanonical();
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `${tip}\n\n${pending}`,
        flowProgress: true
      };
    }

    // Aún no sabe cuántos invitados → pedir aproximado
    if (!hasGuests(session) && !guestsJustParsed && wantsUnknownGuestsCount(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: ASK_GUESTS_APPROX,
        flowProgress: true
      };
    }

    // Duda dispensador/muro con formato ya fijo → explicar + dato pendiente
    if (asksEventServiceFormatQuestion(messageText) && !guestsJustParsed) {
      const formato = session.eventoFormato || 'Dispensador Portátil / Muro';
      const pendingAsk = !hasGuests(session)
        ? (needsCelebrationType(session) ? askCelebrationCopy() : askGuestsCopyCanonical())
        : eventosIntroMenuQuestion();
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Estamos cotizando el *${formato}*: cócteles en barril con estación, instalación, hielo, vasos y accesorios incluidos. 🍸

Si buscas solo llevar barriles a tu casa, es nuestro servicio de *Barriles Desechables* (5L).

${pendingAsk}`,
        flowProgress: true
      };
    }

    // Con invitados → menú cotizar / duda
    if (hasGuests(session)) {
      return goIntroMenu(session);
    }

    // Tipo anotado sin invitados → fase B
    if (session.celebrationType && !hasGuests(session) && hasNewInfo) {
      return askGuestsPhaseB(session);
    }

    // Parcial (solo fecha/comuna sin invitados) → pedir invitados
    if (hasNewInfo && !hasGuests(session)) {
      if (session.celebrationType || session.eventosCelebrationSkipped) {
        return askGuestsPhaseB(session);
      }
      // Guardó fecha/comuna pero aún falta tipo: seguir en A
      const got = [];
      if (session.date) got.push(`fecha: *${session.date}*`);
      if (session.location) got.push(`comuna: *${session.location}*`);
      const ack = got.length > 0 ? `Perfecto, anoté ${got.join(', ')}. ` : `Perfecto. `;
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `${ack}${askCelebrationCopy()}`,
        flowProgress: true
      };
    }

    // Tipo aún vacío: NLU texto libre o skip
    if (needsCelebrationType(session) && !guestsJustParsed && !isGreetingOrNoise(messageText) && trimmed.length >= 2) {
      const ai = await extractCelebrationTypeWithAI(messageText, lastBotText(session));
      if (ai?.skip && looksLikeCelebrationUncertainty(messageText)) {
        return skipCelebrationAndAskGuests(session);
      }
      const fromAi = normalizeCelebrationLabel(ai?.celebrationType);
      if (fromAi) {
        session.celebrationType = fromAi;
        return askGuestsPhaseB(session);
      }
    }

    // Sin invitados: NLU — ¿solo info (web) o no sabe cantidad?
    if (!hasGuests(session) && !guestsJustParsed && !isGreetingOrNoise(messageText)
        && trimmed.length >= 4
        && !(session.consecutiveErrors > 0)
        && !asksEquipmentOrResaleQuestion(messageText)) {
      const browse = await classifyEventosInfoOnlyWithAI(messageText, lastBotText(session));
      if (browse === 'INFO_ONLY') {
        return goInfoOnlyWeb();
      }
      if (browse === 'UNKNOWN_GUESTS') {
        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReply: ASK_GUESTS_APPROX,
          flowProgress: true
        };
      }
    }

    // No entendimos → engine: FAQ → IA → re-pregunta
    return { success: false };
  }
});
