// ==============================================================================
// OBJETIVO: Detector de palabras clave para pasos de DECISIÓN (menú / sí-no).
// Cajita 1 del flujo: reglas manuales → etiqueta (ej. WEB, CHAT) o null.
// Usa normalizeString de utils.js. NO llama a IA ni lee FAQ/datos.
// Lo usan decision-intent.js y, si hace falta, los flujos directamente.
// ==============================================================================
import {
  normalizeString,
  isOnlyBrowsing,
  wantsInstagramOrSocial
} from './utils.js';
import { testLog } from '../core/debug-log.js';

/**
 * buildKeywordContext: Prepara el mensaje en varias formas para las reglas.
 * Así cada regla puede mirar el texto crudo, en minúsculas o normalizado.
 *
 * @param {string} messageText - Lo que escribió el cliente
 * @returns {{ raw: string, trimmed: string, lower: string, normalized: string }}
 */
export function buildKeywordContext(messageText) {
  const raw = String(messageText ?? '');
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  // Sin tildes ni mayúsculas: "Acá" y "aca" se comparan igual
  const normalized = normalizeString(raw);
  return { raw, trimmed, lower, normalized };
}

/**
 * matchKeywordIntent: Prueba reglas en orden; la primera que cumple gana.
 * Cada regla tiene una etiqueta (label) y un test(ctx) que devuelve true/false.
 *
 * Ejemplo:
 *   matchKeywordIntent(msg, [
 *     { label: 'WEB', test: ({ normalized }) => /web/.test(normalized) },
 *     { label: 'CHAT', test: ({ normalized }) => /chat/.test(normalized) }
 *   ])
 *
 * @param {string} messageText - Mensaje del cliente
 * @param {Array<{ label: string, test: (ctx: object) => boolean }>} rules - Reglas en prioridad
 * @param {object} [opts]
 * @param {boolean} [opts.log=false] - Si true, imprime [TEST] al matchear (útil en router)
 * @param {string} [opts.logContext='keywords'] - Etiqueta del log (ej. "router")
 * @returns {string|null} Etiqueta de la primera regla que matchea, o null
 */
export function matchKeywordIntent(messageText, rules, opts = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const { log = false, logContext = 'keywords' } = opts;
  const ctx = buildKeywordContext(messageText);

  // Recorremos en orden: la primera coincidencia define la intención
  for (const rule of rules) {
    if (!rule || typeof rule.test !== 'function') continue;
    try {
      if (rule.test(ctx)) {
        const label = String(rule.label || '').trim().toUpperCase();
        if (label) {
          // Solo logueamos si el caller lo pide (router). decision-intent loguea él mismo.
          if (log) testLog(`${logContext}: keywords → ${label}`);
          return label;
        }
      }
    } catch (err) {
      // Una regla rota no debe tumbar el bot; seguimos con la siguiente
      console.error(`[keyword-intent] Error en regla "${rule.label}":`, err.message);
    }
  }

  if (log) testLog(`${logContext}: keywords sin match`);
  return null;
}

// ==============================================================================
// REGLAS REUTILIZABLES (presets)
// Sirven en varios flujos / empresas: canal web vs chat, confirmar, etc.
// ==============================================================================

/**
 * rulesBarrilesFiltroCanal: Menú inicial de barriles (3 salidas).
 * WEB → página | CHAT → carta por WhatsApp | SOLO_MIRANDO → cierre suave.
 * Prioridad: solo mirando primero (para no confundir con "no" a la web).
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesBarrilesFiltroCanal() {
  return [
    {
      label: 'SOLO_MIRANDO',
      // Frases claras de "solo mirando". NO usamos "no" solo: en este menú
      // "no" suele significar "no a la web" → CHAT (ver regla más abajo).
      test: ({ raw, trimmed }) => {
        if (/^(no|nop|nope|nah)$/i.test(trimmed)) return false;
        return isOnlyBrowsing(raw) || wantsInstagramOrSocial(raw);
      }
    },
    {
      label: 'WEB',
      // Solo si menciona web/link/página. "gracias" solo NO es WEB (es ruido → re-pregunta).
      test: ({ normalized }) => {
        const mentionsWeb = (
          /web|link|pagina|sitio|url|tienda\s*virtual/.test(normalized)
          || /meterme|me\s+meto|entrar|voy\s+a\s+(la\s+)?(pagina|web|sitio|link)/.test(normalized)
          || /ver\s+directamente|prefiero\s+(la\s+)?(web|pagina|link)|mejor\s+(la\s+)?(web|pagina)/.test(normalized)
          || /\blo\s+(vere|veo|reviso|miro|chequeo|chekeo)\b/.test(normalized)
          || /\bya\s+lo\s+(veo|miro|reviso|chequeo|chekeo|vere)\b/.test(normalized)
          || /\bvoy\s+a\s+(verlo|mirarlo|revisarlo|chequearlo)\b/.test(normalized)
          || /\b(lo\s+)?(reviso|miro)\s+(alla|ahi|en\s+la\s+(web|pagina|sitio))\b/.test(normalized)
        );
        const mentionsChat = /chat|whatsapp|por\s+aqui|por\s+aca|cuentame|ayudame/.test(normalized);
        return mentionsWeb && !mentionsChat;
      }
    },
    {
      label: 'CHAT',
      // "no" corto = no a la web (prefiere ayuda por WhatsApp).
      // NO incluir precio/valor: eso se responde en el filtro sin avanzar canal.
      test: ({ trimmed, normalized }) =>
        /^(no|nop|nope)$/i.test(trimmed)
        || /\b(aqui|aca|aka|chat|whatsapp|por\s+aqui|por\s+aca|por\s+aka|cuentame|ayudame|sigamos|seguimos|continuar)\b/.test(normalized)
    }
  ];
}

/**
 * rulesWebVsChat: ¿Quiere ir a la web o seguir por WhatsApp?
 * Usado en filtro de canal Barriles, post-ambas del router, y "web" en Eventos.
 * En esos pasos, elegir WEB cierra el chat (CERRADO + mute).
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesWebVsChat() {
  return [
    {
      label: 'WEB',
      // Solo menciones claras de web/link. "gracias" solo NO cierra (ruido → re-pregunta).
      test: ({ normalized }) => {
        const mentionsWeb = (
          /web|link|pagina|sitio|url|tienda\s*virtual/.test(normalized)
          || /meterme|me\s+meto|entrar|voy\s+a\s+(la\s+)?(pagina|web|sitio|link)/.test(normalized)
          || /ver\s+directamente|prefiero\s+(la\s+)?(web|pagina|link)|mejor\s+(la\s+)?(web|pagina)/.test(normalized)
          || /\blo\s+(vere|veo|reviso|miro|chequeo|chekeo)\b/.test(normalized)
          || /\bya\s+lo\s+(veo|miro|reviso|chequeo|chekeo|vere)\b/.test(normalized)
          || /\bvoy\s+a\s+(verlo|mirarlo|revisarlo|chequearlo)\b/.test(normalized)
          || /\b(lo\s+)?(reviso|miro)\s+(alla|ahi|en\s+la\s+(web|pagina|sitio))\b/.test(normalized)
        );
        const mentionsChat = /chat|whatsapp|por\s+aqui|por\s+aca|cuentame/.test(normalized);
        return mentionsWeb && !mentionsChat;
      }
    },
    {
      label: 'CHAT',
      // "no" corto = no a la web cuando el bot preguntó web vs aquí.
      // NO incluir precio/valor/cuánto: eso es duda, no avance de canal.
      test: ({ trimmed, normalized }) =>
        /^(no|nop|nope)$/i.test(trimmed)
        || /\b(aqui|aca|aka|chat|whatsapp|por\s+aqui|por\s+aca|por\s+aka|cuentame|ayudame|sigamos|seguimos|continuar)\b/.test(normalized)
    }
  ];
}

/**
 * rulesConfirmarOModificar: Confirmar cotización vs pedir cambios.
 * Si pide cambios, gana MODIFICAR aunque también diga "ok".
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesConfirmarOModificar() {
  return [
    {
      label: 'MODIFICAR',
      // Cubre barriles y eventos (agrega/agregar, quita/quitar, litraje, elimina…)
      test: ({ lower }) =>
        /cambi|sacar|agrega|agregar|quitar|quita|elimina|modif|ajust|cantidad|litro|litraje|cóctel|coctel|producto|extra|otro/i.test(lower)
    },
    {
      label: 'CONFIRMAR',
      test: ({ lower }) =>
        /(si|sí|ok|perfecto|listo|dale|confirm|esta bien|está bien|todo bien|vamos|súper|super|correcto|excelente|genial|aprob|bueno)/i.test(lower)
    }
  ];
}

/**
 * rulesMenuUnoDos: Menú numérico 1 vs 2 (productos vs datos, etc.).
 *
 * @param {object} opts
 * @param {string} opts.labelUno - Etiqueta para opción 1
 * @param {string} opts.labelDos - Etiqueta para opción 2
 * @param {RegExp} [opts.extraUno] - Palabras extra de la opción 1
 * @param {RegExp} [opts.extraDos] - Palabras extra de la opción 2
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesMenuUnoDos({
  labelUno,
  labelDos,
  extraUno = /1|coctel|cóctel|bebida|trago/i,
  extraDos = /2|3|dato|fecha|ubicacion|ubicación/i
} = {}) {
  return [
    {
      label: labelUno,
      // Mismo criterio histórico: "1" o palabras de cócteles
      test: ({ raw }) => extraUno.test(raw)
    },
    {
      label: labelDos,
      // "3" por compatibilidad histórica en router de modificación barriles
      test: ({ raw }) => extraDos.test(raw)
    }
  ];
}

/**
 * rulesContinuarSiOOk: Seguir / ver carta (sí, ok, seguimos, precios…).
 * Usado tras el pitch de formato, antes de mostrar cócteles y precios.
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesContinuarSiOOk() {
  return [
    {
      label: 'CONFIRMAR',
      test: ({ lower }) => {
        if (/^(ok|okay|si|sí|dale|listo|perfecto|vamos|claro|seguimos|continuar)$/i.test(lower)) {
          return true;
        }
        // Frases de avance o de querer ver la carta
        if (/\b(seguimos|continuar|adelante|quiero ver|ver (la )?carta|ver precios|ver c[oó]cteles)\b/i.test(lower)) {
          return true;
        }
        return /\b(ok|okay|si|sí|dale|listo|perfecto)\b/i.test(lower)
          && !/\b(no|después|despues|luego|mal)\b/i.test(lower);
      }
    }
  ];
}

/**
 * rulesConfirmarOCorregirDatos: ok/sí vs quiere corregir (sin dar el valor nuevo).
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesConfirmarOCorregirDatos() {
  return [
    {
      label: 'CONFIRMAR',
      test: ({ lower }) => {
        if (/^(ok|okay|si|sí|dale|listo|perfecto|correcto|esta bien|está bien|todo bien|vamos|claro)$/i.test(lower)) {
          return true;
        }
        return /\b(ok|okay|correcto|esta bien|está bien|todo bien|perfecto|dale|listo)\b/i.test(lower)
          && !/\b(no|mal|cambi|modific|equivoc)\b/i.test(lower);
      }
    },
    {
      label: 'CORREGIR',
      test: ({ lower }) => /\b(cambi|modific|equivoc|mal|correg)\b/i.test(lower)
    }
  ];
}

/**
 * rulesDispensadorOMuro: Elección de formato de evento.
 * AMBOS va primero: "ambos" / "dispensador y muro" no debe forzar una opción.
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesDispensadorOMuro() {
  return [
    {
      label: 'AMBOS',
      test: ({ lower }) => {
        // Frases explícitas de "quiero los dos" (ambos, las 2, 1 y 2, etc.)
        if (/\b(ambas|ambos|los\s*dos|las\s*dos|los\s*2|las\s*2|los2|las2)\b/i.test(lower)) return true;
        if (/\b(1\s*y\s*2|uno\s*y\s*dos|opci[oó]n\s*1\s*y\s*(opci[oó]n\s*)?2)\b/i.test(lower)) return true;
        // Menciona las dos opciones en el mismo mensaje
        const isMuro = /\bmuro\b/i.test(lower);
        const isDispensador = /\b(dispensador|portatil|portátil)\b/i.test(lower);
        return isMuro && isDispensador;
      }
    },
    {
      label: 'DISPENSADOR',
      test: ({ trimmed, lower }) => {
        if (/^(1|uno|primera?|opci[oó]n\s*1)$/i.test(trimmed)) return true;
        const isMuro = /\bmuro\b/i.test(lower);
        const isDispensador = /\b(dispensador|portatil|portátil)\b/i.test(lower);
        if (isDispensador && !isMuro) return true;
        return false;
      }
    },
    {
      label: 'MURO',
      test: ({ trimmed, lower }) => {
        if (/^(2|dos|segunda?|opci[oó]n\s*2)$/i.test(trimmed)) return true;
        const isMuro = /\bmuro\b/i.test(lower);
        const isDispensador = /\b(dispensador|portatil|portátil)\b/i.test(lower);
        if (isMuro && !isDispensador) return true;
        return false;
      }
    }
  ];
}

/**
 * rulesRouterIntencion: Primer filtro del bot (barriles / eventos / ambas).
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesRouterIntencion() {
  return [
    {
      label: 'BARRILES',
      test: ({ lower }) =>
        /\b(barril desechable|barriles desechables|barril portable|barril portables|barriles portable|barriles portables|desechable|desechables|bidon|bidones)\b/i.test(lower)
    },
    {
      label: 'EVENTOS',
      test: ({ lower }) =>
        /\b(servicio para eventos|evento|eventos|dispensador portatil|dispensador portátil|muro|matrimonio|matrimonios|cumplea[nñ]os)\b/i.test(lower)
    },
    {
      label: 'AMBAS',
      test: ({ lower }) =>
        /\b(ambas|ambos|los dos|los 2|las dos|las 2)\b/i.test(lower)
    }
  ];
}
