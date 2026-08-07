// ==============================================================================
// OBJETIVO: Paso ESPERANDO_INTENCION — router determinístico de entrada.
// Solo abre Eventos o Barriles con reglas claras; un segundo miss hace SOS silencioso.
// CRM: Curioso en welcome (sin intent); al elegir Eventos/Barriles se parchea intent en el mismo stage.
// Interesado Eventos al confirmar datos→formato; Barriles al elegir cotizar en intro.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { matchKeywordIntent, rulesRouterIntencion } from '../../../logic/keyword-intent.js';
import { buildAdminSosBody } from '../../../views/templates.js';
import {
  withAssistantFooter,
  formatMenuBlock,
  MENU_WRITE_CONTINUE_CTA
} from '../../../logic/flow-rails.js';
import { syncCrmCuriousAsync, syncCrmIntentAsync } from '../../../logic/cot-crm-sync.js';

/** Menú principal (1️⃣ Eventos / 2️⃣ Barriles / 3️⃣ Humano). */
const MENU_BLOCK = formatMenuBlock([
  'Servicio para Eventos',
  'Barriles Desechables',
  'Hablar con Humano'
]);

const WELCOME = `¡Hola! Soy el *asistente virtual* de *Cocktails on Tap* 🍸

Cuéntame si te ayudo a cotizar nuestro *Servicio para Eventos*
o si te interesa comprar *Barriles Desechables*.

${MENU_WRITE_CONTINUE_CTA}
${MENU_BLOCK}`;

const SHORT_Q = withAssistantFooter(`${MENU_WRITE_CONTINUE_CTA}
${MENU_BLOCK}`);

/**
 * handoffHumanoResult: Cierra el chat y pide asistencia humana (opción 3️⃣).
 *
 * @param {object} [session]
 * @returns {object}
 */
function handoffHumanoResult(session) {
  if (session) syncCrmCuriousAsync(session);
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
 * @param {object} session
 * @param {string} messageText - Segunda respuesta no reconocida
 * @returns {object}
 */
function silentInvalidChoiceResult(session, messageText) {
  syncCrmCuriousAsync(session);
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
      return handoffHumanoResult(session);
    }

    if (choice === 'BARRILES') {
      session.userIntent = 'BARRILES';
      session.crmIntentSynced = false;
      syncCrmIntentAsync(session);
      return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
    }

    if (choice === 'EVENTOS') {
      session.userIntent = 'EVENTOS';
      session.crmIntentSynced = false;
      syncCrmIntentAsync(session);
      return { success: true, nextState: 'EVENTOS_RECOGIDA_DATOS' };
    }

    // Si el menú ya fue mostrado y tampoco eligió ahora, hacemos un SOS
    // silencioso: mute + administrador, sin enviar otra burbuja al cliente.
    if (session.routerMenuShown) {
      return silentInvalidChoiceResult(session, messageText);
    }

    // Primer mensaje no reconocido: menú de bienvenida (presenta al asistente aquí).
    // Eventos/Barriles ya no repiten esa presentación en su copy de entrada.
    // CRM Curioso: sin intent aún (no eligió carril).
    session.routerMenuShown = true;
    session.assistantIntroduced = true;
    syncCrmCuriousAsync(session);
    return {
      success: true,
      nextState: 'ESPERANDO_INTENCION',
      customReply: WELCOME
    };
  }
});
