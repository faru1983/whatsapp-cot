// ==============================================================================
// OBJETIVO: Paso BARRILES_ROUTER_MODIFICACION — menú 1 cócteles / 2 datos.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesMenuUnoDos } from '../../../logic/keyword-intent.js';

const SHORT_Q = `¿Responde 1 para cócteles o 2 para datos?`;

const AI_PROMPT = `[SISTEMA - ESTADO: MODIFICAR PEDIDO]
Indica responder *1* (cócteles) o *2* (datos). Máximo 2 frases.`;

export const BARRILES_ROUTER_MODIFICACION = defineState({
  id: 'BARRILES_ROUTER_MODIFICACION',
  promptQuestion: () => [
    `Claro, ¿qué deseas cambiar?

1. *Cambiar cócteles* - ¿cuáles deseas en lugar de los actuales?
2. *Actualizar datos* - ¿Fecha o ubicación?`,
    `Responde con 1 o 2 para saber qué necesitas ajustar 🔧`
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
      keywordRules: rulesMenuUnoDos({ labelUno: 'PRODUCTOS', labelDos: 'DATOS' })
    });

    if (intent === 'PRODUCTOS') {
      const lines = Object.entries(session.orderBuilder.products || {})
        .map(([n, q]) => `- ${q}x ${n}`)
        .join('\n') || '_Vacío_';
      const reply = `Perfecto, volvamos a los cócteles. Actualmente tienes:\n${lines}\n\n¿Qué deseas agregar o eliminar? (ej: "agrega 1 mojito" o "elimina 1 aperol")`;
      return { success: true, nextState: 'BARRILES_RECOGIDA_PRODUCTOS', customReply: reply };
    }

    if (intent === 'DATOS') {
      session.orderBuilder.clientData = { name: null, date: null, location: null };
      return { success: true, nextState: 'BARRILES_RECOGIDA_DATOS' };
    }

    return { success: false };
  }
});
