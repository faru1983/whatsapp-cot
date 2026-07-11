// ==============================================================================
// OBJETIVO: Paso BARRILES_RECOGIDA_DATOS — fecha y comuna de entrega.
// ==============================================================================
import { defineState } from '../../../logic/compile-state.js';
import { parseClientName, parseDate, findLocationByFuzzyMatch } from '../../../logic/utils.js';

const AI_PROMPT = `[SISTEMA - ESTADO: DATOS DE DESPACHO]
Faltan fecha y/o comuna para Barriles Desechables.
1. Dudas: transferencias OK; regiones por encomienda. NUNCA inventes tarifas.
2. Cierra pidiendo fecha y comuna. NO menciones extras.`;

export const BARRILES_RECOGIDA_DATOS = defineState({
  id: 'BARRILES_RECOGIDA_DATOS',
  promptQuestion: () => [
    `¡Excelente elección! 🤩 Ya casi terminamos: necesito *fecha* y *comuna* de entrega para calcular despacho.`,
    `Ejemplo: _"Para este sábado en Providencia"_`
  ],
  shortQuestion: `¿Me pasas la *fecha* y *comuna* de entrega?`,
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

    return { success: true, nextState: 'BARRILES_REVISION_COTIZACION' };
  }
});
