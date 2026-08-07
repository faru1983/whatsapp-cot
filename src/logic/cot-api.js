// ==============================================================================
// OBJETIVO: Cliente HTTP hacia la API de ventas de cocktailsontap.cl (/api/v1).
// El bot solo habla; los precios y quotes reales los crea la web (createQuoteCore).
// En test:local puede simular POST (quotes / direct-sales / contacts) sin red.
// ==============================================================================

/** @typedef {'real'|'mock'|'ask'} CotApiWriteMode */

/**
 * Override del modo de escritura (null = seguir .env COT_API_MOCK).
 * Lo usa el simulador CLI: /api mock · /api real · /api ask
 * @type {CotApiWriteMode|null}
 */
let writeModeOverride = null;

/**
 * getCotApiConfig: Lee URL base y API key desde .env.
 *
 * @returns {{ baseUrl: string, apiKey: string }|null} null si no está configurado
 */
export function getCotApiConfig() {
  const baseUrl = String(process.env.COT_API_BASE_URL || '').trim().replace(/\/$/, '');
  const apiKey = String(process.env.COT_API_KEY || '').trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/**
 * isCotApiConfigured: ¿Hay credenciales para llamar a la API de cotizaciones?
 * (El modo mock no requiere keys; ver isCotApiMockMode.)
 *
 * @returns {boolean}
 */
export function isCotApiConfigured() {
  return getCotApiConfig() !== null;
}

/**
 * parseCotApiWriteModeEnv: Interpreta COT_API_MOCK del .env.
 *
 * @param {string|undefined} raw
 * @returns {CotApiWriteMode}
 */
function parseCotApiWriteModeEnv(raw) {
  const env = String(raw ?? '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes' || env === 'mock') return 'mock';
  if (env === 'ask') return 'ask';
  return 'real';
}

/**
 * getCotApiWriteMode: Cómo se crean quotes/ventas/contacts.
 * - real: POST real a la web
 * - mock: respuesta falsa (sin fetch)
 * - ask: en confirmación del simulador, preguntar 1️⃣ real / 2️⃣ simulada
 *
 * @returns {CotApiWriteMode}
 */
export function getCotApiWriteMode() {
  if (writeModeOverride === 'real' || writeModeOverride === 'mock' || writeModeOverride === 'ask') {
    return writeModeOverride;
  }
  return parseCotApiWriteModeEnv(process.env.COT_API_MOCK);
}

/**
 * setCotApiWriteMode: Fija el modo (CLI /api). null = volver al .env.
 *
 * @param {CotApiWriteMode|null} mode
 */
export function setCotApiWriteMode(mode) {
  if (mode === null) {
    writeModeOverride = null;
    return;
  }
  if (mode !== 'real' && mode !== 'mock' && mode !== 'ask') {
    throw new Error(`Modo API inválido: ${mode}`);
  }
  writeModeOverride = mode;
}

/**
 * isCotApiMockMode: ¿Los POST de escritura se simulan sin red?
 *
 * @returns {boolean}
 */
export function isCotApiMockMode() {
  return getCotApiWriteMode() === 'mock';
}

/**
 * canSubmitCotApiWrite: ¿Podemos intentar crear quote/venta (real o mock)?
 *
 * @returns {boolean}
 */
export function canSubmitCotApiWrite() {
  return isCotApiConfigured() || isCotApiMockMode();
}

/**
 * buildMockWriteResult: Respuesta falsa con forma de la API real (token + url).
 *
 * @param {'quotes'|'direct-sales'} kind
 * @param {object} [payload]
 * @returns {{ success: true, token: string, quoteId: string, url: string, totalPrice: number|null, status: string, mocked: true }}
 */
function buildMockWriteResult(kind, payload = {}) {
  const id = `mock-${kind === 'quotes' ? 'quote' : 'sale'}-${Date.now().toString(36)}`;
  const path = kind === 'quotes' ? 'cotizar' : 'compra';
  const totalFromPayload = Number(payload?.pricing?.total ?? payload?.totalPrice);
  return {
    success: true,
    token: `mock-tok-${id}`,
    quoteId: id,
    url: `https://cocktailsontap.cl/${path}/${id}?simulated=1`,
    totalPrice: Number.isFinite(totalFromPayload) ? totalFromPayload : null,
    status: 'draft',
    mocked: true
  };
}

/**
 * parseCliApiModeChoice: 1️⃣ real / 2️⃣ simulada (solo tras el menú [TEST]).
 *
 * @param {string} messageText
 * @returns {'real'|'mock'|null}
 */
export function parseCliApiModeChoice(messageText) {
  const t = String(messageText || '').trim().toLowerCase();
  if (!t) return null;
  // Respuestas cortas del menú del simulador
  if (/^(1|1️⃣)$/.test(t) || t === 'real' || t === 'api real') return 'real';
  if (/^(2|2️⃣)$/.test(t) || t === 'sim' || t === 'mock' || /^simulad[ao]s?$/.test(t)) return 'mock';
  return null;
}

/**
 * getCliApiSubmitAskReply: Texto del menú real vs simulada (solo test:local).
 *
 * @returns {string}
 */
export function getCliApiSubmitAskReply() {
  return `[TEST] ¿Crear en la API de verdad o simular?

1️⃣ *Real* — POST a cocktailsontap.cl
2️⃣ *Simulada* — sin llamar a la web (link de prueba)

_(también: /api mock · /api real · /api ask)_`;
}

/**
 * isAwaitingCliApiMode: ¿Esperamos 1/2 del menú [TEST] en esta sesión?
 *
 * @param {object} session
 * @returns {boolean}
 */
export function isAwaitingCliApiMode(session) {
  return Boolean(session?.cliAwaitingApiMode);
}

/**
 * beginCliApiModeAsk: Marca la sesión para el menú real/simulada.
 *
 * @param {object} session
 */
export function beginCliApiModeAsk(session) {
  session.cliAwaitingApiMode = true;
}

/**
 * applyCliApiModeChoice: Guarda la elección y deja de preguntar.
 *
 * @param {object} session
 * @param {'real'|'mock'} mode
 */
export function applyCliApiModeChoice(session, mode) {
  session.cliAwaitingApiMode = false;
  setCotApiWriteMode(mode);
}

/**
 * shouldAskCliApiModeOnConfirm: En modo ask, tras OK hay que mostrar 1️⃣/2️⃣.
 *
 * @returns {boolean}
 */
export function shouldAskCliApiModeOnConfirm() {
  return getCotApiWriteMode() === 'ask';
}

/**
 * fetchCatalogViaApi: Baja el catálogo activo (productos, precios, comunas).
 * GET /api/v1/catalog con Bearer token.
 *
 * @returns {Promise<{ success: boolean, products?: object[], comunas?: object[], eventTypes?: object[], fetchedAt?: string, error?: string }>}
 */
export async function fetchCatalogViaApi() {
  const config = getCotApiConfig();
  if (!config) {
    return { success: false, error: 'API no configurada (falta COT_API_BASE_URL o COT_API_KEY).' };
  }

  const url = `${config.baseUrl}/api/v1/catalog`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const errMsg = data?.error || `HTTP ${response.status}`;
      console.error(`COT API catalog falló (${response.status}):`, errMsg);
      return { success: false, error: errMsg };
    }

    if (!data?.success || !Array.isArray(data?.products)) {
      return { success: false, error: data?.error || 'Respuesta de catálogo incompleta.' };
    }

    return {
      success: true,
      products: data.products,
      comunas: Array.isArray(data.comunas) ? data.comunas : [],
      eventTypes: Array.isArray(data.eventTypes) ? data.eventTypes : [],
      fetchedAt: data.fetchedAt || new Date().toISOString()
    };
  } catch (err) {
    console.error('COT API catalog error de red:', err);
    return { success: false, error: err?.message || 'Error de red al cargar catálogo.' };
  }
}

/**
 * createEventQuoteViaApi: Crea una cotización de evento (draft) en la web.
 * POST /api/v1/quotes con Bearer token.
 *
 * @param {object} payload - Body según IntegrationEventQuoteSchema
 * @returns {Promise<{ success: boolean, token?: string, quoteId?: string, url?: string, totalPrice?: number, status?: string, error?: string }>}
 */
export async function createEventQuoteViaApi(payload) {
  // Simulador local / COT_API_MOCK: misma forma de respuesta, sin red
  if (isCotApiMockMode()) {
    console.log('[COT API mock] createEventQuoteViaApi — sin POST real');
    return buildMockWriteResult('quotes', payload);
  }

  const config = getCotApiConfig();
  if (!config) {
    return { success: false, error: 'API no configurada (falta COT_API_BASE_URL o COT_API_KEY).' };
  }

  const url = `${config.baseUrl}/api/v1/quotes`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const errMsg = data?.error || `HTTP ${response.status}`;
      console.error(`COT API quotes falló (${response.status}):`, errMsg);
      return { success: false, error: errMsg };
    }

    if (!data?.success || !data?.token || !data?.url) {
      return { success: false, error: data?.error || 'Respuesta incompleta de la API.' };
    }

    return {
      success: true,
      token: data.token,
      quoteId: data.quoteId,
      url: data.url,
      totalPrice: data.totalPrice,
      status: data.status
    };
  } catch (err) {
    console.error('COT API quotes error de red:', err);
    return { success: false, error: err?.message || 'Error de red al crear cotización.' };
  }
}

/**
 * createDirectSaleViaApi: Crea una venta de barriles desechables en la web.
 * POST /api/v1/direct-sales con Bearer token.
 *
 * @param {object} payload - Body según IntegrationDirectSaleSchema
 * @returns {Promise<{ success: boolean, token?: string, quoteId?: string, url?: string, totalPrice?: number, status?: string, error?: string }>}
 */
export async function createDirectSaleViaApi(payload) {
  if (isCotApiMockMode()) {
    console.log('[COT API mock] createDirectSaleViaApi — sin POST real');
    return buildMockWriteResult('direct-sales', payload);
  }

  const config = getCotApiConfig();
  if (!config) {
    return { success: false, error: 'API no configurada (falta COT_API_BASE_URL o COT_API_KEY).' };
  }

  const url = `${config.baseUrl}/api/v1/direct-sales`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const errMsg = data?.error || `HTTP ${response.status}`;
      console.error(`COT API direct-sales falló (${response.status}):`, errMsg);
      return { success: false, error: errMsg };
    }

    if (!data?.success || !data?.token || !data?.url) {
      return { success: false, error: data?.error || 'Respuesta incompleta de la API.' };
    }

    return {
      success: true,
      token: data.token,
      quoteId: data.quoteId,
      url: data.url,
      totalPrice: data.totalPrice,
      status: data.status
    };
  } catch (err) {
    console.error('COT API direct-sales error de red:', err);
    return { success: false, error: err?.message || 'Error de red al crear la venta.' };
  }
}

/**
 * createContactViaApi: Registra/actualiza persona CRM + touchpoint (+ CAPI).
 * POST /api/v1/contacts — phone-only OK.
 *
 * @param {object} payload
 * @param {string} payload.phone - E.164
 * @param {string} [payload.touchpointType='bot_started'] - bot_started | intent_selected | human_reply
 * @param {string} [payload.firstName]
 * @param {string} [payload.ctwaClid] - Click ID Meta CTWA → CAPI custom_data.ctwa_clid
 * @param {string} [payload.fbc]
 * @param {string} [payload.fbp]
 * @param {boolean} [payload.sendCapiLead=true]
 * @param {object} [payload.payload]
 * @returns {Promise<{ success: boolean, clientId?: string, created?: boolean, lifecycleStage?: string, stageChanged?: boolean, metaEventSent?: string|null, error?: string }>}
 */
export async function createContactViaApi(payload) {
  if (isCotApiMockMode()) {
    console.log('[COT API mock] createContactViaApi — sin POST real');
    return {
      success: true,
      clientId: `mock-client-${Date.now().toString(36)}`,
      created: true,
      merged: false,
      lifecycleStage: 'curious',
      stageChanged: false,
      metaEventSent: null,
      touchpointId: `mock-tp-${Date.now().toString(36)}`,
      mocked: true
    };
  }

  const config = getCotApiConfig();
  if (!config) {
    return { success: false, error: 'API no configurada (falta COT_API_BASE_URL o COT_API_KEY).' };
  }

  const url = `${config.baseUrl}/api/v1/contacts`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        source: 'whatsapp',
        sendCapiLead: true,
        ...payload
      })
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const errMsg = data?.error || `HTTP ${response.status}`;
      console.error(`COT API contacts falló (${response.status}):`, errMsg);
      return { success: false, error: errMsg };
    }

    if (!data?.success || !data?.clientId) {
      return { success: false, error: data?.error || 'Respuesta incompleta de contacts.' };
    }

    return {
      success: true,
      clientId: data.clientId,
      created: data.created,
      merged: data.merged,
      lifecycleStage: data.lifecycleStage,
      stageChanged: data.stageChanged,
      metaEventSent: data.metaEventSent ?? null,
      touchpointId: data.touchpointId
    };
  } catch (err) {
    console.error('COT API contacts error de red:', err);
    return { success: false, error: err?.message || 'Error de red al registrar contacto.' };
  }
}

