import { ESPERANDO_INTENCION } from './router.js';
import { flowAStates } from './barriles.js';
import { flowBStates } from './eventos.js';
import { CERRADO } from './cerrado.js';

// ==============================================================================
// OBJETIVO: Registro central de todos los estados del bot.
// engine.js necesita un solo objeto (statesMap) para buscar cualquier estado
// por su nombre (id). Aquí juntamos el router inicial + flujo A + flujo B
// + el estado terminal CERRADO.
// ==============================================================================

/**
 * statesMap: Diccionario de estados disponibles.
 * La sintaxis ...flowAStates "expande" todos los estados de barriles dentro
 * de este objeto, igual que un copiar-pegar de propiedades.
 *
 * Ejemplo de uso en engine.js:
 *   const currentState = statesMap[session.currentState];
 *   const result = await currentState.validateAndProcess(texto, session);
 */
export const statesMap = {
  ESPERANDO_INTENCION,  // Estado inicial (router.js)
  ...flowAStates,       // Todos los estados A1, A2, A3... (barriles.js)
  ...flowBStates,       // Todos los estados B1, B2, B3... (eventos.js)
  CERRADO               // Estado terminal (mute + customReply ya enviado)
};
