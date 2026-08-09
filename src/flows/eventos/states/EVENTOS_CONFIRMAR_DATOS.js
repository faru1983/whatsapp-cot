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
import { eventosIntroMenuQuestion } from '../../../logic/eventos-intro.js';

const MENU_BLOCK = formatMenuBlock(['Confirmar', 'Corregir']);

const SHORT_Q = withAssistantFooter(`*¿Todo bien?*

${MENU_BLOCK}

_(ej: son 80 invitados)_`);

const AI_PROMPT = `[SISTEMA - ESTADO: CONFIRMAR DATOS DEL EVENTO]
Paso de compatibilidad. El cliente tiene invitados (y quizá formato ya elegido).
1. Si corrige un dato (invitados, comuna, fecha), confirma y vuelve a pedir OK.
2. Si confirma y YA tiene formato (Dispensador/Muro), sigue al menú cotizar/duda — NO vuelvas a pedir formato.
3. Si confirma y AÚN NO tiene formato, ahí sí ofrece Dispensador/Muro.
4. No inventes precios.`;

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
      // Red de seguridad: si ya eligió formato (happy path), no reiniciar a ELECCION_FORMATO
      if (session.eventoFormato) {
        return {
          success: true,
          nextState: 'EVENTOS_INTRO_MENU',
          customReplies: [
            `Perfecto ✅ Seguimos con tu *${session.eventoFormato}*.`,
            eventosIntroMenuQuestion()
          ],
          flowProgress: true
        };
      }

      const instalacionMuro = formatPrice(preciosData.instalacion_muro || 50000);
      // Legacy: datos antes que formato → menú Dispensador/Muro
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
        customReply: `Claro.

*¿Qué dato quieres cambiar?*
_(ej: son 80 invitados, es en Providencia o 15 de mayo)_`
      };
    }

    return { success: false };
  }
});
