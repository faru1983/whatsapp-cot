// ==============================================================================
// OBJETIVO: Cliente HTTP hacia la API de ventas de cocktailsontap.cl (/api/v1).
// El bot solo habla; los precios y quotes reales los crea la web (createQuoteCore).
// ==============================================================================

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
 * isCotApiConfigured: ¿Podemos llamar a la API de cotizaciones?
 *
 * @returns {boolean}
 */
export function isCotApiConfigured() {
  return getCotApiConfig() !== null;
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

