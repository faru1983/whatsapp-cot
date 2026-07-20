// ==============================================================================
// OBJETIVO: Paso EVENTOS_CONFIRMAR_DATOS — resumen + ok / corregir.
// Solo invitados es obligatorio; el resto puede quedar "Por confirmar".
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventDataSummary, getEventFormatRecommendation } from '../../../views/templates.js';
import { formatPrice, preciosData } from '../../../logic/utils.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { applyEventDataFromMessage } from '../../../logic/eventos-helpers.js';
import { img } from '../../../logic/media.js';

const SHORT_Q = `¿Todo bien? Escribe *ok* para continuar o corrige un dato.`;

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR DATOS DEL EVENTO]
El cliente ya tiene al menos la cantidad de invitados y recibió un resumen (celebración/fecha/comuna pueden decir "Por confirmar").
Debe escribir "ok" para seguir, o corregir un dato (ej. "son 80 invitados", "es en Providencia").
1. Responde dudas breves sin inventar precios.
2. Si corrige un dato, confirma el cambio y vuelve a pedir ok.
3. NUNCA pases a elegir formato Dispensador/Muro hasta que confirme con ok (o equivalente).
4. No insistas en datos opcionales que dejó en "Por confirmar".`;

export const EVENTOS_CONFIRMAR_DATOS = defineState({
  id: 'EVENTOS_CONFIRMAR_DATOS',
  promptQuestion: (session) => getEventDataSummary(session),
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Primero: ¿está corrigiendo o agregando un dato? (antes que "ok")
    const hasNewInfo = applyEventDataFromMessage(messageText, session);

    // Si aún no hay invitados (caso raro: borró el dato), volvemos a pedirlos
    if (!session.guests) {
      return {
        success: true,
        nextState: 'EVENTOS_RECOGIDA_DATOS',
        customReply: `Para recomendarte el formato, ¿cuántos *invitados* serán aproximadamente?`
      };
    }

    // Corrigió algo → reenviamos el resumen actualizado (sigue en este estado)
    if (hasNewInfo) {
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_DATOS',
        customReplies: getEventDataSummary(session)
      };
    }

    // ¿Confirma con ok / sí / dale?
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR', 'CORREGIR'],
      keywordRules: rulesConfirmarOCorregirDatos(),
      labelHints: {
        CONFIRMAR: 'Los datos están bien; quiere seguir (ok, sí, dale, correcto, perfecto).',
        CORREGIR: 'Quiere cambiar algún dato pero aún no dijo el valor nuevo (cambiar, modificar, mal).'
      }
    });

    if (intent === 'CONFIRMAR') {
      const instalacionMuro = formatPrice(preciosData.instalacion_muro || 50000);
      // Una sola foto (ambas opciones) con la recomendación de caption; la pregunta va aparte
      const [recomendacion, pregunta] = getEventFormatRecommendation(session.guests, instalacionMuro);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_FORMATO',
        customReplies: [
          img('eventos_ambas.webp', recomendacion),
          pregunta
        ]
      };
    }

    // Quiere corregir pero no dio el dato nuevo → pedimos que lo escriba
    if (intent === 'CORREGIR') {
      return {
        success: true,
        nextState: 'EVENTOS_CONFIRMAR_DATOS',
        customReply: `Claro, ¿qué dato quieres cambiar? Puedes escribirlo directo (ej: "son 80 invitados", "es en Providencia" o "15 de mayo").`
      };
    }

    return { success: false };
  }
});
