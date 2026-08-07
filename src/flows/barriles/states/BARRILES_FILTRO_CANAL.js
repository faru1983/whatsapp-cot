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
  resolveBarrilesFlavorMatch,
  looksLikeBarrilesFlavorInterest,
  buildBarrilesIntroGateReplies
} from '../../../logic/barriles-intro.js';

/**
 * welcomeForSession: Copy de entrada Barriles (pitch + pregunta de sabor).
 *
 * @param {object} [_session]
 * @returns {string}
 */
function welcomeForSession(_session) {
  return `Nuestros *barriles desechables* de *5 litros* contienen cócteles *listos para servir*.
_Solo los refrigeras, sirves y disfrutas._ Si sobra, simplemente vuelves a guardarlo en el refrigerador para otra ocasión.

🍸 *Calidad de bar*, sin preparar nada.

✅ Rinden hasta *25 cócteles*.
✅ Se conservan refrigerados por *más de 3 semanas*.
✅ Desde *$31.990*, según el sabor.

📍 Despachamos en toda la *Región Metropolitana* y enviamos a *Regiones* por encomienda.

*¿Qué tipo de cóctel buscas hoy?*`;
}

/**
 * shortQuestionForFlavor: Re-pregunta si el mensaje no se entendió como sabor.
 *
 * @returns {string}
 */
function shortQuestionForFlavor() {
  return withAssistantFooter(`*¿Qué tipo de cóctel buscas hoy?*
_(ej: Mojito, Pisco Sour, algo refrescante)_`);
}

/** Cierre a la web cuando solo quiere mirar precios sin cotizar. */
const WEB_PRICES_ONLY_BYE = `Perfecto 😊
En la *web* encuentras sabores, fotos y precios, y puedes comprar cuando quieras:
👉 https://cocktailsontap.cl/barriles

¡Gracias por tu interés!`;

const AI_PROMPT = `[SISTEMA - ESTADO: ENTRADA BARRILES (pitch + sabor)]
Eres el asistente virtual de Cocktails on Tap. El cliente vio el pitch de Barriles Desechables y debe decir *qué tipo de cóctel busca* (ej. "sangría", "tienes mojito?").
0. NO digas "hola" ni te presentes como asistente virtual (el copy de entrada ya es directo).
1. Si pregunta por un sabor concreto, confirma disponibilidad con datos reales; no inventes cócteles.
2. Dudas breves OK (precios desde *$31.990*, 5L ≈ 25 cócteles, despacho). NUNCA inventes tarifas.
3. NUNCA pegues el catálogo completo como tabla de texto.
4. Al final, vuelve a preguntar qué tipo de cóctel busca.`;

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

    // Si adelanta comuna/fecha, las guardamos para más adelante (sin cambiar el paso)
    softSaveDeliveryHints(messageText, session);

    // Match de sabor: "tienes sangría?", "mojito", etc. (reglas → IA)
    const lastBot = welcomeForSession(session);
    const matched = await resolveBarrilesFlavorMatch(messageText, lastBot);

    // Interés de sabor / carta → catálogo + menú (con o sin match)
    if (matched || looksLikeBarrilesFlavorInterest(messageText)) {
      session.barrilesSuggestedCocktail = matched || null;
      return {
        success: true,
        nextState: 'BARRILES_INTRO_MENU',
        customReplies: buildBarrilesIntroGateReplies(matched),
        flowProgress: true
      };
    }

    // Off-topic / otra duda: no fingimos catálogo; el engine puede FAQ y re-preguntar sabor
    return { success: false };
  }
});
