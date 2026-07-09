import { ESPERANDO_INTENCION } from './router.js';
import { barrilesStates } from './barriles.js';
import { eventosStates } from './eventos.js';
import { CERRADO } from './cerrado.js';

// ==============================================================================
// OBJETIVO: Registro central de todos los estados del bot.
// engine.js necesita un solo objeto (statesMap) para buscar cualquier estado
// por su nombre (id). Aquí juntamos el router inicial + barriles + eventos
// + el estado terminal CERRADO.
// ==============================================================================

/**
 * statesMap: Diccionario de estados disponibles.
 * La sintaxis ...barrilesStates "expande" todos los estados de barriles dentro
 * de este objeto, igual que un copiar-pegar de propiedades.
 *
 * Ejemplo de uso en engine.js:
 *   const currentState = statesMap[session.currentState];
 *   const result = await currentState.validateAndProcess(texto, session);
 */
export const statesMap = {
  ESPERANDO_INTENCION,  // Estado inicial (router.js)
  ...barrilesStates,    // BARRILES_* (barriles.js)
  ...eventosStates,     // EVENTOS_* (eventos.js)
  CERRADO               // Estado terminal (mute + customReply ya enviado)
};
