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
import { MENU_KEYCAPS } from './flow-rails.js';
import { testLog } from '../core/debug-log.js';

/**
 * matchesMenuOption: ¿El mensaje es solo la opción N del menú?
 * Acepta dígito ("1") o emoji keycap ("1️⃣"). Así el cliente puede
 * tocar el emoji del menú o escribir el número a mano.
 *
 * @param {string} trimmed - Mensaje ya con trim()
 * @param {number} n - Número de opción (1–5)
 * @returns {boolean}
 */
export function matchesMenuOption(trimmed, n) {
  const t = String(trimmed ?? '').trim();
  if (!t || !Number.isFinite(n)) return false;

  // Solo el dígito (lo más común al escribir a mano)
  if (new RegExp(`^${n}$`).test(t)) return true;

  // Keycap Unicode: dígito + VS16 opcional + combining enclosing keycap
  if (new RegExp(`^${n}\\uFE0F?\\u20E3$`).test(t)) return true;

  // Constante del menú (por si el runtime normaliza distinto)
  if (MENU_KEYCAPS[n] && t === MENU_KEYCAPS[n]) return true;

  return false;
}

/**
 * rulesMenuNumerico: Menú de N opciones (emoji/dígito → etiqueta).
 * Cada ítem: { n, label, extra? } donde extra es un RegExp de sinónimos.
 *
 * @param {Array<{ n: number, label: string, extra?: RegExp }>} options
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesMenuNumerico(options) {
  if (!Array.isArray(options)) return [];
  return options.map(({ n, label, extra }) => ({
    label,
    test: ({ raw, trimmed }) => {
      if (matchesMenuOption(trimmed, n)) return true;
      // Evita que "12" o un precio matchee por coincidencia parcial
      if (/\d{2,}/.test(trimmed)) return false;
      if (extra instanceof RegExp) return extra.test(raw);
      return false;
    }
  }));
}

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
 * Menú: 1️⃣ confirmar / 2️⃣ modificar. Si pide cambios, gana MODIFICAR aunque diga "ok".
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesConfirmarOModificar() {
  return [
    {
      label: 'MODIFICAR',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 2)) return true;
        return /cambi|sacar|agrega|agregar|quitar|quita|elimina|modif|ajust|cantidad|litro|litraje|\bextra\b|\botro\b/i.test(lower)
          || /\b(cambiar|modificar|ajustar)\s+(el\s+)?(producto|sabor|coctel|cóctel|fecha|comuna|pedido)/i.test(lower);
      }
    },
    {
      label: 'CONFIRMAR',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 1)) return true;
        // Incluye "generar compra" / "comprar" (menú Barriles) además de sí/ok/confirmar
        return /\b(si|sí|ok|perfecto|listo|dale|confirm|esta bien|está bien|todo bien|vamos|súper|super|correcto|excelente|genial|aprobado|aprob|bueno)\b/i.test(lower)
          || /\b(generar(\s+la)?\s+compra|generar\s+pedido|comprar|compra)\b/i.test(lower);
      }
    }
  ];
}

/**
 * rulesMenuUnoDos: Menú 1️⃣ vs 2️⃣ (productos vs datos, etc.).
 * Usa matchesMenuOption para aceptar emoji o dígito.
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
  extraUno = /coctel|cóctel|bebida|trago/i,
  extraDos = /dato|fecha|ubicacion|ubicación/i
} = {}) {
  return rulesMenuNumerico([
    { n: 1, label: labelUno, extra: extraUno },
    { n: 2, label: labelDos, extra: extraDos }
  ]);
}

/**
 * rulesContinuarSiOOk: Seguir / ver carta (1️⃣, sí, ok, seguimos…).
 * Usado tras el pitch de formato, antes de mostrar cócteles y precios.
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesContinuarSiOOk() {
  return [
    {
      label: 'CONFIRMAR',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 1)) return true;
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
    },
    {
      label: 'HUMANO',
      test: ({ trimmed }) => matchesMenuOption(trimmed, 2)
    }
  ];
}

/**
 * rulesConfirmarOCorregirDatos: 1️⃣ ok vs 2️⃣ corregir (sin dar el valor nuevo).
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesConfirmarOCorregirDatos() {
  return [
    {
      label: 'CONFIRMAR',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 1)) return true;
        if (/^(ok|okay|si|sí|dale|listo|perfecto|correcto|esta bien|está bien|todo bien|vamos|claro)$/i.test(lower)) {
          return true;
        }
        return /\b(ok|okay|correcto|esta bien|está bien|todo bien|perfecto|dale|listo)\b/i.test(lower)
          && !/\b(no|mal|cambi|modific|equivoc)\b/i.test(lower);
      }
    },
    {
      label: 'CORREGIR',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 2)) return true;
        return /\b(cambi|modific|equivoc|mal|correg)\b/i.test(lower);
      }
    }
  ];
}

/**
 * rulesDispensadorOMuro: Elección de formato de evento (1️⃣ / 2️⃣).
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
        if (matchesMenuOption(trimmed, 1)) return true;
        if (/^(uno|primera?|opci[oó]n\s*1)$/i.test(trimmed)) return true;
        const isMuro = /\bmuro\b/i.test(lower);
        const isDispensador = /\b(dispensador|portatil|portátil)\b/i.test(lower);
        if (isDispensador && !isMuro) return true;
        return false;
      }
    },
    {
      label: 'MURO',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 2)) return true;
        if (/^(dos|segunda?|opci[oó]n\s*2)$/i.test(trimmed)) return true;
        const isMuro = /\bmuro\b/i.test(lower);
        const isDispensador = /\b(dispensador|portatil|portátil)\b/i.test(lower);
        if (isMuro && !isDispensador) return true;
        return false;
      }
    }
  ];
}

/**
 * looksLikeEventosDispensadorCta: CTA Meta / frase clara de Dispensador (sin Muro).
 *
 * @param {string} lower - Mensaje en minúsculas
 * @returns {boolean}
 */
function looksLikeEventosDispensadorCta(lower) {
  if (/\bmuro\b/i.test(lower)) return false;
  return /\b(dispensador(\s+port[aá]til)?|dispensador\s+de\s+c[oó]cteles|servicio\s+con\s+dispensador)\b/i.test(lower);
}

/**
 * looksLikeEventosMuroCta: CTA Meta / frase clara de Muro (sin Dispensador).
 *
 * @param {string} lower - Mensaje en minúsculas
 * @returns {boolean}
 */
function looksLikeEventosMuroCta(lower) {
  // Si menciona ambos formatos, no auto-fijamos (va a Eventos genérico o menú)
  if (/\b(dispensador|port[aá]til)\b/i.test(lower) && /\bmuro\b/i.test(lower)) return false;
  return /\b(muro(\s+de\s+cocteler[ií]a)?|servicio\s+con\s+muro)\b/i.test(lower);
}

/**
 * rulesRouterIntencion: Filtro determinístico de entrada.
 * Prioridad: Humano → Eventos+formato (Meta Ads) → Eventos genérico → Barriles.
 * Cualquier otro texto queda sin etiqueta para que el router muestre el menú.
 *
 * @returns {Array<{ label: string, test: Function }>}
 */
export function rulesRouterIntencion() {
  return [
    {
      label: 'HUMANO',
      test: ({ trimmed }) => matchesMenuOption(trimmed, 3)
    },
    // CTAs Meta Ads: fijar formato al entrar (antes del Eventos genérico)
    {
      label: 'EVENTOS_DISPENSADOR',
      test: ({ lower }) => looksLikeEventosDispensadorCta(lower)
    },
    {
      label: 'EVENTOS_MURO',
      test: ({ lower }) => looksLikeEventosMuroCta(lower)
    },
    {
      label: 'EVENTOS',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 1)) return true;
        // Genérico: eventos / celebración. NO “dispensador”/“muro” sueltos
        // (esas van a EVENTOS_DISPENSADOR / EVENTOS_MURO arriba).
        return /\b(servicio para eventos|para un evento|evento|eventos|matrimonio|matrimonios|cumplea[nñ]os)\b/i.test(lower);
      }
    },
    {
      label: 'BARRILES',
      test: ({ trimmed, lower }) => {
        if (matchesMenuOption(trimmed, 2)) return true;
        const hasEventos = /\b(servicio para eventos|para un evento|evento|eventos|matrimonio|cumplea|dispensador|muro)\b/i.test(lower);
        if (hasEventos) return false;
        // Exigimos una mención explícita del producto. Palabras genéricas como
        // "regalo", "llevar" o "para la casa" no deben abrir un flujo por error.
        return /\b(barril|barriles|barril desechable|barriles desechables|desechable|desechables|bidon|bidones)\b/i.test(lower);
      }
    }
  ];
}
