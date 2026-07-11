// ==============================================================================
// OBJETIVO: Convertir la definición de un estado en el objeto que usa engine.js.
// Dos modos:
//   1) def.validateAndProcess ya viene → solo normaliza promptQuestion / aiPrompt
//   2) type: 'menu' + validators[] → arma validateAndProcess recorriendo validadores
// ==============================================================================
import { ACTIONS } from './actions/index.js';
import { VALIDATORS, getKeywordRules } from './validators/index.js';
import { resolveDecisionIntent } from './decision-intent.js';

/**
 * resolvePromptQuestion: texts puede ser string, array, o función (session).
 *
 * @param {object} def - Definición del estado
 * @returns {Function|string|string[]}
 */
function resolvePromptQuestion(def) {
  if (typeof def.promptQuestion === 'function' || typeof def.promptQuestion === 'string'
      || Array.isArray(def.promptQuestion)) {
    return def.promptQuestion;
  }
  if (typeof def.texts === 'function') return def.texts;
  if (def.texts != null) return () => def.texts;
  return () => '';
}

/**
 * applyActionResult: Si onMatch tiene action, la ejecuta y mezcla con next/mute.
 *
 * @param {object} onMatch - Config de coincidencia
 * @param {object} ctx - { messageText, session, shortQuestion }
 * @returns {Promise<object|null>}
 */
async function applyActionResult(onMatch, ctx) {
  if (!onMatch) return null;

  // Delegar a otro estado (ej. filtro → recogida productos)
  if (onMatch.delegateTo) {
    const getState = onMatch.getDelegateState;
    if (typeof getState !== 'function') {
      console.error('[compile-state] delegateTo sin getDelegateState');
      return { success: false };
    }
    const target = getState();
    if (!target?.validateAndProcess) return { success: false };
    // Asegurar carrito desechable si venimos del filtro barriles
    if (onMatch.ensureDesechableCart && ctx.session) {
      if (!ctx.session.orderBuilder || ctx.session.orderBuilder.type !== 'desechable') {
        ctx.session.orderBuilder = {
          type: 'desechable',
          products: {},
          extras: {},
          clientData: { name: null, date: null, location: null }
        };
      }
    }
    return target.validateAndProcess(ctx.messageText, ctx.session);
  }

  if (onMatch.action && typeof ACTIONS[onMatch.action] === 'function') {
    const fromAction = await ACTIONS[onMatch.action](ctx, ctx.session);
    return { ...fromAction, ...(onMatch.next ? { nextState: onMatch.next } : {}), ...(onMatch.mute != null ? { mute: onMatch.mute } : {}) };
  }

  const result = { success: true };
  if (onMatch.next) result.nextState = onMatch.next;
  if (onMatch.mute) result.mute = true;
  if (onMatch.customReply) result.customReply = onMatch.customReply;
  if (onMatch.customReplies) result.customReplies = onMatch.customReplies;
  if (onMatch.notifyAdmin) result.notifyAdmin = onMatch.notifyAdmin;
  if (onMatch.reply) result.customReply = onMatch.reply;
  if (onMatch.replies) result.customReplies = onMatch.replies;
  return result;
}

/**
 * runMenuValidators: Recorre validators en orden; primera coincidencia gana.
 *
 * @param {Array<object>} validators
 * @param {string} messageText
 * @param {object} session
 * @param {object} def
 * @returns {Promise<object>}
 */
async function runMenuValidators(validators, messageText, session, def) {
  const ctx = {
    messageText,
    session,
    shortQuestion: typeof def.shortQuestion === 'function'
      ? def.shortQuestion(session)
      : def.shortQuestion
  };

  for (const step of validators || []) {
    if (!step) continue;

    // Validador custom: test(message, session) → truthy
    if (typeof step.test === 'function') {
      const hit = await step.test(messageText, session);
      if (hit) {
        if (typeof step.onMatch === 'function') return step.onMatch(messageText, session, hit);
        return applyActionResult(step.onMatch, ctx);
      }
      continue;
    }

    // Validador por nombre en VALIDATORS (boolean)
    if (step.use && typeof VALIDATORS[step.use] === 'function' && step.use !== 'matchKeywordsByName') {
      const fn = VALIDATORS[step.use];
      // wantsBrowseOnlyClose: no tratar "no" solo como mirón en filtro canal
      if (step.use === 'wantsBrowseOnlyClose') {
        if (/^(no|nop|nope|nah)$/i.test(String(messageText || '').trim())) continue;
      }
      if (fn(messageText)) {
        if (typeof step.onMatch === 'function') return step.onMatch(messageText, session);
        return applyActionResult(step.onMatch, ctx);
      }
      continue;
    }

    // Keywords + NLU (resolveDecisionIntent)
    if (step.use === 'matchKeywords' || step.decisionIntent) {
      const rulesName = step.rules;
      const keywordRules = typeof step.keywordRules === 'function'
        ? step.keywordRules(session)
        : (rulesName ? getKeywordRules(rulesName, step.rulesArg) : step.keywordRules);
      const intent = await resolveDecisionIntent({
        messageText,
        session,
        stepQuestion: ctx.shortQuestion || '',
        allowedLabels: step.allowedLabels || [],
        keywordRules: keywordRules || [],
        labelHints: step.labelHints || {}
      });
      if (intent && step.on && step.on[intent]) {
        const branch = step.on[intent];
        if (typeof branch === 'function') return branch(messageText, session);
        return applyActionResult(branch, ctx);
      }
    }
  }

  return { success: false };
}

/**
 * compileState: Arma el objeto estado que espera engine.js.
 *
 * @param {object} def - Definición del paso
 * @returns {{ id: string, promptQuestion: *, shortQuestion: *, aiContextPrompt: *, validateAndProcess: Function }}
 */
export function compileState(def) {
  if (!def?.id) {
    throw new Error('[compile-state] Falta def.id');
  }

  const state = {
    id: def.id,
    promptQuestion: resolvePromptQuestion(def),
    shortQuestion: def.shortQuestion ?? '',
    aiContextPrompt: def.aiPrompt ?? def.aiContextPrompt ?? null
  };

  // Modo 1: handler completo ya escrito (pasos complejos o menús con lógica custom)
  if (typeof def.validateAndProcess === 'function') {
    state.validateAndProcess = def.validateAndProcess.bind(def);
    return state;
  }

  // Modo 2: menú declarativo
  if (def.type === 'menu' && Array.isArray(def.validators)) {
    state.validateAndProcess = async (messageText, session) =>
      runMenuValidators(def.validators, messageText, session, def);
    return state;
  }

  throw new Error(`[compile-state] Estado ${def.id}: falta validateAndProcess o type:menu + validators`);
}

/**
 * defineState: Atajo didáctico — igual que compileState cuando ya traes el handler.
 * Sirve para que el archivo del estado se lea como “definición completa”.
 *
 * @param {object} def
 * @returns {object}
 */
export function defineState(def) {
  return compileState(def);
}
