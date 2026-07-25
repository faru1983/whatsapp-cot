// ==============================================================================
// OBJETIVO: Contrato de rieles conversacionales (copy on-miss, handoff, FAQ budget).
// El engine y los estados usan estos helpers para guiar al cliente sin improvisar.
// ==============================================================================

/**
 * HANDOFF_CLIENT_REPLY: Mensaje al cliente cuando el bot pasa a un humano por anti-loop.
 * Siempre hablado (nunca mute silencioso en leads de Meta Ads).
 */
export const HANDOFF_CLIENT_REPLY =
  'Disculpa, mejor te paso con alguien del equipo para ayudarte bien. ¡Ya te escriben! 🙌';

/**
 * ASSISTANT_FOOTER: Pie estándar en cada shortQuestion del flujo.
 */
export const ASSISTANT_FOOTER =
  '_(Soy asistente virtual. Escribe *HUMANO* si quieres una persona.)_';

/**
 * HUMANO_ONLY_FOOTER: Solo el escape a humano (sin repetir identidad virtual).
 */
export const HUMANO_ONLY_FOOTER =
  '_(Escribe *HUMANO* si quieres una persona.)_';

/**
 * withoutAssistantFooter: Quita el pie ASSISTANT_FOOTER del texto.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutAssistantFooter(text) {
  return String(text || '')
    .replace(/\n\n_\(Soy asistente virtual[^_]*\)_\s*$/i, '')
    .trim();
}

/**
 * bodyMentionsAssistant: ¿El cuerpo ya presentó al asistente virtual?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function bodyMentionsAssistant(text) {
  return /asistente virtual/i.test(String(text || ''));
}

/**
 * bodyMentionsHumanoHandoff: ¿Ya hay cue de handoff (HUMANO / NO)?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function bodyMentionsHumanoHandoff(text) {
  return /\b(humano|escribe \*no\*)\b/i.test(String(text || ''));
}

/**
 * stepQuestionAfterIdentityBody: Une cuerpo + pregunta del paso sin repetir identidad.
 * Si el cuerpo ya dice "asistente virtual", quita ese pie del shortQuestion y deja solo HUMANO.
 *
 * @param {string} body - Intro o párrafo previo
 * @param {string} stepQuestion - shortQuestion (puede llevar ASSISTANT_FOOTER)
 * @returns {string}
 */
export function stepQuestionAfterIdentityBody(body, stepQuestion) {
  const intro = String(body || '').trim();
  let question = String(stepQuestion || '').trim();
  if (!intro) return question;
  if (!question) return intro;

  if (bodyMentionsAssistant(intro)) {
    question = withoutAssistantFooter(question);
  }

  let out = `${intro}\n\n${question}`;
  if (bodyMentionsAssistant(intro) && !bodyMentionsHumanoHandoff(out)) {
    out += `\n\n${HUMANO_ONLY_FOOTER}`;
  }
  return out;
}

/**
 * withAssistantFooter: Añade el pie de asistente virtual si aún no está en el texto.
 *
 * @param {string} question - Pregunta corta del paso
 * @returns {string}
 */
export function withAssistantFooter(question) {
  const q = String(question || '').trim();
  if (!q) return ASSISTANT_FOOTER;
  if (/asistente virtual/i.test(q) && /humano/i.test(q)) return q;
  return `${q}\n\n${ASSISTANT_FOOTER}`;
}

/**
 * getOnMissHint: Una frase fija que recuerda el dato pendiente antes de re-preguntar.
 *
 * @param {string} stateId - Estado actual
 * @param {object} session - Sesión del cliente
 * @param {string|null} pendingKey - Clave de getPendingFlowRequirement
 * @returns {string|null}
 */
export function getOnMissHint(stateId, session, pendingKey = null) {
  const key = pendingKey;
  const hints = {
    intent: 'Para seguir, elige *Barriles Desechables* o *Servicio para Eventos*.',
    guests: 'Para cotizar necesito el *número de invitados* (ej. _50 personas_).',
    confirm: 'Revisa los datos y responde *ok* si están correctos, o dime qué corregir.',
    delivery: 'Necesito *fecha* y *comuna* de entrega para continuar.',
    products: 'Dime *qué sabor* y *cuántos* barriles (ej. _2 mojitos_), o escribe *lista*.',
    format: 'Elige *Dispensador Portátil* o *Muro de Coctelería* para seguir.',
    continue: 'Escribe *ok* cuando quieras ver la carta y precios.',
    cart: 'Indica los cócteles con litraje (ej. _Mojito 10L_) o escribe *lista*.',
    confirm_quote: '¿Te parece bien la cotización? Escribe *ok* para confirmar o dime qué cambiar.',
    mod_choice: 'Responde *1* para cambiar cócteles o *2* para cambiar fecha/comuna.',
    client_data: 'Necesito *fecha* y *comuna* de entrega para armar la cotización.'
  };

  if (key && hints[key]) return hints[key];

  // Refinamiento por estado si hace falta
  if (stateId === 'BARRILES_FILTRO_CANAL') {
    const cd = session.orderBuilder?.clientData;
    if (cd?.location && !cd?.date) return 'Ya tengo la comuna. ¿Cuál es la *fecha* de entrega?';
    if (cd?.date && !cd?.location) return 'Ya tengo la fecha. ¿Cuál es la *comuna* de entrega?';
  }

  return null;
}

/**
 * normalizeHintCompare: Texto comparable para detectar preguntas duplicadas.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeHintCompare(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_~`?.!¿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * hintOverlapsQuestion: true si el hint on-miss ya está cubierto por shortQuestion.
 * Evita pegar dos veces "elige Barriles o Eventos", "invitados", fecha+comuna, etc.
 *
 * @param {string} hint
 * @param {string} question
 * @returns {boolean}
 */
function hintOverlapsQuestion(hint, question) {
  const nh = normalizeHintCompare(hint);
  const nq = normalizeHintCompare(question);
  if (!nh || !nq) return false;
  if (nq.includes(nh) || nh.includes(nq)) return true;

  const pairs = [
    [/barriles?\s*desechables?|servicio\s+para\s+eventos/, /barriles?\s*desechables?|servicio\s+para\s+eventos/],
    [/invitados?/, /invitados?/],
    [/fecha/, /fecha/],
    [/comuna/, /comuna/],
    [/dispensador|muro/, /dispensador|muro/],
    [/cotizaci[oó]n/, /cotizaci[oó]n/],
    [/\bok\b|confirmar/, /\bok\b|confirmar/]
  ];

  for (const [hintRe, qRe] of pairs) {
    if (hintRe.test(nh) && qRe.test(nq)) return true;
  }

  const core = nh.replace(/^para seguir,?\s*/, '').slice(0, 35);
  return core.length >= 12 && nq.includes(core.slice(0, 20));
}

/**
 * buildGuidedStepQuestion: Une hint on-miss + shortQuestion sin repetir el mismo pedido.
 *
 * @param {string|null|undefined} shortQuestion - Pregunta del paso (con footer si aplica)
 * @param {string|null|undefined} onMissHint - Frase fija del dato pendiente
 * @returns {string}
 */
export function buildGuidedStepQuestion(shortQuestion, onMissHint) {
  const q = String(shortQuestion || '').trim();
  const hint = String(onMissHint || '').trim();
  if (!hint) return q;
  if (!q) return hint;
  if (hintOverlapsQuestion(hint, q)) return q;
  return `${hint}\n\n${q}`;
}

/**
 * getFaqSidequestCount: Cuántas veces ya usamos FAQ con este dato pendiente.
 *
 * @param {object} session
 * @param {string} pendingKey
 * @returns {number}
 */
export function getFaqSidequestCount(session, pendingKey) {
  if (!pendingKey || !session?.faqSidequestByPending) return 0;
  return Number(session.faqSidequestByPending[pendingKey] || 0);
}

/**
 * incrementFaqSidequest: Suma 1 al presupuesto FAQ del dato pendiente.
 *
 * @param {object} session
 * @param {string} pendingKey
 */
export function incrementFaqSidequest(session, pendingKey) {
  if (!pendingKey) return;
  if (!session.faqSidequestByPending) session.faqSidequestByPending = {};
  session.faqSidequestByPending[pendingKey] =
    (session.faqSidequestByPending[pendingKey] || 0) + 1;
}

/**
 * canUseFaqSidequest: ¿Podemos responder una duda con FAQ sin bloquear el paso?
 * Máximo 1 FAQ por clave de dato pendiente.
 *
 * @param {object} session
 * @param {string|null} pendingKey
 * @returns {boolean}
 */
export function canUseFaqSidequest(session, pendingKey) {
  if (!pendingKey) return true;
  return getFaqSidequestCount(session, pendingKey) < 1;
}
