// ==============================================================================
// OBJETIVO: Paso BARRILES_RECOGIDA_DATOS — completar/corregir fecha y comuna.
// Red de seguridad: la entrada ya pide estos datos; aquí solo si faltan o se corrigen.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { parseClientName, parseDate, findLocationByFuzzyMatch } from '../../../logic/utils.js';

const SHORT_Q = `¿Me pasas la *fecha* y *comuna* de entrega?
Ejemplo: _"Para este sábado en Providencia"_`;

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE DESPACHO]
Faltan fecha y/o comuna para Barriles Desechables (o el cliente quiere corregirlas).
1. Dudas: transferencias OK; regiones por encomienda. NUNCA inventes tarifas.
2. Cierra pidiendo lo que falte (fecha y/o comuna). NO menciones extras.`;

export const BARRILES_RECOGIDA_DATOS = defineState({
  id: 'BARRILES_RECOGIDA_DATOS',
  promptQuestion: () => [
    `Para armar la cotización con despacho, necesito *fecha* y *comuna* de entrega.`,
    `Ejemplo: _"Para este sábado en Providencia"_`
  ],
  shortQuestion: SHORT_Q,
  aiPrompt: AI_PROMPT,

  async validateAndProcess(messageText, session) {
    // Sesión vieja / corruptas: sin carrito no podemos pedir despacho
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
        customReply: `Primero elijamos los cócteles 🙂\nDime *qué sabor* y *cuántos* (ej. *1 mojito*), o escribe *lista*.`
      };
    }
    if (!session.orderBuilder.clientData) {
      session.orderBuilder.clientData = { name: null, date: null, location: null };
    }

    let hasNewInfo = false;
    let parsedName = parseClientName(messageText) || session.orderBuilder.clientData.name;
    const parsedDate = parseDate(messageText) || session.orderBuilder.clientData.date;
    const locationSearch = findLocationByFuzzyMatch(messageText);

    if (parseClientName(messageText)) hasNewInfo = true;
    if (parseDate(messageText)) hasNewInfo = true;
    if (locationSearch) {
      session.orderBuilder.clientData.location = locationSearch.name;
      session.orderBuilder.clientData.locationData = locationSearch;
      hasNewInfo = true;
    }
    if (parsedName) session.orderBuilder.clientData.name = parsedName;
    if (parsedDate) session.orderBuilder.clientData.date = parsedDate;

    const hasAllData = session.orderBuilder.clientData.date && session.orderBuilder.clientData.location;
    const hasProducts = Object.keys(session.orderBuilder.products || {}).length > 0;

    if (!hasAllData) {
      if (!hasNewInfo) {
        return { success: false };
      }
      const missing = [];
      if (!session.orderBuilder.clientData.date) missing.push('✓ Fecha de entrega');
      if (!session.orderBuilder.clientData.location) missing.push('✓ Comuna/Ciudad');
      return {
        success: true,
        nextState: 'BARRILES_RECOGIDA_DATOS',
        customReply: `Perfecto, recibí parte de tu información. Me falta:\n\n${missing.join('\n')}\n\n¿Puedes compartirlo?`
      };
    }

    // Datos completos: si ya hay cócteles → cotización; si no → catálogo
    if (hasProducts) {
      return { success: true, nextState: 'BARRILES_REVISION_COTIZACION' };
    }
    return {
      success: true,
      nextState: 'BARRILES_RECOGIDA_PRODUCTOS',
      customReply: `Listo 🙂 Ahora dime *qué sabor* y *cuántos* barriles (ej. *1 mojito y 1 sangría*), o escribe *lista*.`
    };
  }
});
