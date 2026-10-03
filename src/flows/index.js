import { ESPERANDO_INTENCION } from './router/index.js';
import { barrilesStates } from './barriles/index.js';
import { eventosStates } from './eventos/index.js';
import { operadorStates } from './operador/index.js';
import { CERRADO } from './cerrado.js';

// ==============================================================================
// OBJETIVO: Registro central de todos los estados del bot.
// engine.js busca cualquier estado por id en este objeto (statesMap).
// ==============================================================================

/**
 * statesMap: Diccionario de estados disponibles (23 claves).
 */
export const statesMap = {
  ESPERANDO_INTENCION,
  ...barrilesStates,
  ...eventosStates,
  ...operadorStates,
  CERRADO
};
