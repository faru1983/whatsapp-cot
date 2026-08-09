// ==============================================================================
// OBJETIVO: Paso BARRILES_INTRO_MENU — tras ver precios/catálogo, ¿quiere pedir?
// Menú 1️⃣ Sí / 2️⃣ No: keywords (pedido/compra / gracias / solo eso) → IA si hay duda.
// Si no elige → success:false → engine: disculpa + menú + strikes.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import {
  barrilesPostPreciosMenuQuestion,
  ensureDesechableCart,
  askBarrilesFlavorsCopy,
  BARRILES_POST_PRECIOS_SI_SYNONYMS,
  BARRILES_POST_PRECIOS_NO_SYNONYMS
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

    // Keywords primero (pedido/compra vs gracias/solo eso); si hay duda → NLU
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['PEDIDO', 'NO'],
      keywordRules: rulesMenuUnoDos({
        labelUno: 'PEDIDO',
        labelDos: 'NO',
        extraUno: BARRILES_POST_PRECIOS_SI_SYNONYMS,
        extraDos: BARRILES_POST_PRECIOS_NO_SYNONYMS
      }),
      labelHints: {
        PEDIDO: 'Opción 1 / quiere hacer un pedido o comprar por WhatsApp (1, 1️⃣, sí, pedir, comprar, orden).',
        NO: 'Opción 2 / no quiere pedir ahora (2, 2️⃣, no gracias, gracias, solo eso, solo miraba).'
      }
    });

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
