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
 * MENU_KEYCAPS: Emojis numéricos (keycap) para menús de decisión en WhatsApp.
 * El cliente puede responder con el emoji o solo el dígito (1, 2, 3…).
 */
export const MENU_KEYCAPS = {
  1: '1️⃣',
  2: '2️⃣',
  3: '3️⃣',
  4: '4️⃣',
  5: '5️⃣'
};

/**
 * MENU_WRITE_CTA: Antes de un menú numerado — el cliente debe escribir el dígito, no tocar botones.
 */
export const MENU_WRITE_CTA = 'Escribe el número de la opción que prefieres:';

/**
 * MENU_WRITE_CONTINUE_CTA: Variante para el router de entrada.
 */
export const MENU_WRITE_CONTINUE_CTA = 'Escribe el número de la opción para continuar:';

/**
 * MENU_WRITE_REMINDER: Recordatorio en on-miss / fallbacks de pasos con menú numerado.
 */
export const MENU_WRITE_REMINDER =
  'Escribe el número de la opción (1, 2…) o la palabra en *negrita*.';

/**
 * menuKeycap: Devuelve el emoji keycap de una opción (1 → 1️⃣).
 *
 * @param {number} n - Número de opción (1–5)
 * @returns {string}
 */
export function menuKeycap(n) {
  return MENU_KEYCAPS[n] || String(n);
}

/**
 * formatMenuOptionLine: Una línea de menú con emoji + etiqueta en negrita.
 * Ej.: formatMenuOptionLine(1, 'Servicio para Eventos') → "1️⃣ *Servicio para Eventos*"
 *
 * @param {number} n - Número de opción
 * @param {string} label - Texto sin asteriscos
 * @returns {string}
 */
export function formatMenuOptionLine(n, label) {
  const clean = String(label || '').replace(/\*/g, '').trim();
  return `${menuKeycap(n)} *${clean}*`;
}

/**
 * formatMenuBlock: Bloque de varias opciones numeradas con emoji.
 *
 * @param {string[]} labels - Etiquetas en orden (índice 0 = opción 1)
 * @returns {string}
 */
export function formatMenuBlock(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label, i) => formatMenuOptionLine(i + 1, label))
    .join('\n');
}

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
    intent: 'Para seguir, escribe una opción del menú: 1️⃣ *Eventos*, 2️⃣ *Barriles* o 3️⃣ *Humano*.',
    celebration: `*¿Qué tipo de evento estás organizando?*
_(ej: matrimonio, cumpleaños o empresa — o escribe *aún no lo sé*)_`,
    guests: `*¿Cuántos invitados serán aproximadamente?*
_(ej: 50 personas)_`,
    logistics: `*¿Me compartes fecha y comuna?*
_(ej: 15 de mayo, Las Condes — o escribe *después*)_`,
    confirm: 'Revisa los datos: escribe *1* *Confirmar* o *2* *Corregir* (o el dato nuevo).',
    delivery: `*¿Me pasas la fecha y comuna de entrega?*
_(ej: Providencia, 5 de agosto)_`,
    products: `*¿Qué sabor y cuántos barriles quieres?*
_(ej: 2 mojitos — o escribe *lista*)_`,
    format: 'Escribe *1* *Dispensador* o *2* *Muro* para seguir.',
    continue: 'Escribe *1* cuando quieras ver la carta y precios.',
    cart: `*¿Qué cócteles te gustaría incluir?*
_(ej: 5L Mojito)_`,
    confirm_quote: '¿Te parece bien? Escribe *1* *Confirmar* o *2* *Modificar*.',
    contact: `*¿Me compartes nombre, apellido y email?*
_(ej: Ana Pérez, ana@email.com)_`,
    mod_choice: 'Escribe *1* para cambiar cócteles o *2* para cambiar fecha/comuna.',
    client_data: `*¿Me pasas la fecha y comuna de entrega?*
_(ej: Providencia, 5 de agosto)_`
  };

  if (key && hints[key]) return hints[key];

  // Refinamiento por estado si hace falta
  if (stateId === 'BARRILES_FILTRO_CANAL') {
    const cd = session.orderBuilder?.clientData;
    if (cd?.location && !cd?.date) {
      return `*¿Cuál es la fecha de entrega?*
_(ej: 5 de agosto)_`;
    }
    if (cd?.date && !cd?.location) {
      return `*¿Cuál es la comuna de entrega?*
_(ej: Providencia)_`;
    }
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
