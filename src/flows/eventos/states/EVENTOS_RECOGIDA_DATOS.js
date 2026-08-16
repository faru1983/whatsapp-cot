// ==============================================================================
// OBJETIVO: Paso EVENTOS_RECOGIDA_DATOS — intro Eventos con formato ya fijado.
// Fase A) tipo de evento → B) invitados → C) cócteles p/p. Luego → INTRO_MENU (precios / duda).
// Fecha/comuna ya no se piden aquí (quedan opcionales más adelante / Por confirmar).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import {
  asksPriceOrCatalog,
  asksYieldOrRendimiento,
  asksWhatServiceIncludes,
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
  eventosIntroMenuQuestion,
  buildDrinksPerPersonAsk,
  getEventServiceIncludesReply
} from '../../../logic/eventos-intro.js';
import { buildVolumeRecommendation, resolveDrinksPerPersonChoice, parsePerPersonChoice } from '../../../logic/eventos-style-pack.js';

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
Orden: (A) tipo de evento, (B) invitados, (C) cócteles por persona (guía 2 vs 3+, sin litros).
Si el cliente NO tiene evento y solo quiere precios/info a futuro → invitar a la web (Cotizar), no insistir con datos.
0. NO digas "hola" ni te presentes como asistente virtual.
1. Responde dudas breves y amigables.
2. REGLA DE COBERTURA: RM = todas las comunas. Fuera de RM = evaluar según tamaño del evento y fecha; seguir cotizando para que el equipo confirme viaje. NUNCA digas cobertura fija en La Serena/Coquimbo.
3. REGLA DE LOGÍSTICA: Instalación Dispensador gratis, Muro $50.000. NUNCA inventes tarifas de envío.
4. RENDIMIENTO / VASOS: responde SOLO según el formato elegido. Dispensador: 5L≈25 y 10L≈50 cócteles (vaso 200ml). Muro: 10L≈50, 20L≈100, 30L≈150. PROHIBIDO hablar de Barriles Desechables.
5. NUNCA cotices ni calcules precios finales todavía. NO envíes el catálogo de precios hasta que elija Ver Precios y Cotizar.
6. Puedes mencionar www.cocktailsontap.cl/eventos si pregunta precios; no lo presentes como menú obligatorio.
7. Si faltan invitados, pídelos. Si ya hay invitados y faltan cócteles p/p, pide el número (2 complemento / 3+ barra). NO listes litros ni rendimiento de barriles en ese paso.
8. Al final, re-pregunta solo el dato pendiente (tipo, invitados o cócteles por persona).`;

/**
 * hasGuests: ¿Ya hay cantidad de invitados en sesión?
 *
 * @param {object} session
 * @returns {boolean}
 */
function hasGuests(session) {
  return Number(session?.guests) > 0;
}

/**
 * hasDrinksPerPerson: ¿Ya eligió cuántos cócteles por persona?
 *
 * @param {object} session
 * @returns {boolean}
 */
function hasDrinksPerPerson(session) {
  return Number(session?.eventosDrinksPerGuest) >= 1;
}

/**
 * needsDrinksPerPerson: Ya hay invitados y falta el consumo p/p.
 *
 * @param {object} session
 * @returns {boolean}
 */
function needsDrinksPerPerson(session) {
  return hasGuests(session) && !hasDrinksPerPerson(session);
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
  if (needsDrinksPerPerson(session)) {
    return withAssistantFooter(buildDrinksPerPersonAsk(session, formatKeyFromSession(session)));
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
 * goIntroMenu: Tras p/p → cálculo de volumen + menú Ver Precios / duda.
 * El catálogo de precios se envía recién cuando elige cotizar.
 *
 * @param {object} session
 * @returns {object}
 */
function goIntroMenu(session) {
  const formatKey = formatKeyFromSession(session);
  const per = Number(session.eventosDrinksPerGuest) || 2;
  const rec = buildVolumeRecommendation(session, formatKey, per);
  return {
    success: true,
    nextState: 'EVENTOS_INTRO_MENU',
    customReplies: [rec, eventosIntroMenuQuestion()],
    flowProgress: true
  };
}

/**
 * askDrinksPhase: Tras invitados → guía 2/3 p/p + pregunta (sin litros ni imagen de precios).
 *
 * @param {object} session
 * @returns {object}
 */
function askDrinksPhase(session) {
  return {
    success: true,
    nextState: 'EVENTOS_RECOGIDA_DATOS',
    customReply: buildDrinksPerPersonAsk(session, formatKeyFromSession(session)),
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

    // "¿qué incluye el servicio?" → FAQ de incluido + dato pendiente
    if (asksWhatServiceIncludes(messageText) && !messageLooksLikeGuests(messageText)) {
      const pending = shortQuestionForSession(session)
        .replace(/\n\n_\(Soy asistente virtual[^_]*\)_\s*$/i, '')
        .trim();
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `${getEventServiceIncludesReply()}\n\n${pending}`,
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

    // Precios o rendimiento sin invitados: tip contextual del formato + dato pendiente
    // (ej. "hasta cuantos vasos da?" en Dispensador → 5L/10L, nunca Desechable)
    const isAskingPriceOrYieldWithoutData = (
      asksPriceOrCatalog(messageText) || asksYieldOrRendimiento(messageText)
    )
      && !asksWhatServiceIncludes(messageText)
      && !hasGuests(session)
      && !guestsJustParsed;
    if (isAskingPriceOrYieldWithoutData) {
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
        : (needsDrinksPerPerson(session)
          ? buildDrinksPerPersonAsk(session, formatKeyFromSession(session))
          : eventosIntroMenuQuestion());
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Estamos cotizando el *${formato}*: cócteles en barril con estación, instalación, hielo, vasos y accesorios incluidos. 🍸

Si buscas solo llevar barriles a tu casa, es nuestro servicio de *Barriles Desechables* (5L).

${pendingAsk}`,
        flowProgress: true
      };
    }

    // Con invitados: pedir p/p (o, si ya lo dijo, ir al menú Ver Precios)
    if (hasGuests(session)) {
      if (!hasDrinksPerPerson(session)) {
        // Si este mismo mensaje acaba de aportar invitados y no trae p/p, preguntar p/p
        // (no mandar el “50” a la IA: lo tomaría como cócteles por persona).
        if (guestsJustParsed && !parsePerPersonChoice(messageText)?.per) {
          return askDrinksPhase(session);
        }
        const choice = await resolveDrinksPerPersonChoice(messageText, session);
        if (choice?.per) {
          session.eventosDrinksPerGuest = choice.per;
          return goIntroMenu(session);
        }
        return askDrinksPhase(session);
      }
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
