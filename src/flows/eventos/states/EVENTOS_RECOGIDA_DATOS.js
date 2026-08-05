// ==============================================================================
// OBJETIVO: Paso EVENTOS_RECOGIDA_DATOS — entrada Eventos con preguntas en cadena.
// A) tipo de evento (menú / parser / NLU texto libre) → B) invitados → C) fecha+comuna (opcionales).
// Solo invitados es obligatorio; fecha/comuna se pueden saltar con ok/después.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventDataSummary, getBrowseOnlyGoodbye } from '../../../views/templates.js';
import {
  asksPriceOrCatalog,
  wantsBrowseOnlyClose
} from '../../../logic/interruptions.js';
import { matchKeywordIntent, matchesMenuOption, rulesWebVsChat } from '../../../logic/keyword-intent.js';
import {
  applyEventDataFromMessage,
  extractGuestsFromMessage,
  asksEventServiceFormatQuestion,
  asksCoverageAreaQuestion,
  normalizeCelebrationLabel,
  wantsSkipCelebrationType,
  wantsEventInfoOnly,
  wantsUnknownGuestsCount,
  wantsSkipEventLogistics,
  wantsUnknownLocationOnly
} from '../../../logic/eventos-helpers.js';
import { isLikelyThirdPartyBotReply, isGreetingOrNoise } from '../../../logic/interruptions.js';
import {
  withAssistantFooter,
  formatMenuBlock,
  MENU_WRITE_CTA
} from '../../../logic/flow-rails.js';
import {
  extractCelebrationTypeWithAI,
  classifyEventosInfoOnlyWithAI,
  extractEventLogisticsWithAI,
  lastBotText
} from '../../../logic/nlu-intent.js';
import { findLocationByFuzzyMatch, parseDate } from '../../../logic/utils.js';

/** Menú de tipo de evento (pregunta A). */
const TIPO_MENU = formatMenuBlock(['Cumpleaños', 'Matrimonio', 'Empresa', 'Otro']);

/** Pitch + pregunta A al entrar al flujo (sin web como CTA principal). */
const WELCOME = `*Cocktails on Tap* es una estación de coctelería autoservicio: convierte tu celebración en una experiencia moderna, entretenida y sin filas, con cócteles listos en segundos directo a la copa. 🍸

Para partir, ¿qué tipo de evento estás organizando?

${MENU_WRITE_CTA}
${TIPO_MENU}`;

/** Pregunta C: fecha y comuna opcionales. */
const ASK_LOGISTICS = `¿Me compartes *fecha* y *comuna* del evento? (si aún no las tienes, escribe *después* o *ok* para seguir)

Ejemplo: _"15 de mayo, Las Condes"_`;

/** Cierre suave: sin evento concreto, solo info/precios → web. */
const REPLY_INFO_ONLY_WEB = `Entiendo: si aún no tienes un evento o celebración definida y solo necesitas información, te invitamos a revisar nuestra web. En *Cotizar* puedes simular distintas opciones y ver precios:

👉 https://www.cocktailsontap.cl/

Cuando tengas más claro el evento (invitados, fecha), escríbeme y te ayudo por aquí. 🥂`;

/** Si no sabe invitados: pedir un aproximado (no cerrar). */
const ASK_GUESTS_APPROX = `Sin problema: un *aproximado* sirve perfecto.
¿Cuántos *invitados* calculas más o menos? (Ej: "50" o "unas 80")`;

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DEL EVENTO (entrada progresiva)]
Eres el asistente virtual de Cocktails on Tap. El cliente está en Servicio para Eventos.
Orden: (A) tipo de evento (menú/parser/NLU; o skip → Por confirmar), (B) invitados, (C) fecha+comuna opcionales.
Si el cliente NO tiene evento y solo quiere precios/info a futuro → invitar a la web (Cotizar), no insistir con datos.
0. NO digas "hola" ni te presentes como asistente virtual (el copy de entrada ya es directo).
1. Responde dudas breves y amigables.
2. REGLA DE COBERTURA: Si pregunta si vamos a su comuna/ciudad, responde: "Sí, trabajamos en toda la Región Metropolitana y La Serena/Coquimbo."
3. REGLA DE LOGÍSTICA: Instalación Dispensador gratis, Muro $50.000. NUNCA inventes tarifas de envío.
4. NUNCA cotices ni calcules precios finales todavía.
5. Puedes mencionar www.cocktailsontap.cl/eventos si pregunta precios; no lo presentes como menú obligatorio.
6. Si faltan invitados, pídelos (un aproximado sirve). Si no tiene evento y solo quiere precios/info a futuro, invítalo a cotizar en la web.
7. Fecha y comuna son opcionales: acepta "ok"/"después" para seguir.
8. Al final, re-pregunta solo el dato pendiente (tipo, invitados o fecha/comuna).`;

/**
 * welcomeForSession: Copy de entrada (pregunta A).
 *
 * @param {object} [_session]
 * @returns {string}
 */
function welcomeForSession(_session) {
  return WELCOME;
}

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
 * hasLogistics: ¿Hay fecha o comuna anotada?
 *
 * @param {object} session
 * @returns {boolean}
 */
function hasLogistics(session) {
  return Boolean(session?.date || session?.location);
}

/**
 * logisticsDone: ¿Podemos saltar o ya resolvimos la pregunta C?
 *
 * @param {object} session
 * @returns {boolean}
 */
function logisticsDone(session) {
  return hasLogistics(session) || Boolean(session?.eventosLogisticsSkipped);
}

/**
 * needsCelebrationType: ¿Todavía debemos pedir el tipo de evento?
 * Si lo saltó ("no sé" / ninguno), no insistimos: queda "Por confirmar".
 *
 * @param {object} session
 * @returns {boolean}
 */
function needsCelebrationType(session) {
  return !session?.celebrationType && !session?.eventosCelebrationSkipped;
}

/**
 * askGuestsCopy: Pregunta B, con ack del tipo o del skip.
 *
 * @param {object} session
 * @returns {string}
 */
function askGuestsCopy(session) {
  const type = session.celebrationType;
  let ack = '';
  if (type) {
    ack = `Perfecto, anoté *${type}*. 🍸\n`;
  } else if (session.eventosCelebrationSkipped) {
    ack = `Sin problema, el tipo lo dejamos por confirmar. 🍸\n`;
  }
  return `${ack}Para recomendarte el mejor formato (Dispensador o Muro), ¿cuántos *invitados* serán aproximadamente?
(Ej: "50" o "unas 80")`;
}

/**
 * skipCelebrationAndAskGuests: Marca tipo como omitido y pide invitados.
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
    customReply: askGuestsCopy(session),
    flowProgress: true
  };
}

/**
 * shortQuestionForSession: Re-pregunta según el dato pendiente (A → B → C).
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (needsCelebrationType(session) && !hasGuests(session)) {
    return withAssistantFooter(`¿Qué tipo de evento estás organizando?

${MENU_WRITE_CTA}
${TIPO_MENU}`);
  }
  if (!hasGuests(session)) {
    return withAssistantFooter(`¿Cuántos *invitados* serán aproximadamente?`);
  }
  if (!logisticsDone(session)) {
    return withAssistantFooter(ASK_LOGISTICS);
  }
  return withAssistantFooter(`¿Me confirmas los datos del evento para seguir?`);
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
 * isLogisticsSkip: ¿Quiere omitir fecha/comuna? (alias → helper compartido)
 *
 * @param {string} messageText
 * @returns {boolean}
 */
function isLogisticsSkip(messageText) {
  return wantsSkipEventLogistics(messageText);
}

/**
 * applyLogisticsFromAi: Aplica date/location del NLU a la sesión (sin inventar comuna).
 *
 * @param {object} session
 * @param {{ date?: string|null, location?: string|null }} ai
 * @returns {boolean} true si guardó algo nuevo
 */
function applyLogisticsFromAi(session, ai) {
  let changed = false;
  if (ai?.date && !session.date) {
    session.date = ai.date;
    changed = true;
  }
  if (ai?.location) {
    const fuzzy = findLocationByFuzzyMatch(ai.location);
    const locName = fuzzy?.name || ai.location;
    if (locName && locName !== session.location) {
      session.location = locName;
      if (fuzzy) {
        session.isRM = fuzzy.isRM;
        session.region = fuzzy.region;
      }
      changed = true;
    }
  }
  return changed;
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
 * goConfirm: Avanza al resumen con los datos anotados.
 *
 * @param {object} session
 * @returns {object}
 */
function goConfirm(session) {
  return {
    success: true,
    nextState: 'EVENTOS_CONFIRMAR_DATOS',
    customReplies: getEventDataSummary(session)
  };
}

/**
 * tryApplyCelebrationMenu: Menú 1️⃣–4️⃣ de tipo de evento (sin NLU).
 * Opción 4️⃣ = *Otro* (valor fijo; no pide escribir el tipo).
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {'set'|'none'}
 */
function tryApplyCelebrationMenu(messageText, session) {
  const trimmed = String(messageText || '').trim();

  if (matchesMenuOption(trimmed, 1) || /^(cumplea[nñ]os|cumple)$/i.test(trimmed)) {
    session.celebrationType = 'Cumpleaños';
    return 'set';
  }
  if (matchesMenuOption(trimmed, 2) || /^(matrimonio|casamiento|boda|wedding)$/i.test(trimmed)) {
    session.celebrationType = 'Matrimonio';
    return 'set';
  }
  if (matchesMenuOption(trimmed, 3) || /^(empresa|corporativ[oa]?|trabajo)$/i.test(trimmed)) {
    session.celebrationType = 'Empresa';
    return 'set';
  }
  if (matchesMenuOption(trimmed, 4) || /^(otros?|otra)$/i.test(trimmed)) {
    session.celebrationType = 'Otro';
    return 'set';
  }
  return 'none';
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

    // Pregunta C abierta: skip fecha/comuna (si además hay fecha en el texto, no skipear aquí)
    const awaitingLogistics = hasGuests(session) && !logisticsDone(session);
    if (awaitingLogistics && isLogisticsSkip(messageText) && !parseDate(messageText)) {
      session.eventosLogisticsSkipped = true;
      return goConfirm(session);
    }

    // Mirón / Instagram → despedida + mute (no aplica al skip de logística)
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

    // Sin evento real / solo precios o info a futuro → web (simulador Cotizar)
    if (!hasGuests(session) && !messageLooksLikeGuests(messageText) && wantsEventInfoOnly(messageText)) {
      return goInfoOnlyWeb();
    }

    // Cobertura (¿van a X?) → FAQ, sin extraer comuna
    if (asksCoverageAreaQuestion(messageText) && !hasGuests(session) && !messageLooksLikeGuests(messageText)) {
      return { success: false };
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

    // Menú A / skip de tipo: solo si aún pedimos celebración
    if (needsCelebrationType(session)) {
      if (wantsSkipCelebrationType(messageText)) {
        return skipCelebrationAndAskGuests(session);
      }

      const menuResult = tryApplyCelebrationMenu(messageText, session);
      if (menuResult === 'set') {
        // No llamar extractGuests: "1" = Cumpleaños, no "1 invitado"
        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReply: askGuestsCopy(session),
          flowProgress: true
        };
      }
    }

    // Extraemos lo que venga (puede ser 1 dato o varios de un dump)
    const hasNewInfo = applyEventDataFromMessage(messageText, session);
    const guestsJustParsed = messageLooksLikeGuests(messageText);

    // Si el dump traía "empresa/corporativo", unificamos etiqueta del menú
    if (session.celebrationType && /corporativ/i.test(session.celebrationType)) {
      session.celebrationType = 'Empresa';
    }

    // Precios sin invitados: si es “solo info/sin evento” → web; si no, tip + dato pendiente
    const isAskingForPriceWithoutData = asksPriceOrCatalog(messageText)
      && !hasGuests(session)
      && !guestsJustParsed;
    if (isAskingForPriceWithoutData) {
      if (wantsEventInfoOnly(messageText)) {
        return goInfoOnlyWeb();
      }
      const pending = needsCelebrationType(session)
        ? `Para orientarte, ¿qué tipo de evento es?\n\n${MENU_WRITE_CTA}\n${TIPO_MENU}`
        : `Para recomendarte el mejor formato, ¿cuántos *invitados* serán aproximadamente?`;
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Depende de invitados y formato (Dispensador o Muro). También puedes ver rangos en https://cocktailsontap.cl/eventos 🍸\n\n${pending}`,
        flowProgress: true
      };
    }

    // Aún no sabe cuántos invitados → pedir aproximado (no cerrar ni FAQ rara)
    if (!hasGuests(session) && !guestsJustParsed && wantsUnknownGuestsCount(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: ASK_GUESTS_APPROX,
        flowProgress: true
      };
    }

    // Duda dispensador/muro → copy fijo + dato pendiente
    if (asksEventServiceFormatQuestion(messageText) && !guestsJustParsed) {
      const pendingAsk = !hasGuests(session)
        ? askGuestsCopy(session)
        : ASK_LOGISTICS;
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `En *Servicio para Eventos* los cócteles van en barril y los sirves con nuestra estación (*Dispensador Portátil* o *Muro de Coctelería*): instalación, hielo, vasos y accesorios incluidos. 🍸

Si buscas solo llevar barriles a tu casa, es nuestro servicio de *Barriles Desechables* (5L).

${pendingAsk}`,
        flowProgress: true
      };
    }

    // Con invitados + logística lista (datos o skip) → resumen
    if (hasGuests(session) && logisticsDone(session)) {
      return goConfirm(session);
    }

    // Pregunta C: fecha/comuna (opcionales)
    if (hasGuests(session) && !logisticsDone(session)) {
      // Ya pedimos C: interpretar skip, parcial o NLU (no repetir el mismo copy a ciegas)
      if (session.eventosLogisticsAsked) {
        // Fecha parcial + "lugar aún no" → avanzar (comuna Por confirmar)
        if (session.date && wantsUnknownLocationOnly(messageText)) {
          return goConfirm(session);
        }
        if (wantsSkipEventLogistics(messageText) && !session.date && !session.location) {
          session.eventosLogisticsSkipped = true;
          return goConfirm(session);
        }
        // Si applyEventData ya puso fecha o comuna → confirmar
        if (session.date || session.location) {
          return goConfirm(session);
        }

        const aiLog = await extractEventLogisticsWithAI(messageText, lastBotText(session));
        if (aiLog?.skip && !aiLog.date && !aiLog.location) {
          session.eventosLogisticsSkipped = true;
          return goConfirm(session);
        }
        if (aiLog && (aiLog.date || aiLog.location)) {
          applyLogisticsFromAi(session, aiLog);
          // Si dio fecha y dejó claro que no sabe lugar → confirmar
          if (session.date && wantsUnknownLocationOnly(messageText)) {
            return goConfirm(session);
          }
          if (session.date || session.location) {
            return goConfirm(session);
          }
        }

        // No entendimos: re-pregunta corta con pista de skip (no el mismo párrafo largo)
        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReply: `No capté una *fecha* o *comuna* concretas 😊
Puedes escribirlas (ej. _"15 de mayo, Las Condes"_) o *ok* / *después* para seguir sin eso.`,
          flowProgress: true
        };
      }

      // Primera vez en C → presentar pregunta
      session.eventosLogisticsAsked = true;
      const ackParts = [];
      if (session.celebrationType) ackParts.push(`*${session.celebrationType}*`);
      ackParts.push(`*${session.guests}* invitados`);
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Perfecto, anoté ${ackParts.join(', ')}. ${ASK_LOGISTICS}`,
        flowProgress: true
      };
    }

    // Tipo anotado (texto libre / dump parcial) sin invitados → pregunta B
    if (session.celebrationType && !hasGuests(session) && hasNewInfo) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: askGuestsCopy(session),
        flowProgress: true
      };
    }

    // Parcial raro (solo fecha/comuna sin invitados) → pedir invitados
    if (hasNewInfo && !hasGuests(session)) {
      const got = [];
      if (session.celebrationType) got.push(`celebración: *${session.celebrationType}*`);
      if (session.date) got.push(`fecha: *${session.date}*`);
      if (session.location) got.push(`comuna: *${session.location}*`);
      const ack = got.length > 0 ? `Perfecto, anoté ${got.join(', ')}. ` : `Perfecto. `;
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `${ack}Para recomendarte el mejor formato (Dispensador o Muro), ¿cuántos *invitados* serán aproximadamente?`,
        flowProgress: true
      };
    }

    // Tipo aún vacío: NLU texto libre o skip ("no sé")
    if (needsCelebrationType(session) && !guestsJustParsed && !isGreetingOrNoise(messageText) && trimmed.length >= 2) {
      const ai = await extractCelebrationTypeWithAI(messageText, lastBotText(session));
      if (ai?.skip) {
        return skipCelebrationAndAskGuests(session);
      }
      const fromAi = normalizeCelebrationLabel(ai?.celebrationType);
      if (fromAi) {
        session.celebrationType = fromAi;
        return {
          success: true,
          nextState: 'EVENTOS_RECOGIDA_DATOS',
          customReply: askGuestsCopy(session),
          flowProgress: true
        };
      }
    }

    // Sin invitados: NLU — ¿solo info/sin evento (web) o no sabe cantidad (aproximado)?
    if (!hasGuests(session) && !guestsJustParsed && !isGreetingOrNoise(messageText) && trimmed.length >= 4) {
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
