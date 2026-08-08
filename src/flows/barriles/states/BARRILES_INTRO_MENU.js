// ==============================================================================
// OBJETIVO: Paso BARRILES_INTRO_MENU — tras match/catálogo, elige cotizar o consulta.
// 1️⃣ Cotizar → pide sabores/cantidades y sigue el flujo de compra.
// 2️⃣ Consulta → mensaje corto + SOS admin + mute (humano responde).
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import { buildAdminSosBody } from '../../../views/templates.js';
import {
  barrilesIntroMenuQuestion,
  ensureDesechableCart,
  resolveBarrilesFlavorMatches,
  findUnmatchedFlavorSegments,
  looksLikeUnrecognizedFlavorAttempt,
  buildBarrilesUnknownFlavorGateReplies,
  buildBarrilesMatchedCartReplies
} from '../../../logic/barriles-intro.js';

const MENU_Q = barrilesIntroMenuQuestion();
const SHORT_Q = withAssistantFooter(MENU_Q);

const AI_PROMPT = `[SISTEMA - ESTADO: MENÚ INTRO BARRILES]
El cliente ya vio un pitch de sabor o el catálogo. Debe elegir:
1️⃣ Cotizar mi pedido — o 2️⃣ Tengo una consulta.
1. Dudas breves OK (precio base, rendimiento 25 tragos, despacho) sin armar el pedido completo.
2. Al final, recuérdale el menú 1️⃣ / 2️⃣.
3. NO inventes tarifas ni digas que ya enviaron la cotización.`;

/**
 * cotizarAskCopy: Texto al elegir 1️⃣ — pide cócteles y cantidades.
 *
 * @returns {string}
 */
function cotizarAskCopy() {
  return `Perfecto. 😊 Indícame qué cócteles te gustaría pedir y cuántos barriles de cada uno necesitas (👆 revísalos en el catálogo). Te prepararé la cotización de inmediato.
_(ej: 1 mojito y 2 sangría)_`;
}

export const BARRILES_INTRO_MENU = defineState({
  id: 'BARRILES_INTRO_MENU',
  promptQuestion: () => SHORT_Q,
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    ensureDesechableCart(session);

    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['COTIZAR', 'CONSULTA'],
      keywordRules: rulesMenuUnoDos({
        labelUno: 'COTIZAR',
        labelDos: 'CONSULTA',
        extraUno: /cotizar|pedido|comprar|quiero\s+pedir|armar\s+(el\s+)?pedido/i,
        extraDos: /consulta|duda|pregunta|humano|asesor|ayuda\s+humana/i
      }),
      labelHints: {
        COTIZAR: 'Opción 1 / quiere cotizar o armar el pedido (1, 1️⃣, cotizar, pedir).',
        CONSULTA: 'Opción 2 / tiene una consulta o quiere hablar con el equipo.'
      }
    });

    // 2️⃣ Consulta → avisamos, SOS a admin y mute (el humano lee lo que escriba después)
    if (intent === 'CONSULTA') {
      const suggested = session.barrilesSuggestedCocktail
        ? ` Interés mencionado: ${session.barrilesSuggestedCocktail}.`
        : '';
      return {
        success: true,
        nextState: 'CERRADO',
        mute: true,
        notifyAdmin: {
          type: 'SOS',
          title: 'CONSULTA BARRILES',
          body: buildAdminSosBody({
            reason: `Eligió opción 2 / consulta en intro barriles.${suggested}`,
            stateId: 'BARRILES_INTRO_MENU'
          })
        },
        customReply: `Perfecto. Cuéntame tu consulta y te responderemos a la brevedad.`
      };
    }

    // 1️⃣ Cotizar → pedir sabores/cantidades; aquí marcamos Interesado (CRM / Cliente potencial)
    if (intent === 'COTIZAR') {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: cotizarAskCopy(),
        flowProgress: true
      };
    }

    // En el menú aún puede nombrar un sabor: si está en la carta → carrito directo;
    // si no ("negroni") → le decimos que no lo tenemos + catálogo + menú otra vez.
    const matches = await resolveBarrilesFlavorMatches(messageText, MENU_Q);
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
    if (looksLikeUnrecognizedFlavorAttempt(messageText)) {
      session.barrilesSuggestedCocktail = null;
      return {
        success: true,
        nextState: 'BARRILES_INTRO_MENU',
        customReplies: buildBarrilesUnknownFlavorGateReplies(),
        flowProgress: true
      };
    }

    return { success: false };
  }
});
