// ==============================================================================
// OBJETIVO: Paso BARRILES_FILTRO_CANAL — entrada Barriles (web + fecha/comuna).
// Pedimos comuna y fecha altiro para filtrar mirones; con ambos → catálogo.
// El id se mantiene por compatibilidad con router/engine/sesiones.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { img } from '../../../logic/media.js';
import {
  hasDrinkSelection,
  parseDate,
  findLocationByFuzzyMatch
} from '../../../logic/utils.js';
import {
  asksPriceOrCatalog,
  findMentionedCocktail,
  formatDesechablePriceReply,
  wantsBrowseOnlyClose
} from '../../../logic/interruptions.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { matchKeywordIntent, rulesWebVsChat } from '../../../logic/keyword-intent.js';
import { exampleConcreteDateHint, normalizeBotDateText } from '../../../logic/cot-event-quote.js';
import { BARRILES_RECOGIDA_PRODUCTOS } from './BARRILES_RECOGIDA_PRODUCTOS.js';

/**
 * deliveryExampleLine: Ejemplo con fecha concreta (hoy Chile + 3 días).
 * Estilo canónico: _(ej: …)_ en la línea bajo la pregunta.
 *
 * @returns {string}
 */
function deliveryExampleLine() {
  return `_(ej: Providencia, ${exampleConcreteDateHint()})_`;
}

/**
 * shortQuestionForDelivery: Re-pregunta de comuna + fecha.
 *
 * @returns {string}
 */
function shortQuestionForDelivery() {
  return withAssistantFooter(`*¿De qué comuna nos escribes y para cuándo lo quieres?*
${deliveryExampleLine()}`);
}

/**
 * askDeliveryCopy: Texto largo pidiendo comuna/fecha (burbuja 2 de bienvenida).
 *
 * @returns {string}
 */
function askDeliveryCopy() {
  return `Si prefieres seguir por aquí y ver el catálogo:

*¿De qué comuna nos escribes y para cuándo lo quieres?*
${deliveryExampleLine()}`;
}

/**
 * welcomeForSession: Copy de entrada Barriles (siempre directo, sin “Soy el asistente virtual…”).
 *
 * @param {object} [_session]
 * @returns {string[]}
 */
function welcomeForSession(_session) {
  const pitch = `*Barriles Desechables* listos para servir:
• 5 litros ≈ *25 cócteles*
• Se conservan refrigerados (+3 semanas)
• Desde *$31.990* (según sabor)

📍 Despacho en toda la RM y a regiones por encomienda.

Puedes cotizar fácil y rápido en la web:
👉 *www.cocktailsontap.cl/barriles*`;

  return [pitch, askDeliveryCopy()];
}

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE ENTREGA BARRILES (entrada)]
Eres el asistente virtual de Cocktails on Tap. El cliente acaba de entrar a Barriles Desechables. Debe dar *comuna* y *fecha* de entrega, o tiene dudas.
0. NO digas "hola" ni te presentes como asistente virtual en el mensaje al cliente (el copy de entrada ya es directo).
1. Responde dudas breves (precios desde *$31.990*, 5L ≈ 25 cócteles, despacho RM / encomienda regiones). NUNCA inventes tarifas.
2. NUNCA pegues el catálogo completo todavía.
3. Puedes mencionar la web www.cocktailsontap.cl/barriles si prefiere cotizar solo ahí; no lo presentes como menú obligatorio web vs chat.
4. Al finalizar, si faltan comuna o fecha, pídelas con día concreto (ej. "Providencia, 5 de agosto"), no solo "este sábado".`;

/**
 * ensureDesechableCart: Inicializa orderBuilder tipo desechable si falta.
 * @param {object} session
 */
function ensureDesechableCart(session) {
  if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { name: null, date: null, location: null }
    };
  }
  if (!session.orderBuilder.clientData) {
    session.orderBuilder.clientData = { name: null, date: null, location: null };
  }
}

/**
 * hasDeliveryData: ¿Ya tenemos fecha y comuna en el carrito?
 * @param {object} session
 * @returns {boolean}
 */
function hasDeliveryData(session) {
  const cd = session.orderBuilder?.clientData;
  return Boolean(cd?.date && cd?.location);
}

/**
 * applyDeliveryDataFromMessage: Guarda fecha y/o comuna en clientData.
 * Si la fecha es relativa ("este sábado"), la normaliza a "3 de agosto".
 *
 * @param {string} messageText
 * @param {object} session
 * @returns {{ gotDate: boolean, gotLocation: boolean }}
 */
function applyDeliveryDataFromMessage(messageText, session) {
  ensureDesechableCart(session);
  const cd = session.orderBuilder.clientData;
  let gotDate = false;
  let gotLocation = false;

  const parsedDate = parseDate(messageText);
  if (parsedDate) {
    cd.date = normalizeBotDateText(parsedDate) || parsedDate;
    gotDate = true;
  }

  const locationSearch = findLocationByFuzzyMatch(messageText);
  if (locationSearch) {
    cd.location = locationSearch.name;
    cd.locationData = locationSearch;
    gotLocation = true;
  }

  return { gotDate, gotLocation };
}

/**
 * repliesEnterCatalog: Carta de precios + pregunta de sabores.
 * @returns {Array}
 */
function repliesEnterCatalog() {
  return [
    img('barril_desechable_precios.webp', 'Aquí va la lista de sabores y precios 👆'),
    `*¿Qué sabor y cuántos barriles quieres?*
_(ej: 1 mojito y 1 sangría)_`
  ];
}

export const BARRILES_FILTRO_CANAL = defineState({
  id: 'BARRILES_FILTRO_CANAL',
  texts: welcomeForSession,
  shortQuestion: () => shortQuestionForDelivery(),
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureDesechableCart(session);
    const SHORT_Q = shortQuestionForDelivery();

    // Mirón / después → despedida + mute (sin anunciarlo en el copy)
    if (wantsBrowseOnlyClose(messageText)
        && !/^(no|nop|nope|nah)$/i.test(String(messageText || '').trim())) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    // Quiere ir a la web sin estar dando datos → link + cierre
    const webLabel = matchKeywordIntent(
      messageText,
      rulesWebVsChat().filter((r) => r.label === 'WEB')
    );
    const before = { ...session.orderBuilder.clientData };
    if (webLabel === 'WEB' && !before.date && !before.location && !hasDrinkSelection(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: `Perfecto 😊
En la *web* encuentras sabores, fotos y precios, y puedes comprar cuando quieras:
👉 https://cocktailsontap.cl/barriles

¡Gracias por tu interés!`,
        mute: true
      };
    }

    // Precio/carta sin datos → tip corto + seguimos pidiendo comuna/fecha
    if (asksPriceOrCatalog(messageText) && !hasDeliveryData(session)) {
      const cocktail = findMentionedCocktail(messageText);
      const priceLine = cocktail ? formatDesechablePriceReply(cocktail) : null;
      if (priceLine) {
        return {
          success: true,
          nextState: 'BARRILES_FILTRO_CANAL',
          customReply: `${priceLine}\n\n${SHORT_Q}`,
          flowProgress: true
        };
      }
      return {
        success: true,
        nextState: 'BARRILES_FILTRO_CANAL',
        customReply: `Precios desde *$31.990* (5L ≈ 25 cócteles). Catálogo completo: www.cocktailsontap.cl/barriles\n\n${SHORT_Q}`,
        flowProgress: true
      };
    }

    // Extraemos comuna / fecha si vienen en el mensaje
    const { gotDate, gotLocation } = applyDeliveryDataFromMessage(messageText, session);

    // Ya tenemos ambos → catálogo de sabores (o procesamos sabores si vienen ahora)
    if (hasDeliveryData(session)) {
      if (hasDrinkSelection(messageText)) {
        return BARRILES_RECOGIDA_PRODUCTOS.validateAndProcess(messageText, session);
      }
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReplies: repliesEnterCatalog()
      };
    }

    // Parcial: anotamos lo que vino y pedimos lo que falta
    if (gotDate || gotLocation) {
      const missing = [];
      if (!session.orderBuilder.clientData.date) missing.push('la *fecha* de entrega');
      if (!session.orderBuilder.clientData.location) missing.push('la *comuna*');
      const got = [];
      if (gotLocation) got.push(`comuna: *${session.orderBuilder.clientData.location}*`);
      if (gotDate) got.push(`fecha: *${session.orderBuilder.clientData.date}*`);
      const ack = got.length ? `Perfecto, anoté ${got.join(' y ')}. ` : 'Perfecto. ';
      return {
        success: true,
        nextState: 'BARRILES_FILTRO_CANAL',
        customReply: `${ack}Me falta ${missing.join(' y ')}.`,
        flowProgress: true
      };
    }

    // Trae sabores sin datos aún → armamos carrito y pedimos igual fecha/comuna
    if (hasDrinkSelection(messageText)) {
      await BARRILES_RECOGIDA_PRODUCTOS.validateAndProcess(messageText, session);
      return {
        success: true,
        nextState: 'BARRILES_FILTRO_CANAL',
        customReply: `Anoté tus cócteles 🙂 Para seguir, ${SHORT_Q}`,
        flowProgress: true
      };
    }

    // "aquí" / "sigamos" / "ok" / "después te confirmo…" sin datos → re-preguntamos
    if (/^(aqui|acá|aka|chat|whatsapp|sigamos|seguimos|dale|ok|okay|si|sí|claro)$/i.test(
      String(messageText || '').trim()
    ) || (
      /\bdespu[eé]s\b/i.test(messageText)
      && /\b(confirmo|confirmar|te\s+(digo|aviso|paso))\b/i.test(messageText)
      && /\b(comuna|fecha|cu[aá]ndo)\b/i.test(messageText)
    )) {
      return {
        success: true,
        nextState: 'BARRILES_FILTRO_CANAL',
        customReply: `¡Dale! ${SHORT_Q}`
      };
    }

    return { success: false };
  }
});
