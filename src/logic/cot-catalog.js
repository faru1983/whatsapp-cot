// ==============================================================================
// OBJETIVO: Resolver nombres del bot → productId + size exactos de la API web.
// Prefiere GET /api/v1/catalog (con caché). Si falla, usa mapa de respaldo.
// ==============================================================================

import { fetchCatalogViaApi, isCotApiConfigured } from './cot-api.js';

// ==============================================================================
// 1. ALIASES (nombres cortos del bot → nombre oficial en Supabase)
// ==============================================================================

/**
 * ALIASES: Nombre en el bot (datos.json) → nombre oficial en el catálogo web.
 * Solo cuando difieren; si coinciden, no hace falta alias.
 */
const PRODUCT_NAME_ALIASES = {
  Mojito: 'Mojito Tradicional',
  'Pisco Sour': 'Pisco Sour Clásico',
  'Gin & Tonic': 'Gin and Tonic',
  'Piscola Alto 35°': 'Piscola Alto del Carmen 35°',
  'Whiskcola J.W. Black': 'Whiskcola Johnnie Walker Black Label 40°',
  'Mojito Mocktail': 'Mojito Tradicional Sin Alcohol',
  'Mojito Maracuyá Mocktail': 'Mojito Maracuyá Sin Alcohol',
  'Mojito Frambuesa Mocktail': 'Mojito Frambuesa Sin Alcohol',
  'Mojito Mango Mocktail': 'Mojito Mango Sin Alcohol',
  'Sangría Mocktail': 'Sangría Sin Alcohol',
  'Maracuyá Spritz Mocktail': 'Maracuyá Spritz Sin Alcohol'
};

/**
 * FALLBACK_PRODUCT_IDS: Respaldo si la API de catálogo no responde.
 * Preferimos siempre el catálogo vivo; esto evita romper cotizaciones offline.
 */
const FALLBACK_PRODUCT_IDS = {
  'Aperol Spritz': 'dbcdd700-b615-4db6-9788-687ef5b63649',
  Caipiriña: '268ed121-e620-466e-8abb-b39299709707',
  'Gin and Tonic': '7deae72e-350c-4a57-899b-069cc518c307',
  'Maracuyá Spritz Sin Alcohol': '243d3bda-81f4-4fee-aabd-baf92d7eaf4b',
  'Mojito Frambuesa': '1e8987e7-3b92-4692-8a6f-9ee4ba23039a',
  'Mojito Frambuesa Sin Alcohol': 'd7de61a4-320e-43c5-b0b7-79662790348f',
  'Mojito Mango': 'f6a44325-283e-4287-b6aa-100ad22e93ec',
  'Mojito Mango Sin Alcohol': 'e6a1ccd2-bbd4-402d-8400-09bbc64fb6a5',
  'Mojito Maracuyá': 'ca90dc37-aade-47e8-9225-33d5c57da2f5',
  'Mojito Maracuyá Sin Alcohol': '44d07469-8fc8-4e1c-95bc-a0e8983520ad',
  'Mojito Tradicional': '1e082c45-7d2a-4b4f-9e54-2b067f1a703c',
  'Mojito Tradicional Sin Alcohol': 'e259d729-11d7-446b-8ab2-b4bdea7195b2',
  'Moscow Mule': '12725049-16a4-43e0-8e28-249181102a12',
  'Pisco Sour Clásico': '9106990e-aa3b-4689-9ab6-0a9f616c68c6',
  'Piscola 3R Transparente 40°': 'd48707ff-d6d3-4a3e-add1-218a9807fe67',
  'Piscola Alto del Carmen 35°': '0a31e923-b026-4baf-8760-3043c599d849',
  'Piscola Alto Transparente 40°': 'c6e3885e-824e-4cc8-be75-561ef993ba80',
  'Piscola Mistral 35°': '65691706-352a-4520-932d-ea4b2fccdaa8',
  'Ramazzotti Spritz': '2dc07636-b04a-4d25-b5e4-d4c4dd56626f',
  Sangría: 'd09b5819-092f-4620-9ca4-08e18fc5a8b9',
  'Sangría Sin Alcohol': '65939799-6e39-470e-82c2-af8085362e27',
  'Tequila Margarita': 'f7f6231f-691c-4f0c-a980-f6e933b2368e',
  'Tropical Gin': '484f97df-4d0e-4837-a82b-b2fe604e7799',
  'Whiskcola Johnnie Walker Black Label 40°': 'af04e304-091b-4ee2-92d7-624c19c9eef6'
};

/** TTL del catálogo en memoria (igual que la caché server de la web: 5 min). */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * cache: Catálogo en RAM del proceso Node.
 * - productsByName: Map nombre oficial → { id, sizes[] }
 * - raw: respuesta completa (comunas, eventTypes) por si hace falta después
 */
let cache = {
  productsByName: null,
  raw: null,
  expiresAt: 0,
  source: null // 'api' | 'fallback' | 'stale'
};

/** Evita dos GET en paralelo al mismo tiempo. */
let inflightPromise = null;

// ==============================================================================
// 2. NORMALIZACIÓN Y RESOLUCIÓN DE NOMBRES / TAMAÑOS
// ==============================================================================

/**
 * normalizeCatalogName: Minúsculas sin acentos para comparar nombres.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeCatalogName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * resolveOfficialProductName: Traduce el nombre del bot al de la web.
 *
 * @param {string} botName - Ej. "Mojito"
 * @returns {string} Nombre en Supabase
 */
export function resolveOfficialProductName(botName) {
  const name = String(botName || '').trim();
  return PRODUCT_NAME_ALIASES[name] || name;
}

/**
 * parseLitrageValue: Extrae el número de litros desde "10L" / "10 L".
 *
 * @param {string} litrage
 * @returns {number|null}
 */
function parseLitrageValue(litrage) {
  const raw = String(litrage || '').trim().toUpperCase().replace(/\s+/g, '');
  const match = raw.match(/^(\d+(?:\.\d+)?)L/);
  return match ? Number(match[1]) : null;
}

/**
 * resolveEventSizeLabel: Etiqueta de tamaño para eventos (no desechable).
 * Fallback cuando no hay catálogo vivo: "5L", "10L", etc.
 *
 * @param {string} litrage - Ej. "10L" desde el carrito del bot
 * @returns {string}
 */
export function resolveEventSizeLabel(litrage) {
  const value = parseLitrageValue(litrage);
  if (value == null) return String(litrage || '').trim();
  return `${value}L`;
}

/**
 * resolveSizeFromProduct: Elige la etiqueta `size` exacta del catálogo.
 * Eventos: tamaño no desechable con el mismo sizeValue.
 *
 * @param {{ sizes?: Array<{ size: string, sizeValue: number, isDisposable: boolean }> }} product
 * @param {string} litrage - Ej. "10L"
 * @param {{ disposable?: boolean }} [opts]
 * @returns {string|null}
 */
function resolveSizeFromProduct(product, litrage, opts = {}) {
  const wantDisposable = Boolean(opts.disposable);
  const value = parseLitrageValue(litrage);
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];

  if (value != null && sizes.length) {
    const match = sizes.find(
      (s) => Number(s.sizeValue) === value && Boolean(s.isDisposable) === wantDisposable
    );
    if (match?.size) return match.size;
  }

  // Fallback por etiqueta textual (ej. ya viene "10L" o "5L - Desechable")
  const label = wantDisposable
    ? `${resolveEventSizeLabel(litrage)} - Desechable`
    : resolveEventSizeLabel(litrage);
  if (sizes.some((s) => s.size === label)) return label;
  return sizes.length ? null : label;
}

/**
 * buildIndexFromProducts: Arma Map nombre → producto (id + sizes).
 *
 * @param {Array<{ id: string, name: string, sizes?: object[] }>} products
 * @returns {Map<string, { id: string, name: string, sizes: object[] }>}
 */
function buildIndexFromProducts(products) {
  const byName = new Map();
  for (const p of products || []) {
    if (!p?.id || !p?.name) continue;
    byName.set(normalizeCatalogName(p.name), {
      id: p.id,
      name: p.name,
      sizes: Array.isArray(p.sizes) ? p.sizes : []
    });
  }
  return byName;
}

/**
 * buildFallbackIndex: Índice solo con UUIDs hardcodeados (sin sizes vivos).
 *
 * @returns {Map<string, { id: string, name: string, sizes: object[] }>}
 */
function buildFallbackIndex() {
  const byName = new Map();
  for (const [name, id] of Object.entries(FALLBACK_PRODUCT_IDS)) {
    byName.set(normalizeCatalogName(name), { id, name, sizes: [] });
  }
  return byName;
}

// ==============================================================================
// 3. CACHÉ Y CARGA DESDE LA API
// ==============================================================================

/**
 * getCachedProductIndex: Devuelve el índice si aún es válido.
 *
 * @returns {Map|null}
 */
function getCachedProductIndex() {
  if (cache.productsByName && Date.now() < cache.expiresAt) {
    return cache.productsByName;
  }
  return null;
}

/**
 * ensureCatalogIndex: Carga (o reutiliza) el índice de productos.
 * 1) Caché viva → 2) GET API → 3) caché vencida (stale) → 4) fallback hardcodeado.
 *
 * @param {{ force?: boolean, silent?: boolean }} [opts]
 * @returns {Promise<{ productsByName: Map, source: string }>}
 */
export async function ensureCatalogIndex(opts = {}) {
  const force = Boolean(opts.force);
  const silent = Boolean(opts.silent);

  if (!force) {
    const live = getCachedProductIndex();
    if (live) {
      return { productsByName: live, source: cache.source || 'api' };
    }
  }

  // Si ya hay un fetch en curso, esperamos el mismo (evita thundering herd)
  if (inflightPromise && !force) {
    return inflightPromise;
  }

  inflightPromise = (async () => {
    // Sin credenciales: directo a fallback
    if (!isCotApiConfigured()) {
      const productsByName = buildFallbackIndex();
      cache = {
        productsByName,
        raw: null,
        expiresAt: Date.now() + CATALOG_TTL_MS,
        source: 'fallback'
      };
      if (!silent) {
        console.warn('COT catalog: API no configurada; usando mapa de respaldo.');
      }
      return { productsByName, source: 'fallback' };
    }

    const result = await fetchCatalogViaApi();
    if (result.success) {
      const productsByName = buildIndexFromProducts(result.products);
      cache = {
        productsByName,
        raw: {
          products: result.products,
          comunas: result.comunas,
          regions: result.regions || [],
          blueExpressRates: result.blueExpressRates || null,
          eventTypes: result.eventTypes,
          fetchedAt: result.fetchedAt
        },
        expiresAt: Date.now() + CATALOG_TTL_MS,
        source: 'api'
      };
      if (!silent) {
        console.log(`COT catalog: ${productsByName.size} productos cargados desde API.`);
      }
      return { productsByName, source: 'api' };
    }

    // API falló: si teníamos datos viejos, los seguimos usando
    if (cache.productsByName) {
      if (!silent) {
        console.warn('COT catalog: API falló; usando caché vencida.', result.error);
      }
      cache.source = 'stale';
      cache.expiresAt = Date.now() + CATALOG_TTL_MS;
      return { productsByName: cache.productsByName, source: 'stale' };
    }

    if (!silent) {
      console.warn('COT catalog: API falló sin caché; usando mapa de respaldo.', result.error);
    }
    const productsByName = buildFallbackIndex();
    cache = {
      productsByName,
      raw: null,
      expiresAt: Date.now() + CATALOG_TTL_MS,
      source: 'fallback'
    };
    return { productsByName, source: 'fallback' };
  })();

  try {
    return await inflightPromise;
  } finally {
    inflightPromise = null;
  }
}

/**
 * warmCotCatalog: Precarga el catálogo al arrancar el bot (no bloqueante).
 * Llamar desde index.js / engine si se quiere el primer quote más rápido.
 *
 * @param {{ silent?: boolean }} [opts] - Oculta logs (útil en test:local)
 * @returns {Promise<void>}
 */
export async function warmCotCatalog(opts = {}) {
  const silent = Boolean(opts.silent);
  try {
    await ensureCatalogIndex({ silent });
  } catch (err) {
    if (!silent) {
      console.error('COT catalog warm falló:', err);
    }
  }
}

/**
 * getCachedComunas: Comunas del último catálogo API (o [] si no hay).
 *
 * @returns {Array<{
 *   name: string,
 *   regionCode?: string,
 *   regionShortName?: string,
 *   availableForEvents?: boolean,
 *   availableForDirect?: boolean,
 *   cost: number|null,
 *   freeFrom: number|null,
 *   directSaleDeliveryCost?: number|null,
 *   shippingCarrier?: string,
 *   blueExpressZone?: string|null
 * }>}
 */
export function getCachedComunas() {
  return cache.raw?.comunas || [];
}

/**
 * getCachedBlueExpressRates: Tarifas BE del catálogo (o null).
 *
 * @returns {object|null}
 */
export function getCachedBlueExpressRates() {
  return cache.raw?.blueExpressRates || null;
}

const BE_BARRELS_PER_L = 4;
const BE_FALLBACK_RATES = {
  misma_zona: { M: 4800, L: 5400 },
  centro: { M: 7300, L: 9200 },
  extremo: { M: 14500, L: 17000 }
};

/**
 * barrelsFromLiters: 5L = 1 barril desechable (igual que la web).
 *
 * @param {number} totalLiters
 * @returns {number}
 */
function barrelsFromLiters(totalLiters) {
  if (!totalLiters || totalLiters <= 0) return 0;
  return Math.max(1, Math.round(totalLiters / 5));
}

/**
 * splitBlueExpressPacks: L de 4 barriles; 1 resto = M; 2–3 = un L extra.
 *
 * @param {number} barrelCount
 * @returns {{ m: number, l: number }}
 */
function splitBlueExpressPacks(barrelCount) {
  if (barrelCount <= 0) return { m: 0, l: 0 };
  const fullL = Math.floor(barrelCount / BE_BARRELS_PER_L);
  const rem = barrelCount % BE_BARRELS_PER_L;
  if (rem === 0) return { m: 0, l: fullL };
  if (rem === 1) return { m: 1, l: fullL };
  return { m: 0, l: fullL + 1 };
}

/**
 * quoteBlueExpressHome: Costo domicilio según zona y cantidad de barriles.
 *
 * @param {number} barrelCount
 * @param {string} zone
 * @param {object|null} rates
 * @returns {number|null}
 */
function quoteBlueExpressHome(barrelCount, zone, rates) {
  const table = rates && rates[zone] ? rates : BE_FALLBACK_RATES;
  const zoneRates = table[zone];
  if (!zoneRates) return null;
  const packs = splitBlueExpressPacks(barrelCount);
  return packs.m * Number(zoneRates.M || 0) + packs.l * Number(zoneRates.L || 0);
}

/**
 * blueExpressZoneFromRegion: Zona BE de la web cuando el catálogo aún no trae la comuna.
 * Espejo de regions.blue_express_zone en Supabase.
 *
 * @param {string} regionCode
 * @param {string} regionLabel
 * @returns {'misma_zona'|'centro'|'extremo'|null}
 */
export function blueExpressZoneFromRegion(regionCode, regionLabel) {
  const code = String(regionCode || '').trim().toUpperCase();
  if (code === 'RM') return 'misma_zona';
  if (['XV', 'I', 'II', 'III', 'XIV', 'X', 'XI', 'XII'].includes(code)) return 'extremo';
  if (['IV', 'V', 'VI', 'VII', 'XVI', 'VIII', 'IX'].includes(code)) return 'centro';

  const n = normalizeCatalogName(regionLabel);
  if (!n) return null;
  if (n.includes('metropolitana') || n === 'rm') return 'misma_zona';
  if (
    n.includes('arica')
    || n.includes('tarapaca')
    || n.includes('antofagasta')
    || n.includes('atacama')
    || n.includes('los rios')
    || n.includes('los lagos')
    || n.includes('aysen')
    || n.includes('aisen')
    || n.includes('magallanes')
  ) {
    return 'extremo';
  }
  if (
    n.includes('coquimbo')
    || n.includes('valparaiso')
    || n.includes('ohiggins')
    || n.includes('o higgins')
    || n.includes('libertador')
    || n.includes('maule')
    || n.includes('nuble')
    || n.includes('biobio')
    || n.includes('bio bio')
    || n.includes('araucania')
  ) {
    return 'centro';
  }
  return null;
}

/**
 * quoteBarrilesDirectShipping: Flete desechable para una comuna.
 * 1) catálogo vivo  2) Blue Express por zona de la región (tarifas admin o fallback).
 *
 * @param {{ comunaName: string, region?: string, regionCode?: string, isRM?: boolean, totalLiters?: number }} opts
 * @returns {{
 *   cost: number|null,
 *   isPending: boolean,
 *   shippingCarrier: string,
 *   regionCode: string,
 *   name: string,
 *   isRM: boolean,
 *   label: string
 * }|null}
 */
export function quoteBarrilesDirectShipping(opts) {
  const comunaName = String(opts?.comunaName || '').trim();
  const totalLiters = Number(opts?.totalLiters) || 5;
  const catalog = quoteCatalogShipping({
    serviceType: 'direct',
    comunaName,
    totalLiters
  });
  if (catalog && !catalog.isPending && catalog.cost != null) {
    return catalog;
  }

  const isRM = Boolean(opts?.isRM) || String(opts?.regionCode || '') === 'RM';
  if (isRM) return catalog;

  const zone = blueExpressZoneFromRegion(opts?.regionCode, opts?.region);
  if (!zone) return catalog;

  const barrels = barrelsFromLiters(totalLiters || 5);
  const cost = quoteBlueExpressHome(barrels, zone, getCachedBlueExpressRates());
  if (cost == null) return catalog;

  return {
    cost,
    isPending: false,
    shippingCarrier: 'blue_express',
    regionCode: String(opts?.regionCode || catalog?.regionCode || ''),
    name: catalog?.name || comunaName,
    isRM: false,
    label: String(cost)
  };
}

/**
 * findCatalogComuna: Busca comuna del catálogo por nombre (sin tildes).
 *
 * @param {string} comunaName
 * @returns {object|null}
 */
export function findCatalogComuna(comunaName) {
  const needle = normalizeCatalogName(comunaName);
  if (!needle) return null;
  return getCachedComunas().find((c) => normalizeCatalogName(c.name) === needle) || null;
}

/**
 * quoteCatalogShipping: Misma lógica que resolveShipping de la web (sin duplicar dominio).
 *
 * @param {{ serviceType: 'event'|'direct', comunaName: string, totalLiters?: number }} opts
 * @returns {{
 *   cost: number|null,
 *   isPending: boolean,
 *   shippingCarrier: string,
 *   regionCode: string,
 *   name: string,
 *   isRM: boolean,
 *   label: string
 * }|null}
 */
export function quoteCatalogShipping(opts) {
  const serviceType = opts?.serviceType === 'direct' ? 'direct' : 'event';
  const comunaName = String(opts?.comunaName || '').trim();
  const totalLiters = Number(opts?.totalLiters) || 0;
  const hit = findCatalogComuna(comunaName);
  if (!hit) return null;

  const name = hit.name;
  const regionCode = String(hit.regionCode || '');
  const isRM = regionCode === 'RM';
  const carrier = hit.shippingCarrier || 'own';

  if (normalizeCatalogName(name) === 'otra') {
    return {
      cost: null,
      isPending: true,
      shippingCarrier: carrier,
      regionCode,
      name,
      isRM,
      label: 'Pendiente de factibilidad'
    };
  }

  if (serviceType !== 'direct') {
    const eventCost = hit.cost;
    const eventFreeFrom = hit.freeFrom;
    if (eventCost === null || eventCost === undefined) {
      return {
        cost: null,
        isPending: true,
        shippingCarrier: 'own',
        regionCode,
        name,
        isRM,
        label: 'Por confirmar'
      };
    }
    if (eventFreeFrom != null && totalLiters >= Number(eventFreeFrom)) {
      return {
        cost: 0,
        isPending: false,
        shippingCarrier: 'own',
        regionCode,
        name,
        isRM,
        label: '¡Gratis!'
      };
    }
    return {
      cost: Number(eventCost),
      isPending: false,
      shippingCarrier: 'own',
      regionCode,
      name,
      isRM,
      label: String(eventCost)
    };
  }

  if (carrier === 'blue_express') {
    if (hit.directSaleDeliveryCost != null) {
      return {
        cost: Number(hit.directSaleDeliveryCost),
        isPending: false,
        shippingCarrier: 'blue_express',
        regionCode,
        name,
        isRM,
        label: String(hit.directSaleDeliveryCost)
      };
    }
    const zone = hit.blueExpressZone;
    const barrels = barrelsFromLiters(totalLiters || 5);
    if (!zone || barrels < 1) {
      return {
        cost: null,
        isPending: true,
        shippingCarrier: 'blue_express',
        regionCode,
        name,
        isRM,
        label: 'Por confirmar'
      };
    }
    const quoted = quoteBlueExpressHome(barrels, zone, getCachedBlueExpressRates());
    if (quoted == null) {
      return {
        cost: null,
        isPending: true,
        shippingCarrier: 'blue_express',
        regionCode,
        name,
        isRM,
        label: 'Por confirmar'
      };
    }
    return {
      cost: quoted,
      isPending: false,
      shippingCarrier: 'blue_express',
      regionCode,
      name,
      isRM,
      label: String(quoted)
    };
  }

  const ownCost = hit.directSaleDeliveryCost;
  if (ownCost === null || ownCost === undefined) {
    return {
      cost: null,
      isPending: true,
      shippingCarrier: carrier,
      regionCode,
      name,
      isRM,
      label: 'Por confirmar'
    };
  }
  return {
    cost: Number(ownCost),
    isPending: false,
    shippingCarrier: carrier,
    regionCode,
    name,
    isRM,
    label: String(ownCost)
  };
}

/**
 * enrichLocationFromCatalog: Superpone tarifas vivas del catálogo sobre el match local.
 *
 * @param {{ name?: string, region?: string, deliveryCost?: object|null, isRM?: boolean }|null} record
 * @param {{ totalLiters?: number }} [opts]
 * @returns {object|null}
 */
export function enrichLocationFromCatalog(record, opts = {}) {
  if (!record?.name) return record;
  const liters = Number(opts.totalLiters) || 5;
  const eventQuote = quoteCatalogShipping({
    serviceType: 'event',
    comunaName: record.name,
    totalLiters: Number(opts.eventLiters) || 0
  });
  const directQuote = quoteCatalogShipping({
    serviceType: 'direct',
    comunaName: record.name,
    totalLiters: liters
  });
  if (!eventQuote && !directQuote) return record;

  const hit = findCatalogComuna(record.name);
  return {
    ...record,
    name: hit?.name || record.name,
    region: hit?.regionShortName
      ? `Región ${hit.regionShortName}`
      : record.region,
    regionCode: hit?.regionCode || record.regionCode || null,
    isRM: hit ? hit.regionCode === 'RM' : Boolean(record.isRM),
    deliveryCost: {
      evento: eventQuote && !eventQuote.isPending ? eventQuote.cost : null,
      desechable: directQuote && !directQuote.isPending ? directQuote.cost : null,
      shippingCarrier: directQuote?.shippingCarrier || hit?.shippingCarrier || null,
      blueExpressZone: hit?.blueExpressZone || null
    }
  };
}

/**
 * resolveComunaForApi: Empareja la comuna del bot con el catálogo web.
 * Si no hay match → comuna "Otra" + otherComuna con el texto del cliente
 * (así la web no rechaza el envío por nombre desconocido).
 *
 * @param {string} comunaText - Ej. "Providencia" o "La Serena"
 * @returns {Promise<{ comuna: string, otherComuna: string, matched: boolean, region: string }>}
 */
export async function resolveComunaForApi(comunaText) {
  const raw = String(comunaText || '').trim();
  if (!raw) {
    return { comuna: '', otherComuna: '', matched: false, region: '' };
  }

  // Asegura catálogo cargado (trae comunas en cache.raw)
  await ensureCatalogIndex();
  const comunas = getCachedComunas();

  // Sin lista (fallback hardcodeado): enviamos el texto tal cual
  if (!comunas.length) {
    return { comuna: raw, otherComuna: '', matched: false, region: '' };
  }

  const needle = normalizeCatalogName(raw);
  const hit = comunas.find((c) => normalizeCatalogName(c.name) === needle);
  if (hit) {
    return {
      comuna: hit.name,
      otherComuna: '',
      matched: true,
      region: hit.regionCode || ''
    };
  }

  // "Otra" es la comuna comodín del catálogo web (RM)
  const otra = comunas.find((c) => normalizeCatalogName(c.name) === 'otra');
  return {
    comuna: otra?.name || 'Otra',
    otherComuna: raw,
    matched: false,
    region: otra?.regionCode || 'RM'
  };
}

// ==============================================================================
// 4. RESOLUCIÓN PARA ITEMS DE LA API
// ==============================================================================

/**
 * findProductInIndex: Busca por nombre oficial (con alias del bot).
 *
 * @param {Map} productsByName
 * @param {string} botName
 * @returns {{ id: string, name: string, sizes: object[] }|null}
 */
function findProductInIndex(productsByName, botName) {
  const official = resolveOfficialProductName(botName);
  const hit = productsByName.get(normalizeCatalogName(official));
  if (hit) return hit;
  // Por si el bot ya usa el nombre oficial distinto al alias
  return productsByName.get(normalizeCatalogName(botName)) || null;
}

/**
 * resolveProductId: UUID del producto (async: puede disparar fetch de catálogo).
 *
 * @param {string} botName
 * @returns {Promise<string|null>}
 */
export async function resolveProductId(botName) {
  const { productsByName } = await ensureCatalogIndex();
  return findProductInIndex(productsByName, botName)?.id || null;
}

/**
 * mapEventCartToApiItems: Convierte el carrito de eventos del bot a items de la API.
 * Carga el catálogo si hace falta (caché 5 min).
 *
 * @param {object} products - session.orderBuilder.products (claves nombre::litrage)
 * @returns {Promise<{ items: Array<{productId:string,size:string,quantity:number}>, errors: string[], catalogSource: string }>}
 */
export async function mapEventCartToApiItems(products) {
  const { productsByName, source } = await ensureCatalogIndex();
  const items = [];
  const errors = [];

  for (const entry of Object.values(products || {})) {
    if (!entry?.name || !entry?.litrage || !entry?.quantity) continue;

    const product = findProductInIndex(productsByName, entry.name);
    if (!product) {
      errors.push(`Sin mapeo API para: ${entry.name}`);
      continue;
    }

    // Eventos: tamaño de servicio (no desechable)
    const size = resolveSizeFromProduct(product, entry.litrage, { disposable: false });
    if (!size) {
      errors.push(`Tamaño ${entry.litrage} no válido para ${entry.name} en catálogo.`);
      continue;
    }

    items.push({
      productId: product.id,
      size,
      quantity: Number(entry.quantity) || 1
    });
  }

  return { items, errors, catalogSource: source };
}

/**
 * mapDisposableCartToApiItems: Igual que eventos, pero fuerza size desechable.
 * Lo usa cot-barriles-sale.js → POST /api/v1/direct-sales.
 *
 * @param {object} products - carrito barriles { nombre: qty } o entries con litrage
 * @returns {Promise<{ items: Array<{productId:string,size:string,quantity:number}>, errors: string[], catalogSource: string }>}
 */
export async function mapDisposableCartToApiItems(products) {
  const { productsByName, source } = await ensureCatalogIndex();
  const items = [];
  const errors = [];

  for (const [key, value] of Object.entries(products || {})) {
    // Formato barriles clásico: { "Mojito": 2 }
    const isQtyOnly = typeof value === 'number';
    const name = isQtyOnly ? key : value?.name;
    const quantity = isQtyOnly ? value : value?.quantity;
    const litrage = isQtyOnly ? '5L' : value?.litrage || '5L';

    if (!name || !quantity) continue;

    const product = findProductInIndex(productsByName, name);
    if (!product) {
      errors.push(`Sin mapeo API para: ${name}`);
      continue;
    }

    const size = resolveSizeFromProduct(product, litrage, { disposable: true });
    if (!size) {
      errors.push(`Tamaño desechable no válido para ${name} en catálogo.`);
      continue;
    }

    items.push({
      productId: product.id,
      size,
      quantity: Number(quantity) || 1
    });
  }

  return { items, errors, catalogSource: source };
}
