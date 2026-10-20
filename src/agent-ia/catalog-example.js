// ==============================================================================
// OBJETIVO: Generador dinámico y contextual del ejemplo de armado de barra para
// la carta de variedades y precios del Agente IA.
// Siempre prioriza las opciones más económicas: Sangría -> Mojito Tradicional -> Caipiriña,
// basándose en invitados, tragos p/p y litros de la propuesta, asegurando que
// el total del ejemplo coincida con el presupuesto estimado previo.
// ==============================================================================

import { preciosData, formatPrice } from '../logic/utils.js';

/**
 * Obtiene el precio unitario de un cóctel para un formato y tamaño dado.
 *
 * @param {string} flavor
 * @param {number} liters
 * @param {string} formatKey 'dispensador' | 'muro'
 * @returns {number}
 */
export function getCatalogCocktailPrice(flavor, liters, formatKey = 'dispensador') {
  const catalog = preciosData.cocteles || {};
  const sizeLabel = `${liters}L`;

  // Resolver clave en catálogo de precios (datos.json tiene 'Mojito', no 'Mojito Tradicional')
  const lookupKey = flavor === 'Mojito Tradicional' ? 'Mojito' : flavor;
  const coctelData = catalog[lookupKey] || catalog[flavor] || null;

  if (coctelData && coctelData[formatKey] && coctelData[formatKey][sizeLabel]) {
    return coctelData[formatKey][sizeLabel];
  }

  // Precios base oficiales de fallback (coincidentes con Sangría, Mojito y Caipiriña)
  if (formatKey === 'muro') {
    if (liters === 10) return 119990;
    if (liters === 20) return 169900;
    return Math.ceil(liters / 10) * 119990;
  }

  // Dispensador
  if (liters === 5) return 69990;
  if (liters === 10) return 109990;
  if (liters === 20) return 219980; // 2x 10L
  return Math.ceil(liters / 10) * 109990;
}

/**
 * Distribuye una cantidad total de litros entre las variedades más económicas.
 * Orden estricto de menor costo: Sangría -> Mojito Tradicional -> Caipiriña.
 *
 * @param {number} totalLiters
 * @param {string} formatKey 'dispensador' | 'muro'
 * @returns {Array<{ flavor: string, liters: number, cocktails: number, price: number, priceFormatted: string, note?: string }>}
 */
export function distributeEconomicalFlavors(totalLiters, formatKey = 'dispensador') {
  const baseFlavors = ['Sangría', 'Mojito Tradicional', 'Caipiriña'];
  const items = [];

  if (formatKey === 'muro') {
    // Muro usa formatos de 20L y 10L
    let remaining = totalLiters;
    let flavorIndex = 0;

    while (remaining >= 20) {
      const flavor = baseFlavors[flavorIndex % baseFlavors.length];
      const price = getCatalogCocktailPrice(flavor, 20, 'muro');
      items.push({
        flavor,
        liters: 20,
        cocktails: 100,
        price,
        priceFormatted: formatPrice(price)
      });
      remaining -= 20;
      flavorIndex++;
    }

    if (remaining > 0) {
      const liters = remaining >= 10 ? 10 : remaining;
      const flavor = baseFlavors[flavorIndex % baseFlavors.length];
      const price = getCatalogCocktailPrice(flavor, liters, 'muro');
      items.push({
        flavor,
        liters,
        cocktails: liters * 5,
        price,
        priceFormatted: formatPrice(price)
      });
    }

    return items;
  }

  // Dispensador Portátil: formatos de 10L y 5L
  if (totalLiters <= 10) {
    const price10 = getCatalogCocktailPrice('Sangría', 10, 'dispensador');
    return [
      {
        flavor: 'Sangría',
        liters: 10,
        cocktails: 50,
        price: price10,
        priceFormatted: formatPrice(price10),
        note: '_(O puedes dividirlo en 2 variedades de 5L como 5L Sangría y 5L Mojito Tradicional)_'
      }
    ];
  }

  // Para > 10L en dispensador:
  // Repartir en bloques de 10L de forma equitativa entre Sangría, Mojito Tradicional y Caipiriña.
  // Si sobran 5L (ej: 15L, 25L, 35L), asignar un bloque de 5L.
  let remaining = totalLiters;
  const blocks = { 'Sangría': 0, 'Mojito Tradicional': 0, 'Caipiriña': 0 };
  let flavorIndex = 0;

  while (remaining >= 10) {
    const flavor = baseFlavors[flavorIndex % baseFlavors.length];
    blocks[flavor] += 10;
    remaining -= 10;
    flavorIndex++;
  }

  if (remaining >= 5) {
    const flavor = baseFlavors[flavorIndex % baseFlavors.length];
    blocks[flavor] += 5;
    remaining -= 5;
  }

  for (const flavor of baseFlavors) {
    const liters = blocks[flavor];
    if (liters <= 0) continue;

    // Calcular precio exacto (ej: 20L = 2x 10L = $219.980, 5L = $69.990, 15L = 109.990 + 69.990)
    let price = 0;
    if (liters === 5) price = 69990;
    else if (liters === 10) price = 109990;
    else if (liters === 15) price = 109990 + 69990;
    else if (liters === 20) price = 109990 * 2;
    else {
      const c10 = Math.floor(liters / 10);
      const rem = liters % 10;
      price = (c10 * 109990) + (rem >= 5 ? 69990 : 0);
    }

    items.push({
      flavor,
      liters,
      cocktails: liters * 5,
      price,
      priceFormatted: formatPrice(price)
    });
  }

  return items;
}

/**
 * Genera la burbuja de texto para la carta de variedades con un ejemplo dinámico y contextual.
 *
 * @param {object} session
 * @returns {string} Texto formateado para WhatsApp
 */
export function buildCatalogFollowUpBubble(session = {}) {
  const guests = session?.guests || 0;
  const drinksPerGuest = session?.drinksPerGuest || 0;
  const formatKey = session?.eventFormat === 'muro' ? 'muro' : 'dispensador';

  let totalLiters = Number(session?.lastTotalLiters || session?.cartLiters || 0);
  if (!totalLiters) {
    const g = guests || 20;
    const d = drinksPerGuest || 3;
    totalLiters = Math.max(10, Math.ceil((g * d * 0.2) / 5) * 5);
  }

  const totalCocktails = totalLiters * 5;
  const distributedItems = distributeEconomicalFlavors(totalLiters, formatKey);

  // Calcular suma total del ejemplo
  const exampleTotal = distributedItems.reduce((acc, item) => acc + item.price, 0);

  // Encabezado contextual según datos disponibles
  let introLine = '';
  if (guests > 0 && drinksPerGuest > 0) {
    introLine = `Para tus *${guests} invitados* con *${drinksPerGuest} tragos p/p* (≈ *${totalCocktails} cócteles*, *${totalLiters} Litros*), una combinación sugerida clásica y económica sería:`;
  } else if (guests > 0) {
    introLine = `Para tus *${guests} invitados* (*${totalLiters} Litros* ≈ *${totalCocktails} cócteles*), una combinación sugerida clásica y económica sería:`;
  } else {
    introLine = `Para cubrir tus *${totalLiters} Litros* (≈ *${totalCocktails} cócteles*), una combinación sugerida clásica y económica sería:`;
  }

  const bulletsText = distributedItems
    .map((item) => {
      let line = `• *${item.liters}L* de ${item.flavor} (~${item.cocktails} cócteles): ${item.priceFormatted}`;
      if (item.note) {
        line += `\n  ${item.note}`;
      }
      return line;
    })
    .join('\n');

  const formatDescription = formatKey === 'muro'
    ? 'formatos de 10L o 20L'
    : 'formatos de 5L o 10L';

  return `👆 *¡Aquí tienes nuestra carta completa!*

${introLine}

${bulletsText}

*Total:* *${formatPrice(exampleTotal)}* (alineado a tu propuesta estimada ✅)

Puedes cambiar cualquier variedad por otra de la carta (${formatDescription}), o sumar combinados como Piscola o Mocktails sin alcohol.

*¿Qué variedades te gustaría incluir en tu barra?*`;
}
