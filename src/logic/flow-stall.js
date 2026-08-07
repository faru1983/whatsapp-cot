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
      // C (fecha/comuna) es opcional. Tipo se puede saltar → pending guests.
      if (session.guests) return null;
      if (!session.celebrationType && !session.eventosCelebrationSkipped) return 'celebration';
      return 'guests';

    case 'EVENTOS_CONFIRMAR_DATOS':
      return session.guests ? 'confirm' : 'guests';

    case 'BARRILES_FILTRO_CANAL':
      // Espera un sabor / preferencia abierta (comuna/fecha van después)
      return 'flavor';

    case 'BARRILES_INTRO_MENU':
      return 'continue';

    case 'BARRILES_RECOGIDA_PRODUCTOS': {
      const products = session.orderBuilder?.products;
      const hasProducts = products && Object.keys(products).length > 0;
      return hasProducts ? null : 'products';
    }

    case 'BARRILES_RECOGIDA_DATOS': {
      const cd = session.orderBuilder?.clientData;
      if (cd?.date && cd?.location) return null;
      return 'client_data';
    }

    case 'EVENTOS_ELECCION_FORMATO':
      return session.eventoFormato ? null : 'format';

    case 'EVENTOS_INTRO_MENU':
      return 'continue';

    case 'EVENTOS_ELECCION_MENU': {
      const products = session.orderBuilder?.products;
      const hasProducts = products && Object.keys(products).length > 0;
      return hasProducts ? null : 'cart';
    }

    case 'EVENTOS_COTIZACION':
    case 'BARRILES_REVISION_COTIZACION':
      return 'confirm_quote';

    case 'EVENTOS_DATOS_CONTACTO':
    case 'BARRILES_DATOS_CONTACTO':
      // Clave fija 'contact': el progreso parcial lo marca el estado con flowProgress
      // (nombre→email→dirección). Así el anti-loop del engine cubre ruido repetido.
      return 'contact';

    case 'EVENTOS_CONFIRMAR_ENVIO':
    case 'BARRILES_CONFIRMAR_COMPRA':
      return 'confirm_submit';

    case 'BARRILES_ROUTER_MODIFICACION':
      return 'mod_choice';

    default:
      return null;
  }
}
