// ==============================================================================
// OBJETIVO: Paso EVENTOS_FILTRO_CANAL — web / aquí / después.
// Primer paso del flujo Eventos: el cliente elige canal o cierra si solo mira.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import { asksPriceOrCatalog, wantsBrowseOnlyClose } from '../../../logic/interruptions.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesEventosFiltroCanal } from '../../../logic/keyword-intent.js';

const SHORT_Q = `¿Prefieres la *web* o *seguimos por aquí*?
(Si solo miras, escribe *después*.)`;

const WELCOME_TEXTS = [
  `👋 *Servicio para Eventos* — estación de coctelería autoservicio para tu celebración.

Tenemos dos formatos:
• *Dispensador Portátil* — instalación gratis, pedido mín. 10L
• *Muro de Coctelería* — instalación $50.000, pedido mín. 30L

Ambos incluyen hielo, garnish, vasos/copas y accesorios de bar.
👉 Arma tu cotización: https://cocktailsontap.cl/eventos`,
  `¿Prefieres cotizar en la *web* o seguimos por *aquí*?

_Si solo estás mirando, escribe *después*._`
];

const AI_PROMPT = `[SISTEMA - ESTADO: FILTRO DE CANAL EVENTOS]
Le preguntaste *web* vs *aquí*. Aún NO eligió canal. Tú NO avances.

REGLAS:
1. NUNCA digas que cotizan por WhatsApp o web si él no eligió.
2. Saludo/ok/gracias: disculpa + re-pregunta con *web* / *aquí* / *después*.
3. Precio: 1-2 frases + link https://cocktailsontap.cl/eventos
4. Cierra: ¿Prefieres la *web* o *seguimos por aquí*?`;

export const EVENTOS_FILTRO_CANAL = defineState({
  id: 'EVENTOS_FILTRO_CANAL',
  texts: WELCOME_TEXTS,
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Mirón / después / no gracias → despedida + mute
    if (wantsBrowseOnlyClose(messageText)
        && !/^(no|nop|nope|nah)$/i.test(String(messageText || '').trim())) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    // Precio/carta sin elegir canal: aún no sabemos Dispensador vs Muro → web + re-pregunta
    if (asksPriceOrCatalog(messageText)) {
      return {
        success: true,
        nextState: 'EVENTOS_FILTRO_CANAL',
        customReply: `Los precios dependen del formato (Dispensador o Muro) 🙂
Puedes ver menú y valores en https://cocktailsontap.cl/eventos

${SHORT_Q}`
      };
    }

    // Keywords → NLU (web / chat / solo mirando)
    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['WEB', 'CHAT', 'SOLO_MIRANDO'],
      keywordRules: rulesEventosFiltroCanal(),
      labelHints: {
        WEB: 'Quiere ir a la página web / link / sitio (cotizar ahí, NO seguir en WhatsApp). Frases: web, link, página, lo veré, lo veo, lo reviso.',
        CHAT: 'Quiere seguir cotizando POR ESTE CHAT / WhatsApp / aquí. NO uses CHAT si solo pregunta precio/valor/cuánto sin elegir canal: eso es UNCLEAR. NO uses CHAT por saludos.',
        SOLO_MIRANDO: 'No quiere seguir ahora: solo mirando, después, no gracias, lo tendré presente, Instagram.'
      }
    });

    if (intent === 'WEB') {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: `¡Listo! Cotiza aquí: https://cocktailsontap.cl/eventos\nSi surge una duda, escríbeme. 🥂`,
        mute: true
      };
    }

    if (intent === 'SOLO_MIRANDO') {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    if (intent === 'CHAT') {
      return { success: true, nextState: 'EVENTOS_RECOGIDA_DATOS' };
    }

    return { success: false };
  }
});
