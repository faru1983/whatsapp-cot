// ==============================================================================
// OBJETIVO: Barrel del flujo operador — estados OPERADOR_* para el panel /menu.
// Flujo 3 pasos:
// 1) OPERADOR_CAPTURA (Contacto)
// 2) OPERADOR_CAPTURA_DETALLES (Detalles del evento/despacho)
// 3) OPERADOR_CAPTURA_PRODUCTOS (Cócteles y formato)
// => OPERADOR_CONFIRMAR (Resumen final y envío a la API).
// ==============================================================================
import { OPERADOR_MENU } from './states/OPERADOR_MENU.js';
import { OPERADOR_CAPTURA } from './states/OPERADOR_CAPTURA.js';
import { OPERADOR_CAPTURA_DETALLES } from './states/OPERADOR_CAPTURA_DETALLES.js';
import { OPERADOR_CAPTURA_PRODUCTOS } from './states/OPERADOR_CAPTURA_PRODUCTOS.js';
import { OPERADOR_CONFIRMAR } from './states/OPERADOR_CONFIRMAR.js';

/**
 * operadorStates: Diccionario OPERADOR_* para statesMap (5 estados).
 */
export const operadorStates = {
  OPERADOR_MENU,
  OPERADOR_CAPTURA,
  OPERADOR_CAPTURA_DETALLES,
  OPERADOR_CAPTURA_PRODUCTOS,
  OPERADOR_CONFIRMAR
};
