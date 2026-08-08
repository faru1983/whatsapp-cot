// ==============================================================================
// OBJETIVO: Paso BARRILES_FILTRO_CANAL — pitch + respuesta abierta de sabor.
// Interacción corta: "tienes sangría?" → match + catálogo; off-topic → reencauzar;
// solo precios sin cotizar → web + mute. Comuna/fecha van después (RECOGIDA_DATOS).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import {
  wantsBrowseOnlyClose,
  wantsPricesOnlyBrowseClose
} from '../../../logic/interruptions.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { matchKeywordIntent, rulesWebVsChat } from '../../../logic/keyword-intent.js';
import { hasDrinkSelection } from '../../../logic/utils.js';
import {
  ensureDesechableCart,
  softSaveDeliveryHints,
  resolveBarrilesFlavorMatches,
  findUnmatchedFlavorSegments,
  looksLikeBarrilesFlavorInterest,
  looksLikeUnrecognizedFlavorAttempt,
  buildBarrilesNoMatchGateReplies,
  buildBarrilesMatchedCartReplies,
  buildBarrilesUnknownFlavorGateReplies
} from '../../../logic/barriles-intro.js';

/** Pregunta de sabor (burbuja 2 del pitch / re-pregunta). */
const ASK_BARRILES_FLAVOR = `👉 *Escribe el nombre del cóctel que te interesa y te enviaré el catálogo completo.*
_(ej: Mojito, Sangría, Ramazzotti, etc.)_`;

/**
 * welcomeForSession: Copy de entrada Barriles — pitch + pregunta en 2 burbujas.
 *
 * @param {object} [_session]
 * @returns {string[]}
 */
function welcomeForSession(_session) {
  return [
    `Nuestros *barriles desechables* de *5 litros* contienen cócteles listos para servir. 🍸

✅ Rinden hasta *25 cócteles*.
✅ Si sobra, solo vuelve a refrigerarlo. Se conserva por *más de 3 semanas.*
✅ Desde *$31.990*, según el sabor.

📍 Despachamos en toda la *Región Metropolitana* y enviamos a *otras Regiones* por Blue Express.`,
    ASK_BARRILES_FLAVOR
  ];
}

/**
 * shortQuestionForFlavor: Re-pregunta si el mensaje no se entendió como sabor.
 *
 * @returns {string}
 */
function shortQuestionForFlavor() {
  return withAssistantFooter(ASK_BARRILES_FLAVOR);
}

/** Cierre a la web cuando solo quiere mirar precios sin cotizar. */
const WEB_PRICES_ONLY_BYE = `Perfecto 😊
En la *web* encuentras sabores, fotos y precios, y puedes comprar cuando quieras:
👉 https://cocktailsontap.cl/barriles

¡Gracias por tu interés!`;

const AI_PROMPT = `[SISTEMA - ESTADO: ENTRADA BARRILES (pitch + sabor)]
Eres el asistente virtual de Cocktails on Tap. El cliente vio el pitch de Barriles Desechables y debe indicar el/los *cóctel(es) que le interesan* (ej. "sangría", "tienes mojito?", "sangría y ramazzotti") para enviarle el catálogo.
0. NO digas "hola" ni te presentes como asistente virtual (el copy de entrada ya es directo).
1. Si pregunta por uno o varios sabores concretos, confirma disponibilidad de TODOS con datos reales; no inventes cócteles.
2. Dudas breves OK (precios desde *$31.990*, 5L ≈ 25 cócteles, despacho). NUNCA inventes tarifas.
3. NUNCA pegues el catálogo completo como tabla de texto.
4. Al final, vuelve a pedir el nombre del/los cóctel(es) que le interesan.`;

export const BARRILES_FILTRO_CANAL = defineState({
  id: 'BARRILES_FILTRO_CANAL',
  texts: welcomeForSession,
  shortQuestion: () => shortQuestionForFlavor(),
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureDesechableCart(session);

    // Mirón / después → despedida + mute
    if (wantsBrowseOnlyClose(messageText)
        && !/^(no|nop|nope|nah)$/i.test(String(messageText || '').trim())) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    // Solo quiere ver precios y deja claro que no cotiza → web + silencio (mute)
    if (wantsPricesOnlyBrowseClose(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: WEB_PRICES_ONLY_BYE,
        mute: true
      };
    }

    // Quiere ir a la web sin estar pidiendo un sabor → link + cierre
    const webLabel = matchKeywordIntent(
      messageText,
      rulesWebVsChat().filter((r) => r.label === 'WEB')
    );
    if (webLabel === 'WEB' && !hasDrinkSelection(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: WEB_PRICES_ONLY_BYE,
        mute: true
      };
    }

    // Si adelanta comuna/fecha, las guardamos para más adelante (sin cambiar el paso).
    // Si SÍ reconocimos un dato de despacho, este mensaje NO es un intento de sabor
    // (evita que "Las Condes" se trate como cóctel desconocido más abajo).
    const recognizedDeliveryHint = softSaveDeliveryHints(messageText, session);

    // Match de sabor: "tienes sangría?", "sangría y ramazzotti", etc. (reglas → IA).
    // Puede traer 1 o varios cócteles del catálogo en el mismo mensaje.
    const lastBot = welcomeForSession(session);
    const matches = await resolveBarrilesFlavorMatches(messageText, Array.isArray(lastBot) ? lastBot.join('\n') : lastBot);

    // Nombró sabor(es) concreto(s) → intención de compra clara: los anotamos en el carrito
    // y saltamos el menú Cotizar/Consulta (evita volver a preguntar lo que ya dijo).
    if (matches.length > 0) {
      for (const name of matches) {
        session.orderBuilder.products[name] = (session.orderBuilder.products[name] || 0) + 1;
      }
      session.barrilesSuggestedCocktail = matches[0];
      const unmatched = findUnmatchedFlavorSegments(messageText);
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReplies: buildBarrilesMatchedCartReplies(matches, session.orderBuilder.products, unmatched),
        flowProgress: true
      };
    }

    // Nombró un sabor concreto que NO está en la carta ("negroni", "tienes piña colada?")
    // → se lo decimos claro + catálogo real + menú (antes del interés genérico, para no
    // responder "Excelente elección" ni caer en FAQ/LLM improvisado).
    if (!recognizedDeliveryHint && looksLikeUnrecognizedFlavorAttempt(messageText)) {
      session.barrilesSuggestedCocktail = null;
      return {
        success: true,
        nextState: 'BARRILES_INTRO_MENU',
        customReplies: buildBarrilesUnknownFlavorGateReplies(),
        flowProgress: true
      };
    }

    // Interés genérico de carta/precios sin nombrar sabor → catálogo + menú Cotizar/Consulta
    // (aquí sí conviene filtrar curiosos antes de seguir armando el pedido)
    if (looksLikeBarrilesFlavorInterest(messageText)) {
      session.barrilesSuggestedCocktail = null;
      return {
        success: true,
        nextState: 'BARRILES_INTRO_MENU',
        customReplies: buildBarrilesNoMatchGateReplies(),
        flowProgress: true
      };
    }

    // Off-topic / otra duda: no fingimos catálogo; el engine puede FAQ y re-preguntar sabor
    return { success: false };
  }
});
