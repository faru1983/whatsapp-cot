// ==============================================================================
// OBJETIVO: Paso BARRILES_FILTRO_CANAL — web / aquí / después.
// Todo el paso en un archivo: textos, prompt IA y lógica de decisión.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { img } from '../../../logic/media.js';
import { hasDrinkSelection } from '../../../logic/utils.js';
import {
  asksPriceOrCatalog,
  findMentionedCocktail,
  formatDesechablePriceReply,
  wantsBrowseOnlyClose
} from '../../../logic/interruptions.js';
import { getBrowseOnlyGoodbye } from '../../../views/templates.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { rulesBarrilesFiltroCanal } from '../../../logic/keyword-intent.js';
import { BARRILES_RECOGIDA_PRODUCTOS } from './BARRILES_RECOGIDA_PRODUCTOS.js';

const SHORT_Q = `¿Prefieres la *web* o te ayudo por *aquí*?
(Si solo miras, escribe *después*.)`;

const WELCOME_TEXTS = [
  `👋 *Barriles Desechables* listos para servir:
• 5 litros ≈ *25 cócteles*
• Se conservan refrigerados (+3 semanas)
• Desde *$31.990* (según sabor)

📍 Despacho en toda la RM y a regiones por encomienda.
🔗 Sabores y Precios: *www.cocktailsontap.cl/barriles*`,
  `¿Prefieres revisar la *web*, o que te envíe los precios por *aquí*?

_Si solo estás mirando, escribe *después* y no te vuelvo a molestar._`
];

const AI_PROMPT = `[SISTEMA - ESTADO: FILTRO DE CANAL BARRILES]
Le preguntaste *web* vs *aquí*. Aún NO eligió canal. Tú NO avances el flujo.

REGLAS:
1. NUNCA digas que seguimos por WhatsApp ni que lo mandas a la web si él no eligió.
2. Saludo/entusiasmo: disculpa breve + re-pregunta con *web* / *aquí* / *después*.
3. Precio/valor: 1-2 frases útiles (desde *$31.990*, 5L ≈ 25 cócteles) o el cóctel si lo nombró. NO pegues catálogo entero.
4. Cierra con: ¿Prefieres la *web* o te ayudo por *aquí*?`;

/**
 * ensureDesechableCart: Inicializa orderBuilder tipo desechable si falta.
 * @param {object} session
 */
function ensureDesechableCart(session) {
  if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
    session.orderBuilder = {
      type: 'desechable',
      products: {},
      extras: {},
      clientData: { name: null, date: null, location: null }
    };
  }
}

export const BARRILES_FILTRO_CANAL = defineState({
  id: 'BARRILES_FILTRO_CANAL',
  texts: WELCOME_TEXTS,
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    if (wantsBrowseOnlyClose(messageText)
        && !/^(no|nop|nope|nah)$/i.test(String(messageText || '').trim())) {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: getBrowseOnlyGoodbye(),
        mute: true
      };
    }

    if (asksPriceOrCatalog(messageText)) {
      const cocktail = findMentionedCocktail(messageText);
      const priceLine = cocktail ? formatDesechablePriceReply(cocktail) : null;
      if (priceLine) {
        return {
          success: true,
          nextState: 'BARRILES_FILTRO_CANAL',
          customReply: `${priceLine}\n\n${SHORT_Q}`
        };
      }
      return {
        success: true,
        nextState: 'BARRILES_FILTRO_CANAL',
        customReplies: [img('barril_desechable_precios.webp'), SHORT_Q]
      };
    }

    if (hasDrinkSelection(messageText)) {
      ensureDesechableCart(session);
      return BARRILES_RECOGIDA_PRODUCTOS.validateAndProcess(messageText, session);
    }

    const intent = await resolveDecisionIntent({
      messageText,
      session,
      stepQuestion: SHORT_Q,
      allowedLabels: ['WEB', 'CHAT', 'SOLO_MIRANDO'],
      keywordRules: rulesBarrilesFiltroCanal(),
      labelHints: {
        WEB: 'Quiere ir a la página web / link / sitio (comprar o mirar ahí, NO seguir en WhatsApp). Frases: web, link, página, meterme a ver, entrar al sitio, ver directamente en la web, lo veré, lo veo, lo reviso.',
        CHAT: 'Quiere que le ayuden POR ESTE CHAT / WhatsApp / aquí (acá, por aquí, cuéntame, sigamos, ayúdame). NO uses CHAT si solo pregunta precio/valor/cuánto sin elegir canal: eso es UNCLEAR. NO uses CHAT por saludos o "qué genial".',
        SOLO_MIRANDO: 'No quiere seguir ahora: solo está mirando, después, no gracias, lo tendré presente, para agosto, Instagram. NO uses SOLO_MIRANDO si eligió web o WhatsApp.'
      }
    });

    if (intent === 'WEB') {
      return {
        success: true,
        nextState: 'CERRADO',
        customReply: `Perfecto 😊
En la *web* encuentras sabores, fotos y precios, y puedes comprar cuando quieras:
👉 https://cocktailsontap.cl/barriles

¡Gracias por tu interés!`,
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
      ensureDesechableCart(session);
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReplies: [
          img('barril_desechable_precios.webp', 'Aquí va la lista de sabores y precios 👆'),
          `Cuando la revises, dime *qué sabor* y *cuántos* barriles quieres.
Ejemplo: *1 mojito y 1 sangría*`
        ]
      };
    }

    return { success: false };
  }
});
