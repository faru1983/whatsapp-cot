// ==============================================================================
// OBJETIVO: Barrel del flujo Eventos — junta los estados EVENTOS_* en eventosStates.
// Entrada: ELECCION_FORMATO (o ads) → RECOGIDA → INTRO_MENU → ESTILO → MENU → contacto → confirmar.
// CONFIRMAR_DATOS queda en el mapa por compat, pero ya no está en el happy path.
// ==============================================================================
import { EVENTOS_ELECCION_FORMATO } from './states/EVENTOS_ELECCION_FORMATO.js';
import { EVENTOS_RECOGIDA_DATOS } from './states/EVENTOS_RECOGIDA_DATOS.js';
import { EVENTOS_CONFIRMAR_DATOS } from './states/EVENTOS_CONFIRMAR_DATOS.js';
import { EVENTOS_INTRO_MENU } from './states/EVENTOS_INTRO_MENU.js';
import { EVENTOS_ESTILO_MENU } from './states/EVENTOS_ESTILO_MENU.js';
import { EVENTOS_ELECCION_MENU } from './states/EVENTOS_ELECCION_MENU.js';
import { EVENTOS_DATOS_CONTACTO } from './states/EVENTOS_DATOS_CONTACTO.js';
import { EVENTOS_CONFIRMAR_ENVIO } from './states/EVENTOS_CONFIRMAR_ENVIO.js';

/**
 * eventosStates: Diccionario EVENTOS_* para statesMap.
 */
export const eventosStates = {
  EVENTOS_ELECCION_FORMATO,
  EVENTOS_RECOGIDA_DATOS,
  EVENTOS_CONFIRMAR_DATOS,
  EVENTOS_INTRO_MENU,
  EVENTOS_ESTILO_MENU,
  EVENTOS_ELECCION_MENU,
  EVENTOS_DATOS_CONTACTO,
  EVENTOS_CONFIRMAR_ENVIO
};
