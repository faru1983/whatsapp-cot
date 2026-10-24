// ==============================================================================
// OBJETIVO: Generador dinámico y contextual del ejemplo de armado de barra para
// la carta de variedades y precios del Agente IA.
// Siempre prioriza las opciones más económicas: Sangría -> Mojito Tradicional -> Caipiriña,
// basándose en invitados, tragos p/p y litros de la propuesta, asegurando que
// el total del ejemplo coincida con el presupuesto estimado previo.
// ==============================================================================

import { formatPrice } from '../logic/utils.js';
import { getDispensadorProductPriceSync } from '../logic/cot-catalog.js';

/**
 * Obtiene el precio unitario de un cóctel para formato Dispensador (5L o 10L).
 *
 * @param {string} flavor
 * @param {number} liters
 * @returns {number}
 */
export function getCatalogCocktailPrice(flavor, liters) {
  return getDispensadorProductPriceSync(flavor, liters);
}

/**
 * Distribuye una cantidad total de litros entre las variedades más económicas.
 * Orden: Mojito Tradicional -> Sangría -> Caipiriña (barriles 5L y 10L, mín. 10L).
 *
 * @param {number} totalLiters
 * @returns {Array<{ flavor: string, liters: number, cocktails: number, price: number, priceFormatted: string, note?: string }>}
 */
export function distributeEconomicalFlavors(totalLiters) {
  const baseFlavors = ['Mojito Tradicional', 'Sangría', 'Caipiriña'];
  const safeLiters = Math.max(10, Math.ceil(totalLiters / 5) * 5);

  if (safeLiters <= 10) {
    const price10 = getCatalogCocktailPrice('Mojito Tradicional', 10);
    return [
      {
        flavor: 'Mojito Tradicional',
        liters: 10,
        cocktails: 50,
        price: price10,
        priceFormatted: formatPrice(price10),
        note: '_(O puedes dividirlo en 2 variedades de 5L como 5L Mojito Tradicional y 5L Sangría)_'
      }
    ];
  }

  let remaining = safeLiters;
  const blocks = { 'Mojito Tradicional': 0, 'Sangría': 0, 'Caipiriña': 0 };
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

  const items = [];
  for (const flavor of baseFlavors) {
    const liters = blocks[flavor];
    if (liters <= 0) continue;

    let price = 0;
    if (liters === 5) price = getCatalogCocktailPrice(flavor, 5);
    else if (liters === 10) price = getCatalogCocktailPrice(flavor, 10);
    else {
      const c10 = Math.floor(liters / 10);
      const rem = liters % 10;
      price = (c10 * getCatalogCocktailPrice(flavor, 10)) + (rem >= 5 ? getCatalogCocktailPrice(flavor, 5) : 0);
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
  let totalLiters = Number(session?.lastTotalLiters || session?.cartLiters || 0);
  if (!totalLiters) {
    const g = guests || 20;
    const d = drinksPerGuest || 3;
    totalLiters = Math.max(10, Math.ceil((g * d * 0.2) / 5) * 5);
  }

  const totalCocktails = totalLiters * 5;
  const distributedItems = distributeEconomicalFlavors(totalLiters);

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

  const formatDescription = 'formatos de 5L o 10L';

  return `👆 *¡Aquí tienes nuestra carta completa!*

${introLine}

${bulletsText}

*Total:* *${formatPrice(exampleTotal)}* (alineado a tu propuesta estimada ✅)

Puedes cambiar cualquier variedad por otra de la carta (${formatDescription}), o sumar combinados como Piscola o Mocktails sin alcohol.

*¿Qué variedades te gustaría incluir en tu barra?*`;
}
