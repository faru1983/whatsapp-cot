// ==============================================================================
// OBJETIVO: Paso ESPERANDO_INTENCION — entrada: Barriles vs Eventos.
// Textos, prompt IA y router de intención en un solo archivo.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { matchKeywordIntent, rulesRouterIntencion, rulesWebVsChat } from '../../../logic/keyword-intent.js';
import { resolveDecisionIntent } from '../../../logic/decision-intent.js';
import { asksPriceOrCatalog } from '../../../logic/interruptions.js';

const WELCOME = `¡Hola! Somos *Cocktails on Tap* 🍸
Soy un *asistente virtual*: si me respondes con las palabras en *negrita*, te oriento más rápido con precios e info.

¿Buscas *Barriles Desechables* o *Servicio para Eventos*?`;

const SHORT_Q = `Para seguir, ¿buscas *Barriles Desechables* o *Servicio para Eventos*?

_(También puedes escribir *NO* para hablar con una persona.)_`;

/**
 * Respuesta al CTA de Instagram "más información" (mensaje predefinido del anuncio).
 * Presentación corta + menú (el cliente aún no eligió producto).
 */
const AD_INFO_REPLY = `¡Hola! Soy un *asistente virtual* de *Cocktails on Tap* 🍸

¿Buscas *Barriles Desechables* o *Servicio para Eventos*?

_(También puedes escribir *NO* para hablar con una persona.)_`;

const MENSAJE_AMBAS = [
  `🍸 ¡Perfecto! Te doy un resumen de ambos:

🛢️ *Barriles Desechables*
Barriles de *5 litros* que rinden aproximadamente *25 cócteles*, listos para servir en segundos. Disponibles en sabores clásicos como *Mojito*, *Caipiriña*, *Sangría* y otros. Son ideales para disfrutar en casa, celebraciones o regalar.

Puedes adquirilos en nuestra tienda virtual 👉https://cocktailsontap.cl/barriles`,

  `🎉 *Servicio para Eventos*
Montamos una *Estacion de Coctelería Autoservicio* con todo lo necesario para que tus invitados disfruten cócteles listos en segundos. Ideal para matrimonios, cumpleaños, empresas y celebraciones de todo tipo.

Puedes cotizar facilmente en nuestra web 👉https://cocktailsontap.cl/eventos`,

  `¿Prefieres la *web*, o te cuento más de *Barriles Desechables* o *Servicio para Eventos*? 🍹`
];

const PRICE_HINT = `Claro 🙂 Para darte *precios* exactos necesito saber el producto:

• *Barriles Desechables* — desde *$31.990* (5L ≈ 25 cócteles)
• *Servicio para Eventos* — según formato e invitados

¿Cuál te interesa? Escribe *Barriles Desechables* o *Servicio para Eventos*.`;

const PREGUNTA_POST_AMBAS =
  '¿Prefieres revisar la *página web* o quieres que te cuente más sobre *Barriles Desechables* o el *Servicio para Eventos*?';

/**
 * isInstagramInfoCta: ¿Es el CTA genérico de anuncio / “quiero más info”?
 * Keywords: más info, más información, información, info
 * (también con "hola" / "quiero…", típico de Meta).
 * Solo usarlo al inicio (sin userIntent).
 *
 * @param {string} messageText
 * @returns {boolean}
 */
function isInstagramInfoCta(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return false;
  // más info | más información | información | info
  return /\b(?:m[aá]s\s+)?info(?:rmaci[oó]n)?\b/i.test(t);
}

const AI_PROMPT = `[SISTEMA - ESTADO: FILTRO PRINCIPAL]
Eres un asistente virtual de Cocktails on Tap. El cliente aún no eligió camino.
Productos oficiales (nombres exactos):
- *Barriles Desechables*
- *Servicio para Eventos*

Tu tarea:
1. Saludo: breve + pide que responda con las palabras en *negrita*.
2. Si pregunta precios sin elegir producto: 1-2 frases (barriles desde $31.990; eventos según formato) y pide elegir *Barriles Desechables* o *Servicio para Eventos*.
3. Cierra SIEMPRE con: ¿Buscas *Barriles Desechables* o *Servicio para Eventos*?
REGLAS:
- NUNCA digas "para la casa" ni reformules los nombres.
- NUNCA armes cotización completa todavía.
- Tono chileno cordial. Máx. 3 frases + la pregunta.`;

export const ESPERANDO_INTENCION = defineState({
  id: 'ESPERANDO_INTENCION',
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,
  promptQuestion(session) {
    return session.hasAskedAmbas ? SHORT_Q : WELCOME;
  },

  async validateAndProcess(messageText, session) {
    const intent = matchKeywordIntent(messageText, rulesRouterIntencion(), {
      log: true,
      logContext: 'router'
    });

    if (intent === 'BARRILES') {
      session.userIntent = 'BARRILES';
      return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
    }

    if (intent === 'EVENTOS') {
      session.userIntent = 'EVENTOS';
      return { success: true, nextState: 'EVENTOS_RECOGIDA_DATOS' };
    }

    // CTA Instagram "más información" (solo al inicio, sin producto elegido aún).
    // Barriles/Eventos ya se resolvieron arriba si el anuncio venía con esas keywords.
    if (!session.userIntent && isInstagramInfoCta(messageText)) {
      return {
        success: true,
        nextState: 'ESPERANDO_INTENCION',
        customReply: AD_INFO_REPLY
      };
    }

    if (intent === 'AMBAS' && !session.hasAskedAmbas) {
      session.hasAskedAmbas = true;
      return {
        success: true,
        nextState: 'ESPERANDO_INTENCION',
        customReplies: MENSAJE_AMBAS
      };
    }

    if (session.hasAskedAmbas) {
      const postAmbasRules = [
        ...rulesWebVsChat().filter((r) => r.label === 'WEB'),
        ...rulesRouterIntencion().filter((r) => r.label === 'BARRILES' || r.label === 'EVENTOS')
      ];

      const choice = await resolveDecisionIntent({
        messageText,
        session,
        stepQuestion: PREGUNTA_POST_AMBAS,
        allowedLabels: ['WEB', 'BARRILES', 'EVENTOS'],
        keywordRules: postAmbasRules,
        labelHints: {
          WEB: 'Quiere ir a la página web / link / sitio (no seguir cotizando por este chat).',
          BARRILES: 'Quiere saber más o cotizar Barriles Desechables por este chat.',
          EVENTOS: 'Quiere saber más o cotizar Servicio para Eventos por este chat.'
        }
      });

      if (choice === 'WEB') {
        return {
          success: true,
          nextState: 'CERRADO',
          customReply: `¡Perfecto! Si tienes alguna duda me avisas. 🍹`,
          mute: true
        };
      }
      if (choice === 'BARRILES') {
        session.userIntent = 'BARRILES';
        return { success: true, nextState: 'BARRILES_FILTRO_CANAL' };
      }
      if (choice === 'EVENTOS') {
        session.userIntent = 'EVENTOS';
        return { success: true, nextState: 'EVENTOS_RECOGIDA_DATOS' };
      }
    }

    if (asksPriceOrCatalog(messageText)) {
      return {
        success: true,
        nextState: 'ESPERANDO_INTENCION',
        customReply: PRICE_HINT
      };
    }

    return { success: false };
  }
});
