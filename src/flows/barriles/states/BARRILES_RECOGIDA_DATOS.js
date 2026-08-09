// ==============================================================================
// OBJETIVO: Checkout de PEDIDO Barriles — datos uno por uno (no cotización).
// Orden: comuna → fecha → nombre/apellido → email → dirección → confirmar compra.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { findLocationByFuzzyMatch, parseDate } from '../../../logic/utils.js';
import { withAssistantFooter } from '../../../logic/flow-rails.js';
import {
  normalizeBotDateText,
  evaluateDeliveryLeadTime
} from '../../../logic/cot-event-quote.js';
import {
  ensureClientDataBucket,
  ensureContactBucket,
  applyContactFromMessage,
  applyAddressFromMessage,
  resolveBarrilesPedidoPhase,
  formatBarrilesShippingNote,
  askBarrilesPedidoPhase,
  buildBarrilesPedidoIntro,
  tryApplyBarrilesPedidoPriorCorrection,
  parseEmailFromText,
  getEmailTypoSuggestion,
  looksLikeStreetAddress,
  getMissingDeliveryAddress
} from '../../../logic/cot-barriles-contact.js';
import { getBarrilesPurchaseSummary } from '../../../views/templates.js';

const AI_PROMPT = `[SISTEMA - ESTADO: PEDIDO BARRILES (datos uno a uno)]
El cliente está armando un *pedido* de Barriles Desechables (no una cotización).
Fases: comuna → fecha → nombre/apellido → email → dirección → confirmación.
1. Pide SOLO el dato de la fase actual. No inventes tarifas de despacho.
2. RM: despacho con precio de datos.json. Otras regiones: Blue Express / por confirmar.
3. Fecha: mínimo 2 días; si es antes, avisa que hay que confirmar disponibilidad.
4. Si corrige un dato anterior (ej. fecha mientras pedimos nombre), acéptalo y vuelve a pedir la fase actual.
5. Al final, el resumen pide *OK* o corregir un dato.`;

/**
 * shortQuestionForPhase: Re-pregunta corta según la fase pendiente.
 *
 * @param {object} session
 * @returns {string}
 */
function shortQuestionForPhase(session) {
  const phase = session.barrilesPedidoPhase || resolveBarrilesPedidoPhase(session);
  return withAssistantFooter(askBarrilesPedidoPhase(phase, session));
}

/**
 * goConfirm: Pasa a CONFIRMAR_COMPRA con el resumen del pedido.
 *
 * @param {object} session
 * @returns {object}
 */
function goConfirm(session) {
  session.barrilesPedidoPhase = 'confirm';
  return {
    success: true,
    nextState: 'BARRILES_CONFIRMAR_COMPRA',
    customReplies: getBarrilesPurchaseSummary(session),
    flowProgress: true
  };
}

/**
 * advanceAfterSave: Recalcula fase y pregunta lo siguiente (o confirma).
 *
 * @param {object} session
 * @param {string} [prefix] - Texto previo (ej. nota de despacho / aviso fecha)
 * @returns {object}
 */
function advanceAfterSave(session, prefix = '') {
  const phase = resolveBarrilesPedidoPhase(session);
  session.barrilesPedidoPhase = phase;
  if (phase === 'confirm') return goConfirm(session);
  const ask = askBarrilesPedidoPhase(phase, session);
  return {
    success: true,
    nextState: 'BARRILES_RECOGIDA_DATOS',
    customReply: prefix ? `${prefix}\n\n${ask}` : ask,
    flowProgress: true
  };
}

export const BARRILES_RECOGIDA_DATOS = defineState({
  id: 'BARRILES_RECOGIDA_DATOS',
  texts: (session) => [buildBarrilesPedidoIntro(session)],
  shortQuestion: (session) => shortQuestionForPhase(session),
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Sesión sin carrito → volver a productos
    if (!session.orderBuilder || session.orderBuilder.type !== 'desechable') {
      session.orderBuilder = {
        type: 'desechable',
        products: {},
        extras: {},
        clientData: { name: null, date: null, location: null }
      };
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
        customReply: `Primero elijamos los cócteles 🙂

*¿Qué sabor y cuántos barriles quieres?*
_(ej: 1 mojito)_`
      };
    }

    ensureClientDataBucket(session);
    ensureContactBucket(session);

    const phase = session.barrilesPedidoPhase || resolveBarrilesPedidoPhase(session);
    session.barrilesPedidoPhase = phase;
    const trimmed = String(messageText || '').trim();

    // Corrección del paso anterior (ej. "me equivoqué, es para el 13 de agosto"
    // mientras pedimos nombre): actualiza ese dato y re-pide la fase actual.
    const priorFix = tryApplyBarrilesPedidoPriorCorrection(trimmed, session, phase);
    if (priorFix) {
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_DATOS',
        customReply: `${priorFix.ack}\n\n${askBarrilesPedidoPhase(phase, session)}`,
        flowProgress: true
      };
    }

    // ------------------------------------------------------------------
    // COMUNA
    // ------------------------------------------------------------------
    if (phase === 'comuna') {
      const locationSearch = findLocationByFuzzyMatch(trimmed);
      if (!locationSearch) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `No reconocí esa comuna 😅

${askBarrilesPedidoPhase('comuna', session)}`,
          flowProgress: true
        };
      }
      session.orderBuilder.clientData.location = locationSearch.name;
      session.orderBuilder.clientData.locationData = locationSearch;
      session.location = locationSearch.name;
      const note = formatBarrilesShippingNote(locationSearch);
      return advanceAfterSave(session, `Perfecto.\n${note}`);
    }

    // ------------------------------------------------------------------
    // FECHA (mínimo 2 días; si es menos → aviso de disponibilidad)
    // ------------------------------------------------------------------
    if (phase === 'fecha') {
      const rawDate = parseDate(trimmed);
      if (!rawDate) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `Necesito un día concreto 🙂

${askBarrilesPedidoPhase('fecha', session)}`,
          flowProgress: true
        };
      }
      const normalized = normalizeBotDateText(rawDate) || rawDate;
      const lead = evaluateDeliveryLeadTime(normalized, 2);
      if (!lead.ok) {
        const why = lead.reason === 'past'
          ? 'Esa fecha ya pasó.'
          : 'No pude leer bien la fecha.';
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `${why}

${askBarrilesPedidoPhase('fecha', session)}`,
          flowProgress: true
        };
      }
      session.orderBuilder.clientData.date = normalized;
      session.date = normalized;
      session.barrilesDateNeedsAvailabilityConfirm = Boolean(lead.tooSoon);
      const aviso = lead.tooSoon
        ? `Anoté *${normalized}*. Como es con menos de *2 días* de anticipación, debemos *confirmar disponibilidad* 🙏`
        : `Anoté entrega para *${normalized}* ✅`;
      return advanceAfterSave(session, aviso);
    }

    // ------------------------------------------------------------------
    // NOMBRE Y APELLIDO
    // ------------------------------------------------------------------
    if (phase === 'nombre') {
      applyContactFromMessage(trimmed, session);
      const c = session.contact || {};
      if (!String(c.firstName || '').trim() || !String(c.lastName || '').trim()) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `Necesito *nombre y apellido* 🙂

${askBarrilesPedidoPhase('nombre', session)}`,
          flowProgress: true
        };
      }
      return advanceAfterSave(session);
    }

    // ------------------------------------------------------------------
    // EMAIL
    // ------------------------------------------------------------------
    if (phase === 'email') {
      const typo = getEmailTypoSuggestion(trimmed);
      if (typo) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `Ese correo parece tener un typo (¿quisiste decir *${typo.suggestion}*?).

${askBarrilesPedidoPhase('email', session)}`,
          flowProgress: true
        };
      }
      const email = parseEmailFromText(trimmed);
      if (!email) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `Necesito un email válido 🙂

${askBarrilesPedidoPhase('email', session)}`,
          flowProgress: true
        };
      }
      session.contact.email = email;
      return advanceAfterSave(session);
    }

    // ------------------------------------------------------------------
    // DIRECCIÓN (requerida por la API de compra)
    // ------------------------------------------------------------------
    if (phase === 'direccion') {
      applyAddressFromMessage(trimmed, session);
      if (getMissingDeliveryAddress(session)) {
        // Si no parecía dirección, igual intentamos guardar el texto si es razonable
        if (looksLikeStreetAddress(trimmed) || trimmed.length >= 5) {
          session.contact.address = trimmed;
        }
      }
      if (getMissingDeliveryAddress(session)) {
        return {
          success: true,
          nextState: 'BARRILES_RECOGIDA_DATOS',
          customReply: `Necesito la *dirección completa* para el despacho 🙂

${askBarrilesPedidoPhase('direccion', session)}`,
          flowProgress: true
        };
      }
      return goConfirm(session);
    }

    // Fase confirm o datos ya completos → resumen
    if (resolveBarrilesPedidoPhase(session) === 'confirm') {
      return goConfirm(session);
    }

    // Fallback: re-sincronizar fase
    session.barrilesPedidoPhase = resolveBarrilesPedidoPhase(session);
    return {
      success: true,
      nextState: 'BARRILES_RECOGIDA_DATOS',
      customReply: askBarrilesPedidoPhase(session.barrilesPedidoPhase, session),
      flowProgress: true
    };
  }
});
