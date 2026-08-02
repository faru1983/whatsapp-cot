// ==============================================================================
// OBJETIVO: Barrel del flujo Barriles — junta los estados en barrilesStates.
// ==============================================================================
import { BARRILES_FILTRO_CANAL } from './states/BARRILES_FILTRO_CANAL.js';
import { BARRILES_RECOGIDA_PRODUCTOS } from './states/BARRILES_RECOGIDA_PRODUCTOS.js';
import { BARRILES_RECOGIDA_DATOS } from './states/BARRILES_RECOGIDA_DATOS.js';
import { BARRILES_REVISION_COTIZACION } from './states/BARRILES_REVISION_COTIZACION.js';
import { BARRILES_ROUTER_MODIFICACION } from './states/BARRILES_ROUTER_MODIFICACION.js';
import { BARRILES_DATOS_CONTACTO } from './states/BARRILES_DATOS_CONTACTO.js';
import { BARRILES_CONFIRMAR_COMPRA } from './states/BARRILES_CONFIRMAR_COMPRA.js';

/**
 * barrilesStates: Diccionario BARRILES_* para statesMap.
 */
export const barrilesStates = {
  BARRILES_FILTRO_CANAL,
  BARRILES_RECOGIDA_PRODUCTOS,
  BARRILES_RECOGIDA_DATOS,
  BARRILES_REVISION_COTIZACION,
  BARRILES_ROUTER_MODIFICACION,
  BARRILES_DATOS_CONTACTO,
  BARRILES_CONFIRMAR_COMPRA
};
