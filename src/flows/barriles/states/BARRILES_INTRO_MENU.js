// ==============================================================================
// OBJETIVO: Paso BARRILES_INTRO_MENU — tras ver precios/catálogo, ¿quiere pedir?
// Menú estricto 1️⃣ Sí / 2️⃣ No (dígito, emoji o palabras de referencia).
// Si no elige → success:false → engine: disculpa + menú + strikes.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { matchKeywordIntent, rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import {
  barrilesPostPreciosMenuQuestion,
  ensureDesechableCart,
  askBarrilesFlavorsCopy,
  BARRILES_PEDIDO_SYNONYMS
} from '../../../logic/barriles-intro.js';

const MENU_Q = barrilesPostPreciosMenuQuestion();
const SHORT_Q = withAssistantFooter(MENU_Q);

const AI_PROMPT = `[SISTEMA - ESTADO: MENÚ POST-PRECIOS BARRILES]
El cliente ya vio el catálogo/precios. Debe elegir UNA opción:
1️⃣ Sí, quiero hacer un pedido — o 2️⃣ No, gracias.
1. Si no eligió opción clara, pide el *número* de la opción.
2. NO inventes tarifas ni digas que ya enviaron la cotización.`;

export const BARRILES_INTRO_MENU = defineState({
  id: 'BARRILES_INTRO_MENU',
  promptQuestion: () => SHORT_Q,
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureDesechableCart(session);

    // Menú estricto: solo keywords (sin NLU ni atajo de sabor en este paso)
    const intent = matchKeywordIntent(
      messageText,
      rulesMenuUnoDos({
        labelUno: 'PEDIDO',
        labelDos: 'NO',
        // sí/dale/ok + sinónimos de pedido (compra, orden, etc.)
        extraUno: new RegExp(`s[ií]|dale|\\bok\\b|seguir|continuar|${BARRILES_PEDIDO_SYNONYMS.source}`, 'i'),
        extraDos: /no,?\s*gracias|\bno\b|nop|nope|solo\s+miraba|ahora\s+no|opci[oó]n\s*2|^(dos|segunda?)$/i
      })
    );

    // 2️⃣ No → despedida amable + mute (sin SOS; solo estaba mirando precios)
    if (intent === 'NO') {
      return {
        success: true,
        nextState: 'CERRADO',
        mute: true,
        customReply: getBrowseOnlyGoodbye()
      };
    }

    // 1️⃣ Sí → pedimos sabores y pasamos a productos
    if (intent === 'PEDIDO') {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: askBarrilesFlavorsCopy(),
        flowProgress: true
      };
    }

    // Opción no reconocida → engine: disculpa + menú + strike
    return { success: false };
  }
});
