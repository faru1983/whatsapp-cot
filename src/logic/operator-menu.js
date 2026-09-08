// ==============================================================================
// OBJETIVO: Menú y textos de la consola operador (/menu).
// Solo self-chat o ADMIN_NUMBERS ven este panel; clientes nunca.
// ==============================================================================
import { formatRuntimeFlagsStatus } from './bot-runtime-flags.js';

/**
 * buildOperatorMenuText: Listado de acciones disponibles para el admin.
 *
 * @returns {string}
 */
export function buildOperatorMenuText() {
  const flags = formatRuntimeFlagsStatus();
  return `*Panel operador*

${flags}

*Acciones*
1️⃣ Cotización evento (API /quotes)
2️⃣ Venta barriles desechables (API /direct-sales)

*Interruptores*
/respuestas on | off — flujos automáticos a clientes
/cotapi on | off — crear cotizaciones y ventas en la web

*Por cliente*
/detenerbot <número>
/iniciarbot <número>
/reiniciarbot <número>

Escribe *1* o *2* para empezar, o */menu* para ver esto de nuevo.`;
}

/**
 * buildOperatorHintText: Cuando el admin escribe sin /menu y no está en captura.
 *
 * @returns {string}
 */
export function buildOperatorHintText() {
  return 'Escribe */menu* para ver las acciones del panel operador.';
}

/**
 * isOperatorConsoleMessage: ¿Es exactamente /menu (case insensitive)?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isOperatorMenuCommand(text) {
  return String(text || '').trim().toLowerCase() === '/menu';
}

/**
 * isOperatorMidFlowState: ¿La sesión está capturando o confirmando datos?
 *
 * @param {string} stateId
 * @returns {boolean}
 */
export function isOperatorMidFlowState(stateId) {
  return stateId === 'OPERADOR_CAPTURA' || stateId === 'OPERADOR_CONFIRMAR';
}
