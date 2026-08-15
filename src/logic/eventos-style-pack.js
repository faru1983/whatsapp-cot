// ==============================================================================
// OBJETIVO: Cierre guiado de Eventos — p/p + elección de sabores (abierta).
// Tras la cantidad, el cliente elige cócteles con catálogo por categoría.
// La “selección sugerida” es opcional (orden comercial), no un menú 1️⃣/2️⃣.
// Combinados / sin alcohol siguen como atajos si los piden.
// ==============================================================================
import {
  preciosData,
  formatPrice,
  partitionLitersIntoBarrels,
  formatBarrelPartsLabel,
  getCoctelesByCategoria,
  getCoctelesNamesCatalogCompact
} from './utils.js';
import {
  getMinLitersForFormat,
  getAllowedLitrages,
  ensureEventOrderBuilder,
  EVENT_COCKTAIL_ORDER_EXAMPLE
} from './eventos-helpers.js';
import { OrderBuilder } from './order-builder.js';
import { formatMenuBlock, MENU_WRITE_CTA } from './flow-rails.js';
import { nextEventosAck } from './eventos-intro.js';

/** Base comercial: complemento de la celebración (no open bar completo). */
export const EVENT_DRINKS_PER_GUEST = 2;

/** Tope suave de upsell (“más cantidad”) antes de pasar a humano. */
export const EVENT_DRINKS_PER_GUEST_PARTY = 3;

/** ≈5 cócteles de 200ml por litro (alineado a rendimientos_barriles). */
export const EVENT_COCKTAILS_PER_LITER = 5;

/**
 * Packs de estilo (nombres exactos del catálogo).
 * Se usan en atajos (Combinados / sin alcohol) o packs legacy.
 * “Premium” es framing de venta: Aperol / Mule / Gin, no una categoría DB.
 */
export const EVENT_STYLE_PACKS = {
  CLASICOS: ['Mojito', 'Pisco Sour', 'Sangría'],
  PREMIUM: ['Aperol Spritz', 'Moscow Mule', 'Gin & Tonic'],
  VARIADOS: ['Mojito', 'Aperol Spritz', 'Pisco Sour'],
  COMBINADOS: ['Piscola Alto 35°', 'Piscola Mistral 35°', 'Whiskcola J.W. Black'],
  MOCKTAILS: ['Mojito Mocktail', 'Sangría Mocktail', 'Maracuyá Spritz Mocktail']
};

/**
 * Orden comercial de la selección sugerida (nombres exactos del catálogo).
 * Base simple → más volumen → matrimonio → económicos.
 */
export const EVENT_SUGGESTED_SELECTION_ORDER = {
  core: ['Mojito', 'Sangría'],
  moreQty: ['Ramazzotti Spritz'],
  matrimonioExtra: ['Piscola Alto 35°'],
  fill: ['Caipiriña', 'Pisco Sour', 'Moscow Mule', 'Gin & Tonic']
};

/** Etiquetas amigables (atajos legacy; el flujo principal ya no muestra este menú). */
export const EVENT_STYLE_MENU_LABELS = [
  'Clásicos — Mojito, Pisco Sour, Sangría…',
  'Más premium — Aperol, Moscow Mule, Gin & Tonic…',
  'Variados — mezcla de clásicos y premium'
];

/**
 * cocktailsPerLiter: Cuántos cócteles salen de 1L (tabla o fallback 5).
 *
 * @param {number} liters
 * @returns {number}
 */
export function cocktailsForLiters(liters) {
  const n = Number(liters) || 0;
  if (n <= 0) return 0;
  const key = `${n}L`;
  const fromTable = preciosData.rendimientos_barriles?.[key];
  if (fromTable != null) return fromTable;
  return n * EVENT_COCKTAILS_PER_LITER;
}

/**
 * litersForCocktails: Litros necesarios para N cócteles (ceil).
 *
 * @param {number} cocktails
 * @returns {number}
 */
export function litersForCocktails(cocktails) {
  const n = Number(cocktails) || 0;
  if (n <= 0) return 0;
  return Math.ceil(n / EVENT_COCKTAILS_PER_LITER);
}

/**
 * roundLitersToFormatStep: Sube al múltiplo del barril más chico y al mínimo del formato.
 *
 * @param {number} liters
 * @param {'dispensador'|'muro'|string} formatKey
 * @returns {number}
 */
export function roundLitersToFormatStep(liters, formatKey) {
  const minLiters = getMinLitersForFormat(formatKey);
  const allowed = getAllowedLitrages(formatKey);
  const step = Math.min(...allowed.map((l) => parseInt(l, 10)).filter((n) => n > 0));
  let target = Math.max(Number(liters) || 0, minLiters);
  if (!Number.isFinite(step) || step <= 0) return target;
  target = Math.ceil(target / step) * step;
  return Math.max(target, minLiters);
}

/**
 * calculateEventBaseline: Cuenta clara N p/p para el pitch de venta.
 * Por defecto 2 p/p; se puede subir (ej. 3) si pide “más cantidad”.
 *
 * @param {number|string|null|undefined} guests
 * @param {'dispensador'|'muro'|string} formatKey
 * @param {number} [drinksPerGuest=EVENT_DRINKS_PER_GUEST]
 * @returns {{
 *   guests: number,
 *   drinksPerGuest: number,
 *   totalCocktails: number,
 *   rawLiters: number,
 *   totalLiters: number,
 *   mathLine: string
 * }}
 */
export function calculateEventBaseline(guests, formatKey, drinksPerGuest = EVENT_DRINKS_PER_GUEST) {
  const n = Math.max(0, Number(guests) || 0);
  const per = Math.max(1, Number(drinksPerGuest) || EVENT_DRINKS_PER_GUEST);
  const totalCocktails = n * per;
  const rawLiters = litersForCocktails(totalCocktails);
  const totalLiters = roundLitersToFormatStep(rawLiters || getMinLitersForFormat(formatKey), formatKey);
  const mathLine = n > 0
    ? `${n}×${per} = *${totalCocktails}* cócteles`
    : `*${per}* cócteles por persona`;

  return {
    guests: n,
    drinksPerGuest: per,
    totalCocktails: n > 0 ? totalCocktails : cocktailsForLiters(totalLiters),
    rawLiters,
    totalLiters,
    mathLine
  };
}

/**
 * buildSalesFlavorShares: Reparte litros poniendo más volumen en el “favorito”.
 * Así el pitch suena a vendedor: el principal no se agota primero.
 *
 * @param {number} totalLiters
 * @param {number} flavorCount
 * @param {string[]} allowedLitrages
 * @returns {number[]}
 */
function buildSalesFlavorShares(totalLiters, flavorCount, allowedLitrages) {
  const shares = splitLitersAcrossFlavors(totalLiters, flavorCount, allowedLitrages);
  return [...shares].sort((a, b) => b - a);
}

/**
 * formatLitersWithBarrelHint: "*15L* (10L + 5L)" si el total no es un solo barril.
 *
 * @param {number} liters
 * @param {string[]} allowedLitrages
 * @returns {string}
 */
function formatLitersWithBarrelHint(liters, allowedLitrages) {
  const n = Number(liters) || 0;
  if (n <= 0) return '';
  const parts = partitionLitersIntoBarrels(n, allowedLitrages);
  const label = formatBarrelPartsLabel(parts || []);
  // Un solo barril (ej. 10L o 1×10L) → no hace falta el desglose
  if (parts && parts.length === 1 && parts[0].count === 1) return `*${n}L*`;
  if (label) return `*${n}L* (${label})`;
  return `*${n}L*`;
}

/**
 * formatSalesShareLine: Texto de un reparto (ej. "*10L* del favorito + *5L* de un segundo").
 *
 * @param {number[]} shares - Litros por sabor, mayor→menor
 * @param {string[]} allowedLitrages
 * @returns {string}
 */
function formatSalesShareLine(shares, allowedLitrages) {
  const list = (shares || []).filter((n) => Number(n) > 0);
  if (list.length === 0) return '';
  const fmt = (n) => formatLitersWithBarrelHint(n, allowedLitrages);
  if (list.length === 1) return `${fmt(list[0])} de un solo sabor`;
  if (list.length === 2) {
    if (list[0] === list[1]) return `${fmt(list[0])} + ${fmt(list[1])} (mitad y mitad)`;
    return `${fmt(list[0])} del favorito + ${fmt(list[1])} de un segundo`;
  }
  // 3+: todos iguales → "5L + 5L + 5L"; si no, más litros al favorito
  const allSame = list.every((n) => n === list[0]);
  if (allSame) return list.map((n) => fmt(n)).join(' + ');
  return `${fmt(list[0])} del favorito + ` + list.slice(1).map((n) => fmt(n)).join(' + ');
}

/**
 * suggestedFlavorCountOptions: Cuántos sabores conviene mostrar en el pitch.
 * Regla de venta: pocos sabores en eventos chicos; más variedad si hay litros.
 *
 * @param {number} totalLiters
 * @param {number} step - Barril más chico del formato (5 o 10)
 * @returns {number[]}
 */
function suggestedFlavorCountOptions(totalLiters, step) {
  const L = Number(totalLiters) || 0;
  const s = Math.max(1, Number(step) || 5);
  if (L < s * 2) return [1];
  if (L <= s * 2) return [2];
  if (L <= s * 6) return [2, 3];
  return [3, 4];
}

/**
 * buildFlavorDistributionTips: Guía de vendedor — cómo repartir sabores y tamaños.
 *
 * @param {number} totalLiters
 * @param {string[]} allowedLitrages
 * @returns {string}
 */
function buildFlavorDistributionTips(totalLiters, allowedLitrages) {
  const L = Math.max(0, Number(totalLiters) || 0);
  const allowed = allowedLitrages || [];
  const step = Math.min(...allowed.map((x) => parseInt(x, 10)).filter((n) => n > 0)) || 5;
  const counts = suggestedFlavorCountOptions(L, step);

  const lines = [];
  const rangeLabel = counts.length === 1
    ? (counts[0] === 1 ? '*1 sabor*' : `*${counts[0]} sabores*`)
    : `*${counts[0]} o ${counts[counts.length - 1]} sabores*`;

  lines.push(`💡 *Cómo lo armaría yo:* con ese volumen lo ideal es ${rangeLabel} (si eliges muchos, cada uno rinde poco).`);

  for (const n of counts) {
    if (n < 1) continue;
    const shares = buildSalesFlavorShares(L, n, allowed);
    const split = formatSalesShareLine(shares, allowed);
    if (!split) continue;
    if (n === 1) {
      lines.push(`• *1 sabor:* ${split} — simple y abundante.`);
    } else if (n === 2) {
      const tip = shares[0] === shares[1]
        ? 'equilibrio rico entre los dos'
        : 'así el principal no se acaba primero';
      lines.push(`• *2 sabores:* ${split} — ${tip}.`);
    } else {
      lines.push(`• *${n} sabores:* ${split} — más variedad sin quedarte corto.`);
    }
  }

  // Si el total no es un solo barril, explicamos cómo se arma (15L → 10L + 5L)
  const asOne = partitionLitersIntoBarrels(L, allowed);
  const barrelLabel = formatBarrelPartsLabel(asOne || []);
  if (barrelLabel && asOne && (asOne.length > 1 || (asOne[0]?.count || 0) > 1)) {
    lines.push(`Si concentras todo en un sabor, se arma en *${barrelLabel}*.`);
  }

  return lines.join('\n');
}

/**
 * buildVolumeRecommendation: Pitch de vendedor — volumen + cómo repartir sabores/tamaños.
 * Tras p/p guiamos al cliente antes de mostrar precios.
 *
 * @param {object} session
 * @param {'dispensador'|'muro'|string} formatKey
 * @param {number} per
 * @returns {string}
 */
export function buildVolumeRecommendation(session, formatKey, per) {
  const baseline = calculateEventBaseline(session?.guests, formatKey, per);
  const allowed = getAllowedLitrages(formatKey);
  const sizesLine = allowed
    .map((l) => {
      const n = parseInt(l, 10);
      return `*${l}* (~${cocktailsForLiters(n)} cócteles)`;
    })
    .join(' · ');
  const tips = buildFlavorDistributionTips(baseline.totalLiters, allowed);

  return `Con *${baseline.guests}* invitados y *${per}* cócteles por persona (${baseline.mathLine}) te sugiero pedir unos *${baseline.totalLiters}L* en total.

${tips}

📦 Barriles del formato: ${sizesLine}.
Cuando veas los precios eliges los sabores y cómo repartirlos 👌`;
}

/**
 * splitLitersAcrossFlavors: Reparte litros en N sabores (múltiplos del barril chico).
 *
 * @param {number} totalLiters
 * @param {number} flavorCount
 * @param {string[]} allowedLitrages
 * @returns {number[]}
 */
export function splitLitersAcrossFlavors(totalLiters, flavorCount, allowedLitrages) {
  const count = Math.max(1, Number(flavorCount) || 1);
  const allowed = (allowedLitrages || [])
    .map((l) => parseInt(l, 10))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const step = allowed[0] || 5;
  let remaining = Math.max(step, Number(totalLiters) || step);
  // Aseguramos múltiplo exacto del step
  remaining = Math.ceil(remaining / step) * step;

  const shares = [];
  for (let i = 0; i < count; i++) {
    const left = count - i;
    if (i === count - 1) {
      shares.push(remaining);
      break;
    }
    let share = Math.floor(remaining / left / step) * step;
    if (share < step) share = step;
    // No dejar al último sin múltiplo válido
    const maxForThis = remaining - step * (left - 1);
    if (share > maxForThis) share = Math.floor(maxForThis / step) * step;
    if (share < step) share = step;
    shares.push(share);
    remaining -= share;
  }
  return shares;
}

/**
 * litersToProductLines: Convierte un total de litros de un sabor en líneas de carrito.
 *
 * @param {string} name
 * @param {number} liters
 * @param {string[]} allowedLitrages
 * @returns {Array<{ name: string, quantity: number, litrage: string }>}
 */
export function litersToProductLines(name, liters, allowedLitrages) {
  const parts = partitionLitersIntoBarrels(liters, allowedLitrages);
  if (!parts) {
    // Fallback: un barril del tamaño más cercano hacia arriba si se puede
    const numeric = allowedLitrages
      .map((l) => parseInt(l, 10))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const fit = numeric.find((n) => n >= liters) || numeric[numeric.length - 1];
    if (!fit) return [];
    return [{ name, quantity: 1, litrage: `${fit}L` }];
  }
  return parts.map(({ size, count }) => ({
    name,
    quantity: count,
    litrage: `${size}L`
  }));
}

/**
 * resolveStylePackNames: Nombres del pack; filtra los que existan en el catálogo.
 *
 * @param {string} styleKey - CLASICOS | PREMIUM | VARIADOS | COMBINADOS | MOCKTAILS
 * @returns {string[]}
 */
export function resolveStylePackNames(styleKey) {
  const key = String(styleKey || '').toUpperCase();
  const wanted = EVENT_STYLE_PACKS[key] || EVENT_STYLE_PACKS.CLASICOS;
  const catalog = preciosData.cocteles || {};
  const available = wanted.filter((name) => Boolean(catalog[name]));
  if (available.length > 0) return available;

  // Si faltan nombres (catálogo vivo distinto), tomamos 3 de la categoría cercana
  const cats = getCoctelesByCategoria();
  if (key === 'COMBINADOS') return (cats.COMBINADOS || []).slice(0, 3).map((c) => c.name);
  if (key === 'MOCKTAILS') return (cats.MOCKTAILS || []).slice(0, 3).map((c) => c.name);
  return (cats['CLÁSICOS'] || []).slice(0, 3).map((c) => c.name);
}

/**
 * buildPackFromFlavorNames: Reparte litros entre una lista de sabores del catálogo.
 *
 * @param {string[]} flavorNames
 * @param {number} guests
 * @param {'dispensador'|'muro'|string} formatKey
 * @param {number} [drinksPerGuest]
 * @returns {{
 *   products: Array<{ name: string, quantity: number, litrage: string }>,
 *   baseline: object,
 *   flavorLiters: Array<{ name: string, liters: number, cocktails: number }>
 * }}
 */
export function buildPackFromFlavorNames(flavorNames, guests, formatKey, drinksPerGuest = EVENT_DRINKS_PER_GUEST) {
  const baseline = calculateEventBaseline(guests, formatKey, drinksPerGuest);
  const catalog = preciosData.cocteles || {};
  const names = (Array.isArray(flavorNames) ? flavorNames : [])
    .map((n) => String(n || '').trim())
    .filter((n) => n && catalog[n]);
  const useNames = names.length > 0 ? names : resolveStylePackNames('CLASICOS');
  const allowed = getAllowedLitrages(formatKey);
  const shares = splitLitersAcrossFlavors(baseline.totalLiters, useNames.length, allowed);

  const flavorLiters = [];
  const products = [];
  for (let i = 0; i < useNames.length; i++) {
    const liters = shares[i] || 0;
    if (liters <= 0) continue;
    flavorLiters.push({
      name: useNames[i],
      liters,
      cocktails: cocktailsForLiters(liters)
    });
    products.push(...litersToProductLines(useNames[i], liters, allowed));
  }

  return { products, baseline, flavorLiters };
}

/**
 * messageOmitsEventLitrage: ¿El cliente nombró sabores sin indicar tamaño (5L, 10 litros, etc.)?
 * Si omitió tamaños y ya hay p/p, repartimos el total del baseline entre esos sabores.
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function messageOmitsEventLitrage(messageText) {
  const t = String(messageText || '').trim();
  if (!t) return true;
  // "5L", "10 litros", "15 lt"
  if (/\b\d+\s*(?:l|lt|lts|litros?)\b/i.test(t)) return false;
  // "5 de aperol" / "10 de mojito" (atajo de litros)
  if (/\b\d+\s+de\s+[a-záéíóúñü]/i.test(t)) return false;
  // "5 aperol" / "10 mojito" (≥5 = litros, misma regla del parser)
  if (/\b([5-9]|\d{2,})\s+[a-záéíóúñü]/i.test(t)) return false;
  return true;
}

/**
 * buildProductLinesForTargetLiters: Reparte un total de litros entre sabores (barriles válidos).
 *
 * @param {string[]} flavorNames
 * @param {number} targetLiters
 * @param {'dispensador'|'muro'|string} formatKey
 * @returns {Array<{ name: string, quantity: number, litrage: string }>}
 */
export function buildProductLinesForTargetLiters(flavorNames, targetLiters, formatKey) {
  const catalog = preciosData.cocteles || {};
  const names = [];
  for (const raw of flavorNames || []) {
    const n = String(raw || '').trim();
    if (n && catalog[n] && !names.includes(n)) names.push(n);
  }
  if (names.length === 0) return [];

  const allowed = getAllowedLitrages(formatKey);
  const shares = splitLitersAcrossFlavors(Number(targetLiters) || 0, names.length, allowed);
  const products = [];
  for (let i = 0; i < names.length; i++) {
    const liters = shares[i] || 0;
    if (liters <= 0) continue;
    products.push(...litersToProductLines(names[i], liters, allowed));
  }
  return products;
}

/**
 * applyBaselineLitersIfNamesOnly: Si hay p/p y el mensaje no trae tamaños, reparte litros del baseline.
 * Carrito vacío / corrección: reparte el total. “Agrega …” con carrito: reparte lo que falta.
 *
 * @param {Array<{ name: string, quantity?: number, litrage?: string }>} extractedList
 * @param {string} messageText
 * @param {object} session
 * @param {string} formatKey
 * @param {{ cartLiters?: number, isAdd?: boolean, isCorrection?: boolean }} [opts]
 * @returns {Array<{ name: string, quantity: number, litrage: string }>}
 */
export function applyBaselineLitersIfNamesOnly(extractedList, messageText, session, formatKey, opts = {}) {
  const list = Array.isArray(extractedList) ? extractedList : [];
  if (list.length === 0) return list;
  if (!session?.eventosDrinksPerGuest) return list;
  if (!messageOmitsEventLitrage(messageText)) return list;

  const names = [];
  for (const p of list) {
    const n = String(p?.name || '').trim();
    if (n && !names.includes(n)) names.push(n);
  }
  if (names.length === 0) return list;

  const per = Number(session.eventosDrinksPerGuest) || EVENT_DRINKS_PER_GUEST;
  const baseline = calculateEventBaseline(session.guests, formatKey, per);
  const cartLiters = Number(opts.cartLiters) || 0;
  const isAdd = Boolean(opts.isAdd);

  // “Agrega X” sin tamaño: completar lo que falta para el p/p (mínimo 1 barril chico)
  if (isAdd && cartLiters > 0) {
    const allowed = getAllowedLitrages(formatKey);
    const step = Math.min(...allowed.map((l) => parseInt(l, 10)).filter((n) => n > 0)) || 5;
    const remaining = Math.max(step, baseline.totalLiters - cartLiters);
    return buildProductLinesForTargetLiters(names, remaining, formatKey);
  }

  // Primera elección / lista de sabores / corrección: repartir el total del p/p
  return buildProductLinesForTargetLiters(names, baseline.totalLiters, formatKey);
}

/**
 * buildStylePackProductLines: Arma las líneas del carrito para un estilo + invitados.
 *
 * @param {string} styleKey
 * @param {number} guests
 * @param {'dispensador'|'muro'|string} formatKey
 * @param {number} [drinksPerGuest]
 * @returns {{
 *   products: Array<{ name: string, quantity: number, litrage: string }>,
 *   baseline: object,
 *   flavorLiters: Array<{ name: string, liters: number, cocktails: number }>
 * }}
 */
export function buildStylePackProductLines(styleKey, guests, formatKey, drinksPerGuest = EVENT_DRINKS_PER_GUEST) {
  return buildPackFromFlavorNames(
    resolveStylePackNames(styleKey),
    guests,
    formatKey,
    drinksPerGuest
  );
}

/**
 * resolveSuggestedSelectionNames: Sabores de la selección sugerida (orden comercial).
 * Mojito + Sangría → (+ Ramazzotti si más volumen) → (+ Piscola si matrimonio) → económicos.
 *
 * @param {object} session
 * @param {number} totalLiters
 * @returns {string[]}
 */
export function resolveSuggestedSelectionNames(session = {}, totalLiters = 0) {
  const catalog = preciosData.cocteles || {};
  /** @type {string[]} */
  const names = [];
  const add = (name) => {
    if (catalog[name] && !names.includes(name)) names.push(name);
  };

  for (const n of EVENT_SUGGESTED_SELECTION_ORDER.core) add(n);

  const guests = Number(session.guests) || 0;
  const per = Number(session.eventosDrinksPerGuest) || EVENT_DRINKS_PER_GUEST;
  const liters = Number(totalLiters) || 0;
  // “Más cantidad”: barra principal, muchos invitados o bastante volumen
  const needsMoreQty = per >= EVENT_DRINKS_PER_GUEST_PARTY || guests >= 60 || liters >= 25;

  if (needsMoreQty) {
    for (const n of EVENT_SUGGESTED_SELECTION_ORDER.moreQty) add(n);
  }

  const isMatrimonio = /matrimonio/i.test(String(session.celebrationType || ''));
  if (isMatrimonio && (needsMoreQty || liters >= 20 || guests >= 50)) {
    for (const n of EVENT_SUGGESTED_SELECTION_ORDER.matrimonioExtra) add(n);
  }

  let target = 2;
  if (needsMoreQty) target = 3;
  if (isMatrimonio && (needsMoreQty || liters >= 30)) target = Math.max(target, 4);
  if (liters >= 40) target = Math.max(target, 4);

  for (const n of EVENT_SUGGESTED_SELECTION_ORDER.fill) {
    if (names.length >= target) break;
    add(n);
  }

  return names.length > 0 ? names : resolveStylePackNames('CLASICOS');
}

/**
 * applyFlavorNamesToSession: Llena el carrito con una lista de sabores (reemplaza previos).
 *
 * @param {object} session
 * @param {string[]} flavorNames
 * @param {string} formatKey
 * @param {string} [styleKey='SUGERIDO']
 * @param {number|null} [drinksPerGuest=null]
 * @returns {{ baseline: object, flavorLiters: Array, styleKey: string }}
 */
export function applyFlavorNamesToSession(
  session,
  flavorNames,
  formatKey,
  styleKey = 'SUGERIDO',
  drinksPerGuest = null
) {
  ensureEventOrderBuilder(session, formatKey);
  const per = drinksPerGuest != null
    ? Number(drinksPerGuest)
    : (Number(session.eventosDrinksPerGuest) || EVENT_DRINKS_PER_GUEST);
  const { products, baseline, flavorLiters } = buildPackFromFlavorNames(
    flavorNames,
    session.guests,
    formatKey,
    per
  );

  session.orderBuilder.products = {};
  for (const p of products) {
    const key = OrderBuilder.productLineKey(p.name, p.litrage);
    const prev = session.orderBuilder.products[key];
    session.orderBuilder.products[key] = {
      name: p.name,
      litrage: p.litrage,
      quantity: (prev?.quantity || 0) + p.quantity
    };
  }

  session.eventosStyleKey = String(styleKey || 'SUGERIDO').toUpperCase();
  session.eventosDrinksPerGuest = baseline.drinksPerGuest;
  session.eventosPackProposed = true;
  session.eventosFlavorMode = 'pack';

  return { baseline, flavorLiters, styleKey: session.eventosStyleKey };
}

/**
 * applySuggestedSelectionToSession: Arma la selección sugerida progresiva.
 *
 * @param {object} session
 * @param {string} formatKey
 * @param {number|null} [drinksPerGuest=null]
 * @returns {{ baseline: object, flavorLiters: Array, styleKey: string }}
 */
export function applySuggestedSelectionToSession(session, formatKey, drinksPerGuest = null) {
  const per = drinksPerGuest != null
    ? Number(drinksPerGuest)
    : (Number(session.eventosDrinksPerGuest) || EVENT_DRINKS_PER_GUEST);
  const baselinePreview = calculateEventBaseline(session.guests, formatKey, per);
  const names = resolveSuggestedSelectionNames(session, baselinePreview.totalLiters);
  return applyFlavorNamesToSession(session, names, formatKey, 'SUGERIDO', per);
}

/**
 * applyStylePackToSession: Llena el carrito con el pack (reemplaza cócteles previos).
 *
 * @param {object} session
 * @param {string} styleKey
 * @param {string} formatKey
 * @param {number|null} [drinksPerGuest=null]
 * @returns {{ baseline: object, flavorLiters: Array, styleKey: string }}
 */
export function applyStylePackToSession(session, styleKey, formatKey, drinksPerGuest = null) {
  const key = String(styleKey || '').toUpperCase();
  if (key === 'SUGERIDO') {
    return applySuggestedSelectionToSession(session, formatKey, drinksPerGuest);
  }
  return applyFlavorNamesToSession(
    session,
    resolveStylePackNames(key),
    formatKey,
    key,
    drinksPerGuest
  );
}

/**
 * formatPackFlavorLines: Líneas “cócteles primero, litros entre paréntesis”.
 *
 * @param {Array<{ name: string, liters: number, cocktails: number }>} flavorLiters
 * @returns {string}
 */
export function formatPackFlavorLines(flavorLiters) {
  return (flavorLiters || [])
    .map((f) => `- *${f.name}* — ${f.cocktails} cócteles *(${f.liters}L)*`)
    .join('\n');
}

/**
 * styleKeyLabel: Nombre simpático del estilo para el copy.
 *
 * @param {string} styleKey
 * @returns {string}
 */
export function styleKeyLabel(styleKey) {
  const map = {
    CLASICOS: 'clásicos',
    PREMIUM: 'más premium',
    VARIADOS: 'variados',
    COMBINADOS: 'combinados',
    MOCKTAILS: 'sin alcohol',
    SUGERIDO: 'sugerida'
  };
  return map[String(styleKey || '').toUpperCase()] || 'propuesta';
}

/**
 * getEventosEstiloPhase: En ESTILO_MENU solo queda la pregunta de p/p.
 * Si ya hay cantidad, el flujo sigue en ELECCION_MENU (sabores abiertos).
 *
 * @param {object} session
 * @returns {'per_person'|'done'}
 */
export function getEventosEstiloPhase(session = {}) {
  if (!session.eventosDrinksPerGuest) return 'per_person';
  return 'done';
}

/**
 * buildPerPersonAsk: Pregunta abierta de cócteles p/p (como invitados: *pregunta* + _(ej:)_).
 *
 * @returns {string}
 */
export function buildPerPersonAsk() {
  return `*¿Cuántos cócteles por persona calculamos?*
_(ej: 2, 3 o más)_`;
}

/**
 * buildFlavorCatalogBlock: Lista corta de sabores por categoría (el catálogo de precios va en imagen).
 *
 * @returns {string}
 */
export function buildFlavorCatalogBlock() {
  return `Te recuerdo los sabores:

${getCoctelesNamesCatalogCompact()}`;
}

/**
 * buildFlavorPickQuestion: Pregunta abierta de sabores (+ soft CTA sugerida).
 * Sin pie HUMANO: va en burbuja propia después de la lista.
 *
 * @returns {string}
 */
export function buildFlavorPickQuestion() {
  return `*¿Cuáles te gustaría incluir?*
_(ej: Mojito y Sangría — o ${EVENT_COCKTAIL_ORDER_EXAMPLE})_

Si prefieres, te armo una *selección sugerida* y la ajustamos 😊`;
}

/**
 * buildFlavorPickAsk: Re-pregunta corta (sin re-listar todo el catálogo).
 *
 * @returns {string}
 */
export function buildFlavorPickAsk() {
  return buildFlavorPickQuestion();
}

/**
 * buildStyleMenuQuestion: Menú legacy de estilo (solo si algún atajo lo reutiliza).
 *
 * @returns {string}
 */
export function buildStyleMenuQuestion() {
  return `*¿Qué pack prefieres?*

${MENU_WRITE_CTA}
${formatMenuBlock(EVENT_STYLE_MENU_LABELS)}

_(Si prefieres *Combinados* o *sin alcohol*, dímelo y te armo esa opción 😊)_`;
}

/**
 * buildStyleEntryReplies: Tras “quiero cotizar” → pregunta abierta de p/p.
 *
 * @param {object} session
 * @param {string} formatKey
 * @returns {string[]}
 */
export function buildStyleEntryReplies(session, formatKey) {
  session.eventosFlavorMode = null;
  session.eventosStyleKey = null;
  session.eventosDrinksPerGuest = null;
  session.eventosPackProposed = false;
  void formatKey;

  const ack = nextEventosAck(session);
  const celebration = session.celebrationType ? `tu *${session.celebrationType}*` : 'tu evento';
  const guestsBit = session.guests
    ? `de *${session.guests}* invitados`
    : '';

  return [`${ack}, armemos tu cotización 🥂

Para ${celebration}${guestsBit ? ` ${guestsBit}` : ''}:

${buildPerPersonAsk()}`];
}

/**
 * buildFlavorPickEntryReplies: Tras Ver Precios → lista de sabores + pregunta (sin re-confirmar p/p).
 *
 * @param {object} session
 * @param {string} formatKey
 * @param {number} per
 * @returns {string[]}
 */
export function buildFlavorPickEntryReplies(session, formatKey, per) {
  session.eventosDrinksPerGuest = per;
  session.eventosFlavorMode = 'free';
  session.eventosStyleKey = null;
  session.eventosPackProposed = false;
  void formatKey;

  return [
    buildFlavorCatalogBlock(),
    buildFlavorPickQuestion()
  ];
}

/** Alias: mismo camino que buildFlavorPickEntryReplies (compat tests / callers). */
export function buildPerPersonConfirmReplies(session, formatKey, per) {
  return buildFlavorPickEntryReplies(session, formatKey, per);
}

/**
 * parsePerPersonChoice: Número suelto o frase (“2”, “3 por persona”, “complemento”).
 *
 * @param {string} messageText
 * @returns {{ per: number }|null}
 */
export function parsePerPersonChoice(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (/\bcomplemento\b/i.test(lower)) return { per: 2 };
  if (/\bbarra\s+principal\b/i.test(lower) || /\bm[aá]s\s+fiesta\b/i.test(lower)) return { per: 3 };

  const m = lower.match(/^(\d{1,2})\s*(?:por\s+persona|p\/?p|pp|c[oó]cteles?)?\.?$/i)
    || lower.match(/\b(\d{1,2})\s*(?:por\s+persona|p\/?p|pp)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 10) return { per: n };
  }
  return null;
}

/**
 * wantsSuggestedSelection: ¿Pide que le armemos la selección sugerida?
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function wantsSuggestedSelection(messageText) {
  const raw = String(messageText || '').trim();
  if (!raw) return false;
  const t = raw.toLowerCase();

  if (/^(sugerid[oa]|recomienda|recomendaci[oó]n|armame|ármame)$/i.test(raw)) return true;
  if (/\bselecci[oó]n\s+sugerida\b/.test(t)) return true;
  if (/\bpack\s+sugerido\b/.test(t)) return true;
  if (/\bsugerid[oa]\b/.test(t)) return true;
  if (/\brecomi[eé]nd/.test(t)) return true;
  if (/\barmame\b|\bármame\b/.test(t)) return true;
  if (/\barma(me|nos)?\s+(una|la|tu)?\s*(selecci[oó]n|propuesta|pack)?\b/.test(t)) return true;
  if (/\bt[uú]\s+(eliges?|armas?|propones?)\b/.test(t)) return true;
  if (/\bcomo\s+sugieres\b/.test(t)) return true;
  return false;
}

/**
 * parseFlavorModeChoice: Legacy — ya no hay menú pack vs libre.
 * Mapea pedidos de sugerido / “yo elijo” por compatibilidad.
 *
 * @param {string} messageText
 * @returns {'PACK'|'FREE'|null}
 */
export function parseFlavorModeChoice(messageText) {
  if (wantsSuggestedSelection(messageText)) return 'PACK';
  if (wantsSelfBuildEventMenu(messageText)) return 'FREE';
  return null;
}

/**
 * buildPackProposalReply: Texto del pack armado + CTA a *ok* / ajustar.
 *
 * @param {object} session
 * @param {string} formatKey
 * @param {{ baseline: object, flavorLiters: Array, styleKey: string }} pack
 * @returns {{ reply: string, followUp: string, quote: object }}
 */
export function buildPackProposalReply(session, formatKey, pack) {
  const orderBuilder = new OrderBuilder(formatKey, preciosData);
  orderBuilder.products = session.orderBuilder?.products || {};
  const quote = orderBuilder.calculateQuote();
  const styleLabel = styleKeyLabel(pack.styleKey);
  const celebration = session.celebrationType ? `para tu *${session.celebrationType}*` : '';

  let reply = `Te armé una propuesta *${styleLabel}* ${celebration} 🍸\n\n`;
  reply += formatPackFlavorLines(pack.flavorLiters);
  reply += `\n\n≈ *${pack.baseline.totalCocktails || cocktailsForLiters(pack.baseline.totalLiters)}* cócteles`;
  if (pack.baseline.guests) {
    reply += ` (~${pack.baseline.drinksPerGuest} por persona)`;
  }
  reply += ` · *${pack.baseline.totalLiters}L* en total`;
  reply += `\n*Subtotal cócteles:* ${formatPrice(quote.subtotal || 0)}`;
  if (formatKey === 'muro' && (quote.installation || 0) > 0) {
    reply += `\n_Instalación Muro: ${formatPrice(quote.installation)} (se suma al cerrar)_`;
  }

  const followUp = `*¿Te armo la cotización formal con esto?*
_(escribe *ok* para seguir, o dime qué sabor cambiar / agregar)_

_(si quieres más tragos: *más cantidad*)_`;

  return { reply, followUp, quote };
}

/**
 * asksEventCombinadosInfo: ¿Pregunta por Combinados / piscola / whiskycola?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function asksEventCombinadosInfo(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  return /\bcombinados?\b/.test(t)
    || /\bpiscolas?\b/.test(t)
    || /\bwhiskycola\b|\bwhiskcola\b|\bwhiskey\s*cola\b/.test(t)
    || /\bpisco\s+con\s+bebida\b/.test(t);
}

/**
 * asksEventMocktailsInfo: ¿Pregunta por sin alcohol / mocktails?
 * (delegamos el patrón fuerte a wantsNonAlcoholicOption en el estado)
 *
 * @param {string} text
 * @returns {boolean}
 */
export function asksEventMocktailsInfo(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  return /\bmocktails?\b/.test(t)
    || /\bsin\s+alcohol\b/.test(t)
    || /\bno\s+alcoh[oó]lic/.test(t)
    || /\bcero\s+alcohol\b/.test(t)
    || /\b0\s*%?\s*alcohol\b/.test(t)
    || /\blibre\s+de\s+alcohol\b/.test(t)
    || /\bpara\s+(ni[nñ]os|embarazadas|abstemios)\b/.test(t);
}

/**
 * wantsSelfBuildEventMenu: ¿Prefiere armar la carta a mano (escape del pack)?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function wantsSelfBuildEventMenu(text) {
  const t = String(text || '').toLowerCase();
  return /\barmar\s+(yo|a\s+mano|el\s+pedido)\b/.test(t)
    || /\belegir\s+(yo|a\s+mano|los\s+sabores)\b/.test(t)
    || /\bver\s+(la\s+)?carta\b/.test(t)
    || /\bprefiero\s+(elegir|armar|yo)\b/.test(t)
    || /\byo\s+(elijo|armo|escojo)\b/.test(t)
    || /\blista\s+de\s+precios\b/.test(t);
}

/**
 * buildCombinadosInfoReply: Respuesta sólida (tono vendedor CL) + vuelta al menú.
 *
 * @param {boolean} [includeStyleMenu=true]
 * @returns {string}
 */
export function buildCombinadosInfoReply(includeStyleMenu = true) {
  const cats = getCoctelesByCategoria();
  const names = (cats.COMBINADOS || []).map((c) => c.name);
  const list = names.length
    ? names.map((n) => `- ${n}`).join('\n')
    : '- Piscolas y Whiskcola según carta';

  let text = `Claro 🥃 Los *Combinados* son más de barra clásica: pisco o whisky con bebida a elección.

Tenemos por ejemplo:
${list}

Van muy bien si el público es más de piscola que de cóctel elaborado. Si quieres, te armo el pack con *Combinados* (mismo cálculo de 2 p/p).`;

  if (includeStyleMenu) {
    text += `\n\nEscribe *combinados* para esa propuesta, o dime los cócteles que prefieres 😊`;
  }
  return text;
}

/**
 * buildMocktailsInfoReply: Respuesta sólida sin alcohol + vuelta al menú.
 *
 * @param {boolean} [includeStyleMenu=true]
 * @returns {string}
 */
export function buildMocktailsInfoReply(includeStyleMenu = true) {
  const cats = getCoctelesByCategoria();
  const names = (cats.MOCKTAILS || []).map((c) => c.name);
  const list = names.length
    ? names.map((n) => `- ${n}`).join('\n')
    : '- Versiones Mocktail de la carta';

  let text = `Claro 🍹 También tenemos *sin alcohol (Mocktails)*: misma frescura, cero graduación. Ideal si hay abstemios, embarazadas o quieres una estación para todos.

Opciones:
${list}

Si quieres, te armo la propuesta completa *sin alcohol* con el mismo cálculo de 2 p/p.`;

  if (includeStyleMenu) {
    text += `\n\nEscribe *sin alcohol* para esa propuesta, o el nombre del Mocktail que quieres 🍹`;
  }
  return text;
}

/**
 * wantsMoreEventQuantity: ¿Quiere subir de 2 p/p a más tragos?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function wantsMoreEventQuantity(text) {
  const t = String(text || '').toLowerCase();
  return /\bm[aá]s\s+(cantidad|tragos?|c[oó]cteles|consumo|fiesta)\b/.test(t)
    || /\bsube(r)?\s+(la\s+)?(cantidad|consumo)\b/.test(t)
    || /\b3\s*(p\/p|por\s+persona)\b/.test(t)
    || /\bsubamos\b/.test(t)
    || /^(m[aá]s\s+cantidad|m[aá]s\s+tragos?)$/i.test(t.trim());
}

/**
 * detectSideStyleFromText: Si el mensaje pide directo combinados/mocktails como pack.
 *
 * @param {string} text
 * @returns {'COMBINADOS'|'MOCKTAILS'|null}
 */
export function detectSideStyleFromText(text) {
  const t = String(text || '').toLowerCase();
  // Pedido de armar / quiero esos (no solo “qué son”)
  const wantsPack = /\b(quiero|armame|ármame|arme|dale|esa\s+opci[oó]n|pack|propuesta|cotiz)/i.test(t)
    || /^(combinados?|sin\s+alcohol|mocktails?)$/i.test(t.trim());

  if (asksEventMocktailsInfo(text) && wantsPack) return 'MOCKTAILS';
  if (asksEventCombinadosInfo(text) && wantsPack) return 'COMBINADOS';

  // Mensaje corto solo con la categoría → lo tratamos como elección de pack
  if (/^(combinados?|piscola|piscolas)$/i.test(t.trim())) return 'COMBINADOS';
  if (/^(sin\s+alcohol|mocktails?|mocktail)$/i.test(t.trim())) return 'MOCKTAILS';

  return null;
}
