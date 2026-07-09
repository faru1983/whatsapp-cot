// ==============================================================================
// OBJETIVO: Calculadora de cotizaciones (Order Builder).
// Esta clase suma precios de cócteles y extras según datos.json.
// La usan el flujo de Barriles Desechables (tipo 'desechable') y el de
// Eventos (tipos 'dispensador' | 'muro') para armar totales sin inventar precios.
// ==============================================================================

/**
 * OrderBuilder: Representa un pedido en construcción.
 * Guarda productos, extras y datos del cliente, y calcula totales.
 *
 * Formato de products:
 * - Barriles: { "Mojito": 2 }  → cantidad (siempre 5L)
 * - Eventos:  { "Mojito::10L": { name: "Mojito", quantity: 1, litrage: "10L" } }
 *
 * @param {string} type - Tipo de pedido: 'desechable' | 'dispensador' | 'muro'
 * @param {object} preciosData - Objeto cargado desde db/datos.json
 */
export class OrderBuilder {
  constructor(type, preciosData) {
    this.type = type;
    this.preciosData = preciosData;

    // Productos elegidos (ver formatos arriba en el JSDoc)
    this.products = {};

    // Complementos opcionales (hielo, decoración, etc.) — hoy solo barriles
    this.extras = {};

    // Datos de entrega / evento que pide el bot al cliente
    this.clientData = {
      name: null,
      date: null,
      location: null,
      guests: null // Solo se usa en flujo de eventos
    };
  }

  /**
   * productLineKey: Arma la clave interna de un ítem de evento.
   * Así "Mojito 10L" y "Mojito 20L" no se pisan en el mismo objeto.
   *
   * @param {string} name - Nombre oficial del cóctel
   * @param {string} litrage - Litraje (ej. "10L")
   * @returns {string} Clave compuesta name::litrage
   */
  static productLineKey(name, litrage) {
    return `${name}::${litrage}`;
  }

  /**
   * normalizeProductEntry: Unifica el formato de un ítem del carrito.
   * Acepta número (barriles) u objeto (eventos) y devuelve siempre
   * { name, quantity, litrage }.
   *
   * @param {string} key - Clave del producto en this.products
   * @param {number|object} value - Cantidad o { name, quantity, litrage }
   * @returns {{ name: string, quantity: number, litrage: string }|null}
   */
  normalizeProductEntry(key, value) {
    // Caso barriles: value es solo la cantidad (número)
    if (typeof value === 'number') {
      const litrage = this.type === 'desechable' ? '5L'
        : this.type === 'dispensador' ? '5L'
        : '10L';
      return { name: key, quantity: value, litrage };
    }

    // Caso eventos: value es un objeto con name, quantity y litrage
    if (value && typeof value === 'object') {
      const name = value.name || key.split('::')[0];
      const quantity = Number(value.quantity) || 0;
      const litrage = value.litrage || (this.type === 'muro' ? '10L' : '5L');
      if (!name || quantity <= 0) return null;
      return { name, quantity, litrage };
    }

    return null;
  }

  /**
   * getTotalLiters: Suma los litros de todos los barriles del pedido.
   * Sirve para validar el mínimo de eventos (10L dispensador / 30L muro).
   *
   * @returns {number} Litros totales del carrito
   */
  getTotalLiters() {
    let total = 0;
    for (const [key, value] of Object.entries(this.products)) {
      const entry = this.normalizeProductEntry(key, value);
      if (!entry) continue;
      // "10L" → 10
      const liters = parseInt(String(entry.litrage).replace(/\D/g, ''), 10) || 0;
      total += liters * entry.quantity;
    }
    return total;
  }

  /**
   * calculateQuote: Suma todos los ítems y devuelve subtotal, despacho, instalación y total.
   * Los precios NUNCA se inventan: siempre se leen de preciosData (datos.json).
   *
   * @param {number|null} deliveryCost - Costo de despacho/logística si la comuna está en RM; null si es región
   * @returns {object} Cotización con detalles línea por línea
   */
  calculateQuote(deliveryCost = null) {
    const cocteles = this.preciosData.cocteles || {};
    const extras = this.preciosData.extras || {};
    const rendimientos = this.preciosData.rendimientos_barriles || {};
    let subtotal = 0;
    let totalLiters = 0;
    let totalDrinks = 0;
    const details = []; // Detalle línea por línea para mostrar al cliente
    const missingPrices = []; // Litrajes que no existen en el catálogo

    // ==============================================================================
    // 1. SUMAR CÓCTELES
    // ==============================================================================
    for (const [key, value] of Object.entries(this.products)) {
      const entry = this.normalizeProductEntry(key, value);
      if (!entry) continue;

      const coctel = cocteles[entry.name];
      if (!coctel) continue; // Si el nombre no existe en el catálogo, lo ignoramos

      // Según el tipo de pedido, buscamos la clave correcta en el JSON de precios
      const priceKey = this.type === 'desechable' ? 'desechable' : this.type;
      const price = coctel[priceKey]?.[entry.litrage];

      // Si el litraje no existe para ese formato, lo anotamos (no inventamos precio)
      if (price == null || price === 0) {
        missingPrices.push({ name: entry.name, litrage: entry.litrage });
        continue;
      }

      const lineTotal = price * entry.quantity;
      subtotal += lineTotal;

      // Litros y tragos estimados (5 tragos por litro, o tabla rendimientos_barriles)
      const litersPerUnit = parseInt(String(entry.litrage).replace(/\D/g, ''), 10) || 0;
      const lineLiters = litersPerUnit * entry.quantity;
      const drinksPerBarrel = rendimientos[entry.litrage] || (litersPerUnit * 5);
      totalLiters += lineLiters;
      totalDrinks += drinksPerBarrel * entry.quantity;

      details.push({
        name: entry.name,
        quantity: entry.quantity,
        litrage: entry.litrage,
        price,
        lineTotal
      });
    }

    // ==============================================================================
    // 2. SUMAR EXTRAS (hielo, decoración, etc.) — típico de barriles
    // ==============================================================================
    for (const [extraName, quantity] of Object.entries(this.extras)) {
      const price = extras[extraName];
      if (!price) continue;

      const lineTotal = price * quantity;
      subtotal += lineTotal;
      details.push({ name: extraName, quantity, price, lineTotal, isExtra: true });
    }

    // ==============================================================================
    // 3. INSTALACIÓN (solo muro de coctelería)
    // ==============================================================================
    const installation = this.type === 'muro'
      ? (this.preciosData.instalacion_muro || 0)
      : 0;

    // ==============================================================================
    // 4. ARMAR RESULTADO FINAL
    // ==============================================================================
    const baseTotal = subtotal + installation;
    return {
      subtotal,
      installation,
      delivery: deliveryCost || null,
      // Si conocemos despacho, sumamos; si no, el total es subtotal + instalación
      total: deliveryCost !== null ? baseTotal + deliveryCost : baseTotal,
      details,
      totalLiters,
      totalDrinks,
      missingPrices,
      hasUnknownDelivery: deliveryCost === null
    };
  }
}
