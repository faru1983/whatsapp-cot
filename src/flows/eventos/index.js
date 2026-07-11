// ==============================================================================
// OBJETIVO: Barrel del flujo Eventos — junta los 7 estados en eventosStates.
// ==============================================================================
import { EVENTOS_FILTRO_CANAL } from './states/EVENTOS_FILTRO_CANAL.js';
import { EVENTOS_RECOGIDA_DATOS } from './states/EVENTOS_RECOGIDA_DATOS.js';
import { EVENTOS_CONFIRMAR_DATOS } from './states/EVENTOS_CONFIRMAR_DATOS.js';
import { EVENTOS_ELECCION_FORMATO } from './states/EVENTOS_ELECCION_FORMATO.js';
import { EVENTOS_CONFIRMAR_FORMATO } from './states/EVENTOS_CONFIRMAR_FORMATO.js';
import { EVENTOS_ELECCION_MENU } from './states/EVENTOS_ELECCION_MENU.js';
import { EVENTOS_COTIZACION } from './states/EVENTOS_COTIZACION.js';

/**
 * eventosStates: Diccionario EVENTOS_* para statesMap.
 */
export const eventosStates = {
  EVENTOS_FILTRO_CANAL,
  EVENTOS_RECOGIDA_DATOS,
  EVENTOS_CONFIRMAR_DATOS,
  EVENTOS_ELECCION_FORMATO,
  EVENTOS_CONFIRMAR_FORMATO,
  EVENTOS_ELECCION_MENU,
  EVENTOS_COTIZACION
};
