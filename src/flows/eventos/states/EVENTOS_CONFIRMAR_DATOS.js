// ==============================================================================
// OBJETIVO: Paso EVENTOS_CONFIRMAR_DATOS — resumen + menú 1️⃣ confirmar / 2️⃣ corregir.
// Solo invitados es obligatorio; el resto puede quedar "Por confirmar".
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getEventDataSummary, getEventFormatRecommendation } from '../../../views/templates.js';
import { formatPrice, preciosData } from '../../../logic/utils.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesConfirmarOCorregirDatos } from '../../../logic/keyword-intent.js';
import { applyEventDataFromMessage } from '../../../logic/eventos-helpers.js';
import { img } from '../../../logic/media.js';
import { withAssistantFooter, formatMenuBlock } from '../../../logic/flow-rails.js';

const MENU_BLOCK = formatMenuBlock(['Confirmar', 'Corregir']);

const SHORT_Q = withAssistantFooter(`¿Todo bien?

${MENU_BLOCK}

Si quieres corregir, también puedes escribir el dato directo (ej. _son 80 invitados_).`);

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR DATOS DEL EVENTO]
El cliente ya tiene al menos la cantidad de invitados y recibió un resumen (celebración/fecha/comuna pueden decir "Por confirmar").
Debe escribir *1* Confirmar, *2* Corregir, o el dato nuevo (ej. "son 80 invitados", "es en Providencia").
1. Responde dudas breves sin inventar precios.
2. Si corrige un dato, confirma el cambio y vuelve a pedir confirmación.
3. NUNCA pases a elegir formato Dispensador/Muro hasta que confirme (opción 1 / ok).
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
        customReply: `Para recomendarte el mejor formato (Dispensador o Muro), ¿cuántos *invitados* serán aproximadamente?`
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

    // ¿Confirma con 1️⃣ / ok / sí / dale?
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['CONFIRMAR', 'CORREGIR'],
      keywordRules: rulesConfirmarOCorregirDatos(),
      labelHints: {
        CONFIRMAR: 'Opción 1 / los datos están bien; quiere seguir (1, 1️⃣, ok, sí, dale).',
        CORREGIR: 'Opción 2 / quiere cambiar algún dato pero aún no dijo el valor nuevo (2, 2️⃣, cambiar, modificar).'
      }
    });

    if (intent === 'CONFIRMAR') {
      const instalacionMuro = formatPrice(preciosData.instalacion_muro || 50000);
      // Una sola burbuja: foto + caption con recomendación y menú 1️⃣/2️⃣
      const caption = getEventFormatRecommendation(session.guests, instalacionMuro);
      return {
        success: true,
        nextState: 'EVENTOS_ELECCION_FORMATO',
        customReply: img('eventos_ambas.webp', caption)
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
