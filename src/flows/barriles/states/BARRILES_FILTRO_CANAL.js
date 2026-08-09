// ==============================================================================
// OBJETIVO: Paso BARRILES_FILTRO_CANAL — pitch + menú de intención (estricto).
// Solo acepta 1️⃣/2️⃣/3️⃣ (dígito, emoji o palabras de referencia).
// Si no elige opción → success:false → engine: disculpa + menú + strikes.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import {
  wantsBrowseOnlyClose,
  wantsPricesOnlyBrowseClose
} from '../../../logic/interruptions.js';
import { getBrowseOnlyGoodbye, buildAdminSosBody } from '../../../views/templates.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { matchKeywordIntent, rulesMenuNumerico } from '../../../logic/keyword-intent.js';
import {
  ensureDesechableCart,
  softSaveDeliveryHints,
  buildBarrilesPedidoReplies,
  buildBarrilesPreciosReplies,
  buildBarrilesAskDoubtReply,
  barrilesIntentMenuQuestion,
  BARRILES_PEDIDO_SYNONYMS,
  BARRILES_PRECIOS_SYNONYMS,
  BARRILES_DUDA_SYNONYMS
} from '../../../logic/barriles-intro.js';

/** Pitch comercial (burbuja 1): bullets separados refrigerar / conservación. */
const PITCH_BARRILES = `Nuestros *barriles desechables* de *5 litros* contienen cócteles listos para servir. 🍸

✅ Rinden hasta *25 cócteles*.
✅ Si sobra, solo vuelve a refrigerarlo.
✅ Se conserva por *más de 3 semanas.*
✅ Desde *$31.990*, según el sabor.

📍 Despachamos en toda la *Región Metropolitana* y enviamos a *otras Regiones* por Blue Express.`;

/** Cierre a la web cuando deja claro que NO quiere pedir (solo mirar precios). */
const WEB_PRICES_ONLY_BYE = `Perfecto 😊
En la *web* encuentras sabores, fotos y precios, y puedes comprar cuando quieras:
👉 https://cocktailsontap.cl/barriles

¡Gracias por tu interés!`;

const MENU_Q = barrilesIntentMenuQuestion();
const SHORT_Q = withAssistantFooter(MENU_Q);

const AI_PROMPT = `[SISTEMA - ESTADO: ENTRADA BARRILES (pitch + menú intención)]
Eres el asistente virtual de Cocktails on Tap. El cliente vio el pitch de Barriles Desechables y debe elegir UNA opción del menú:
1️⃣ Quiero hacer un pedido — 2️⃣ Quiero ver precios — 3️⃣ Tengo una duda.
0. NO digas "hola" ni te presentes como asistente virtual.
1. Si no eligió opción clara, pide el *número* de la opción. No inventes sabores ni armes el pedido aquí.
2. Dudas breves OK (precios desde *$31.990*, 5L ≈ 25 cócteles, despacho). NUNCA inventes tarifas.
3. NUNCA pegues el catálogo completo como tabla de texto.
4. Al final, recuérdale el menú 1️⃣ / 2️⃣ / 3️⃣.`;

/**
 * welcomeForSession: Copy de entrada Barriles — pitch + menú de intención (2 burbujas).
 *
 * @param {object} [_session]
 * @returns {string[]}
 */
function welcomeForSession(_session) {
  return [PITCH_BARRILES, MENU_Q];
}

/**
 * shortQuestionForSession: Re-pregunta según fase (menú o espera de duda).
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForSession(session) {
  if (session?.barrilesAwaitingDoubt) {
    return withAssistantFooter('Escríbeme tu duda y te conectamos con el equipo.');
  }
  return SHORT_Q;
}

/**
 * rulesBarrilesIntentMenu: Keywords estrictas del menú 1️⃣ pedido / 2️⃣ precios / 3️⃣ duda.
 * Acepta dígito/emoji (via rulesMenuNumerico) o palabras de referencia claras.
 *
 * @returns {Array}
 */
function rulesBarrilesIntentMenu() {
  return rulesMenuNumerico([
    {
      n: 1,
      label: 'PEDIDO',
      // pedido / compra / orden / cotizar / uno (ver BARRILES_PEDIDO_SYNONYMS)
      extra: BARRILES_PEDIDO_SYNONYMS
    },
    {
      n: 2,
      label: 'PRECIOS',
      // precios / valores / costo / vale / catálogo (ver BARRILES_PRECIOS_SYNONYMS)
      extra: BARRILES_PRECIOS_SYNONYMS
    },
    {
      n: 3,
      label: 'DUDA',
      // duda / consulta / pregunta / ayuda / humano (ver BARRILES_DUDA_SYNONYMS)
      extra: BARRILES_DUDA_SYNONYMS
    }
  ]);
}

export const BARRILES_FILTRO_CANAL = defineState({
  id: 'BARRILES_FILTRO_CANAL',
  texts: welcomeForSession,
  shortQuestion: (session) => shortQuestionForSession(session),
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureDesechableCart(session);

    // ------------------------------------------------------------------
    // Fase duda: ya pedimos el texto; este mensaje ES la pregunta → SOS + mute
    // ------------------------------------------------------------------
    if (session.barrilesAwaitingDoubt) {
      const doubtText = String(messageText || '').trim();
      session.barrilesAwaitingDoubt = false;
      session.barrilesDoubtText = doubtText;
      // Sin customReply: mute silencioso; el humano responde la duda
      return {
        success: true,
        nextState: 'CERRADO',
        mute: true,
        notifyAdmin: {
          type: 'SOS',
          title: 'DUDA BARRILES',
          body: buildAdminSosBody({
            reason: `Eligió opción 3 / duda en intro barriles. Pregunta: ${doubtText || '(vacía)'}`,
            stateId: 'BARRILES_FILTRO_CANAL',
            lastMessage: doubtText
          })
        }
      };
    }

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

    // Solo quiere ver precios y deja claro que NO pide → web + silencio
    if (wantsPricesOnlyBrowseClose(messageText)) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: WEB_PRICES_ONLY_BYE,
        mute: true
      };
    }

    // Soft-save comuna/fecha si las adelanta (sin cambiar el paso ni fingir opción)
    softSaveDeliveryHints(messageText, session);

    // ------------------------------------------------------------------
    // Menú estricto: solo keywords (dígito/emoji/sinónimos). Sin NLU ni atajo sabor.
    // ------------------------------------------------------------------
    const intent = matchKeywordIntent(messageText, rulesBarrilesIntentMenu());

    // 1️⃣ Pedido → catálogo + pedir sabores → productos
    if (intent === 'PEDIDO') {
      session.barrilesSuggestedCocktail = null;
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReplies: buildBarrilesPedidoReplies(),
        flowProgress: true
      };
    }

    // 2️⃣ Precios → catálogo + ¿quieres pedir? → INTRO_MENU
    if (intent === 'PRECIOS') {
      session.barrilesSuggestedCocktail = null;
      return {
        success: true,
        nextState: 'BARRILES_INTRO_MENU',
        customReplies: buildBarrilesPreciosReplies(),
        flowProgress: true
      };
    }

    // 3️⃣ Duda → pedir el texto; el siguiente mensaje dispara SOS + mute
    if (intent === 'DUDA') {
      session.barrilesAwaitingDoubt = true;
      return {
        success: true,
        nextState: 'BARRILES_FILTRO_CANAL',
        customReply: buildBarrilesAskDoubtReply(),
        flowProgress: true
      };
    }

    // Opción no reconocida → engine: disculpa + menú + strike (anti-loop)
    return { success: false };
  }
});
