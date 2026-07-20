// ==============================================================================
// OBJETIVO: Barrel del flujo Eventos — junta los estados EVENTOS_* en eventosStates.
// Entrada: RECOGIDA_DATOS → … → INTRO_MENU → ELECCION_MENU → COTIZACION.
// ==============================================================================
import { EVENTOS_RECOGIDA_DATOS } from './states/EVENTOS_RECOGIDA_DATOS.js';
import { EVENTOS_CONFIRMAR_DATOS } from './states/EVENTOS_CONFIRMAR_DATOS.js';
import { EVENTOS_ELECCION_FORMATO } from './states/EVENTOS_ELECCION_FORMATO.js';
import { EVENTOS_INTRO_MENU } from './states/EVENTOS_INTRO_MENU.js';
import { EVENTOS_ELECCION_MENU } from './states/EVENTOS_ELECCION_MENU.js';
import { EVENTOS_COTIZACION } from './states/EVENTOS_COTIZACION.js';

/**
 * eventosStates: Diccionario EVENTOS_* para statesMap.
 */
export const eventosStates = {
  EVENTOS_RECOGIDA_DATOS,
  EVENTOS_CONFIRMAR_DATOS,
  EVENTOS_ELECCION_FORMATO,
  EVENTOS_INTRO_MENU,
  EVENTOS_ELECCION_MENU,
  EVENTOS_COTIZACION
};
