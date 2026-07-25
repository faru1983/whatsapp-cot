// ==============================================================================
// OBJETIVO: Detectar cuando el cliente está en un paso que espera un dato clave
// y aún no lo entrega. El engine usa esto para no “salvar” la charla con FAQ
// indefinidamente si ya hubo strikes (SECURITY_MAX_CONSECUTIVE_ERRORS).
// ==============================================================================

/**
 * getPendingFlowRequirement: Identificador del dato que falta para avanzar el paso.
 * Si devuelve null, el paso no está bloqueado por un dato obligatorio conocido.
 *
 * @param {object} session - Sesión del cliente
 * @param {string} stateId - Estado actual (ej. EVENTOS_RECOGIDA_DATOS)
 * @returns {string|null} Clave corta del requisito pendiente o null
 */
export function getPendingFlowRequirement(session, stateId) {
  switch (stateId) {
    case 'ESPERANDO_INTENCION':
      return session.userIntent ? null : 'intent';

    case 'EVENTOS_RECOGIDA_DATOS':
      return session.guests ? null : 'guests';

    case 'EVENTOS_CONFIRMAR_DATOS':
      return session.guests ? 'confirm' : 'guests';

    case 'BARRILES_FILTRO_CANAL': {
      const cd = session.orderBuilder?.clientData;
      if (cd?.date && cd?.location) return null;
      return 'delivery';
    }

    case 'BARRILES_RECOGIDA_PRODUCTOS': {
      const products = session.orderBuilder?.products;
      const hasProducts = products && Object.keys(products).length > 0;
      return hasProducts ? null : 'products';
    }

    case 'EVENTOS_ELECCION_FORMATO':
      return session.eventoFormato ? null : 'format';

    default:
      return null;
  }
}
