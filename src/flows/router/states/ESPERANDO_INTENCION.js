// ==============================================================================
// OBJETIVO: Paso ESPERANDO_INTENCION — router determinístico de entrada.
// Solo abre Eventos o Barriles con reglas claras; un segundo miss hace SOS silencioso.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { matchKeywordIntent, rulesRouterIntencion } from '../../../logic/keyword-intent.js';
import { buildAdminSosBody } from '../../../views/templates.js';
import {
  withAssistantFooter,
  formatMenuBlock
} from '../../../logic/flow-rails.js';

/** Menú principal (1️⃣ Eventos / 2️⃣ Barriles / 3️⃣ Humano). */
const MENU_BLOCK = formatMenuBlock([
  'Servicio para Eventos',
  'Barriles Desechables',
  'Hablar con Humano'
]);

const WELCOME = `¡Hola! Soy el *asistente virtual* de *Cocktails on Tap* 🍸

Cuéntame si te ayudo a cotizar nuestro *Servicio para Eventos*
o si te interesa comprar *Barriles Desechables*.

Selecciona una opción para continuar:
${MENU_BLOCK}`;

const SHORT_Q = withAssistantFooter(`Selecciona una opción para continuar:
${MENU_BLOCK}`);

/**
 * handoffHumanoResult: Cierra el chat y pide asistencia humana (opción 3️⃣).
 *
 * @returns {object}
 */
function handoffHumanoResult() {
  return {
    success: true,
    nextState: 'CERRADO',
    mute: true,
    notifyAdmin: {
      type: 'SOS',
      title: 'PIDIÓ HUMANO',
      body: buildAdminSosBody({
        reason: 'Eligió opción 3 / hablar con humano en el menú de entrada.',
        stateId: 'ESPERANDO_INTENCION'
      })
    },
    customReply: `Te comunico con alguien del equipo. ¡Ya te escriben! 🙌`
  };
}

/**
 * silentInvalidChoiceResult: Silencia el bot cuando el cliente no elige
 * ninguna opción después de haber recibido el menú y alerta al administrador.
 * No incluye customReply: el cliente no recibe otro mensaje automático.
 *
 * @param {string} messageText - Segunda respuesta no reconocida
 * @returns {object}
 */
function silentInvalidChoiceResult(messageText) {
  return {
    success: true,
    nextState: 'CERRADO',
    mute: true,
    notifyAdmin: {
      type: 'SOS',
      title: 'SIN OPCIÓN VÁLIDA',
      body: buildAdminSosBody({
        reason: 'No eligió Eventos, Barriles ni Humano después de recibir el menú.',
        stateId: 'ESPERANDO_INTENCION',
        lastMessage: messageText
      })
    }
  };
}

export const ESPERANDO_INTENCION = defineState({
  id: 'ESPERANDO_INTENCION',
  shortQuestion: SHORT_Q,
  promptQuestion: () => WELCOME,

  async validateAndProcess(messageText, session) {
    // Caja única de entrada: solo reglas locales, sin NLU ni fallback generativo.
    const choice = matchKeywordIntent(messageText, rulesRouterIntencion());

    if (choice === 'HUMANO') {
      return handoffHumanoResult();
    }

    if (choice === 'BARRILES') {
      session.userIntent = 'BARRILES';
      return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
    }

    if (choice === 'EVENTOS') {
      session.userIntent = 'EVENTOS';
      return { success: true, nextState: 'EVENTOS_RECOGIDA_DATOS' };
    }

    // Si el menú ya fue mostrado y tampoco eligió ahora, hacemos un SOS
    // silencioso: mute + administrador, sin enviar otra burbuja al cliente.
    if (session.routerMenuShown) {
      return silentInvalidChoiceResult(messageText);
    }

    // Primer mensaje no reconocido: menú de bienvenida (ya presenta al asistente).
    // Eventos/Barriles usarán un copy más directo si assistantIntroduced=true.
    session.routerMenuShown = true;
    session.assistantIntroduced = true;
    return {
      success: true,
      nextState: 'ESPERANDO_INTENCION',
      customReply: WELCOME
    };
  }
});
