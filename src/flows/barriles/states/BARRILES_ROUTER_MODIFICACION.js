// ==============================================================================
// OBJETIVO: Paso BARRILES_ROUTER_MODIFICACION — menú 1️⃣ cócteles / 2️⃣ datos.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';
import {
  resolveBarrilesPedidoPhase,
  buildBarrilesPedidoIntro
} from '../../../logic/cot-barriles-contact.js';
import { getBarrilesPurchaseSummary } from '../../../views/templates.js';

const MENU_BLOCK = formatMenuBlock(['Cambiar cócteles', 'Actualizar datos']);

const SHORT_Q = withAssistantFooter(`*¿Qué deseas cambiar?*

${MENU_BLOCK}`);

const AI_PROMPT = `[SISTEMA - ESTADO: MODIFICAR PEDIDO]
Indica que escriba *1* (cócteles) o *2* (datos). Máximo 2 frases.`;

export const BARRILES_ROUTER_MODIFICACION = defineState({
  id: 'BARRILES_ROUTER_MODIFICACION',
  promptQuestion: () => [
    `*¿Qué deseas cambiar?*

${MENU_BLOCK}`,
    `Escribe *1* o *2* para saber qué necesitas ajustar 🔧`
  ],
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    if (!session.orderBuilder) {
      session.orderBuilder = {
        type: 'desechable',
        products: {},
        extras: {},
        clientData: { name: null, date: null, location: null }
      };
    }

    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['PRODUCTOS', 'DATOS'],
      keywordRules: rulesMenuUnoDos({ labelUno: 'PRODUCTOS', labelDos: 'DATOS' }),
      labelHints: {
        PRODUCTOS: 'Opción 1 / cambiar cócteles del pedido.',
        DATOS: 'Opción 2 / cambiar datos de entrega o contacto del pedido.'
      }
    });

    if (intent === 'PRODUCTOS') {
      const lines = Object.entries(session.orderBuilder.products || {})
        .map(([n, q]) => `- ${q}x ${n}`)
        .join('\n') || '_Vacío_';
      const reply = `Perfecto, volvamos a los cócteles. Actualmente tienes:
${lines}

*¿Qué deseas agregar o eliminar?*
_(ej: agrega 1 mojito o elimina 1 aperol)_`;
      return { success: true, nextState: 'BARRILES_RECOGIDA_PRODUCTOS', customReply: reply };
    }

    if (intent === 'DATOS') {
      // Si ya tiene todo → resumen para corregir con OK; si falta algo → checkout por fases
      const phase = resolveBarrilesPedidoPhase(session);
      if (phase === 'confirm') {
        return {
          success: true,
          nextState: 'BARRILES_CONFIRMAR_COMPRA',
          customReplies: getBarrilesPurchaseSummary(session)
        };
      }
      session.barrilesPedidoPhase = phase;
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_DATOS',
        customReply: buildBarrilesPedidoIntro(session)
      };
    }

    return { success: false };
  }
});
