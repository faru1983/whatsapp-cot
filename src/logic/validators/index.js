// ==============================================================================
// OBJETIVO: Registro de validadores reutilizables (llamar por nombre desde un estado).
// Cada función responde: ¿qué significa el mensaje del cliente?
// Lo usa compile-state.js y, si hace falta, los handlers de cada paso.
// ==============================================================================
import {
  isGreetingOrNoise,
  asksPriceOrCatalog,
  wantsBrowseOnlyClose,
  wantsAdvanceProductsOrder,
  findMentionedCocktail,
  formatDesechablePriceReply
} from '../interruptions.js';
import { hasDrinkSelection } from '../utils.js';
import { matchKeywordIntent } from '../keyword-intent.js';
import {
  rulesBarrilesFiltroCanal,
  rulesConfirmarOModificar,
  rulesMenuUnoDos,
  rulesRouterIntencion,
  rulesWebVsChat,
  rulesConfirmarOCorregirDatos,
  rulesDispensadorOMuro
} from '../keyword-intent.js';

// ==============================================================================
// 1. PRESETS DE KEYWORDS (nombre → fábrica de reglas)
// ==============================================================================

/**
 * RULE_PRESETS: Mapa nombre → función que devuelve reglas { label, test }.
 * Así un estado dice rules: 'barrilesFiltroCanal' sin importar keyword-intent.
 */
const RULE_PRESETS = {
  barrilesFiltroCanal: () => rulesBarrilesFiltroCanal(),
  confirmarOModificar: () => rulesConfirmarOModificar(),
  menuUnoDosProductosDatos: () => rulesMenuUnoDos({ labelUno: 'PRODUCTOS', labelDos: 'DATOS' }),
  routerIntencion: () => rulesRouterIntencion(),
  webVsChat: () => rulesWebVsChat(),
  confirmarOCorregirDatos: () => rulesConfirmarOCorregirDatos(),
  dispensadorOMuro: () => rulesDispensadorOMuro()
};

/**
 * getKeywordRules: Resuelve un nombre de preset a la lista de reglas.
 *
 * @param {string} rulesName - Clave en RULE_PRESETS
 * @param {unknown} [arg] - Argumento opcional (ej. formato actual)
 * @returns {Array<{ label: string, test: Function }>}
 */
export function getKeywordRules(rulesName, arg) {
  const factory = RULE_PRESETS[rulesName];
  if (typeof factory !== 'function') {
    console.error(`[validators] Preset de keywords desconocido: ${rulesName}`);
    return [];
  }
  return factory(arg);
}

/**
 * matchKeywordsByName: Prueba keywords de un preset; devuelve etiqueta o null.
 *
 * @param {string} messageText - Mensaje del cliente
 * @param {string} rulesName - Nombre del preset
 * @param {unknown} [arg] - Extra para el preset
 * @returns {string|null}
 */
export function matchKeywordsByName(messageText, rulesName, arg) {
  return matchKeywordIntent(messageText, getKeywordRules(rulesName, arg));
}

// ==============================================================================
// 2. REGISTRO PÚBLICO (nombre → función)
// ==============================================================================

/**
 * VALIDATORS: Diccionario para compileState y estados declarativos.
 * Uso: VALIDATORS.asksPriceOrCatalog(msg)
 */
export const VALIDATORS = {
  isGreetingOrNoise,
  asksPriceOrCatalog,
  wantsBrowseOnlyClose,
  wantsAdvanceProductsOrder,
  findMentionedCocktail,
  formatDesechablePriceReply,
  hasDrinkSelection,
  matchKeywordsByName,
  getKeywordRules
};

export {
  isGreetingOrNoise,
  asksPriceOrCatalog,
  wantsBrowseOnlyClose,
  wantsAdvanceProductsOrder,
  findMentionedCocktail,
  formatDesechablePriceReply,
  hasDrinkSelection
};
