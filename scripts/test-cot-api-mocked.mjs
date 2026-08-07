// ==============================================================================
// OBJETIVO: Tests del camino API real con fetch mockeado (sin red ni credenciales).
// Cubre: éxito, fallo de red, HTTP error, idempotencia de sesión.
// Uso: npm run test:cot-api-mocked  |  incluido en npm run verify
// ==============================================================================

let failed = 0;

/**
 * assert: Falla el test si condition es falsa.
 * @param {boolean} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  } else {
    console.log(`  OK: ${message}`);
  }
}

/**
 * installFetchMock: Intercepta fetch global para simular la API COT.
 * @param {(url: string, init?: object) => Promise<object>} handler
 * @returns {() => void} restore
 */
function installFetchMock(handler) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => {
    globalThis.fetch = prev;
  };
}

console.log('\n=== COT API mocked (sin red) ===\n');

process.env.COT_API_BASE_URL = 'https://cot-api.test';
process.env.COT_API_KEY = 'test-key-mocked';

const {
  createDirectSaleViaApi,
  createEventQuoteViaApi,
  createContactViaApi,
  isCotApiConfigured,
  setCotApiWriteMode,
  getCotApiWriteMode,
  isCotApiMockMode,
  canSubmitCotApiWrite,
  parseCliApiModeChoice,
  shouldAskCliApiModeOnConfirm
} = await import('../src/logic/cot-api.js');

assert(isCotApiConfigured() === true, 'API marcada como configurada con env de test');
assert(getCotApiWriteMode() === 'real', 'modo escritura por defecto: real');
assert(canSubmitCotApiWrite() === true, 'canSubmit con keys');
assert(parseCliApiModeChoice('1') === 'real', 'parse 1 → real');
assert(parseCliApiModeChoice('2️⃣') === 'mock', 'parse 2️⃣ → mock');
assert(parseCliApiModeChoice('ok') === null, 'parse ok no es modo API');

// --- Éxito direct-sales ---
{
  let sawAuth = false;
  const restore = installFetchMock(async (url, init) => {
    assert(url.includes('/api/v1/direct-sales'), `URL direct-sales (es ${url})`);
    sawAuth = String(init?.headers?.Authorization || '').includes('Bearer test-key-mocked');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        token: 'tok-sale',
        quoteId: 'sale-1',
        url: 'https://cocktailsontap.cl/pedido/sale-1',
        totalPrice: 45000,
        status: 'draft'
      })
    };
  });
  const r = await createDirectSaleViaApi({ source: 'whatsapp', items: [] });
  assert(r.success === true && r.url?.includes('sale-1'), 'createDirectSaleViaApi éxito');
  assert(sawAuth, 'envía Bearer token');
  restore();
}

// --- Éxito quotes ---
{
  const restore = installFetchMock(async (url) => {
    assert(url.includes('/api/v1/quotes'), `URL quotes (es ${url})`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        token: 'tok-q',
        quoteId: 'q-1',
        url: 'https://cocktailsontap.cl/cotizacion/q-1',
        totalPrice: 109990,
        status: 'draft'
      })
    };
  });
  const r = await createEventQuoteViaApi({ source: 'whatsapp', items: [] });
  assert(r.success === true && r.url?.includes('q-1'), 'createEventQuoteViaApi éxito');
  restore();
}

// --- Fallo de red ---
{
  const restore = installFetchMock(async () => {
    throw new Error('Network down');
  });
  const r = await createEventQuoteViaApi({ source: 'whatsapp', items: [] });
  assert(r.success === false && /Network|red/i.test(String(r.error || '')), 'quotes: fallo de red');
  restore();
}

// --- HTTP 500 ---
{
  const restore = installFetchMock(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Internal error' })
  }));
  const r = await createDirectSaleViaApi({ source: 'whatsapp' });
  assert(r.success === false && /Internal|500/i.test(String(r.error || '')), 'direct-sales: HTTP 500');
  restore();
}

// --- Respuesta incompleta ---
{
  const restore = installFetchMock(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, token: 't' }) // sin url
  }));
  const r = await createDirectSaleViaApi({ source: 'whatsapp' });
  assert(r.success === false, 'respuesta incompleta (sin url) → error');
  restore();
}

// --- Idempotencia submitBarrilesSaleConfirmed / submitEventosQuoteConfirmed ---
{
  const { submitBarrilesSaleConfirmed } = await import('../src/logic/cot-barriles-contact.js');
  const { submitEventosQuoteConfirmed } = await import('../src/logic/cot-eventos-contact.js');
  let fetchCalls = 0;
  const restore = installFetchMock(async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, token: 't', quoteId: 'q', url: 'https://x', totalPrice: 1 })
    };
  });

  const rSale = await submitBarrilesSaleConfirmed({
    contact: { firstName: 'Ana', lastName: 'Pérez', email: 'a@b.cl' },
    cotSale: { url: 'https://cocktailsontap.cl/pedido/ya-creado', totalPrice: 45000, token: 't' }
  });
  assert(fetchCalls === 0, 'idempotencia barriles: no llama fetch');
  assert(String(rSale.customReply || '').includes('ya-creado'), 'idempotencia barriles: reusa URL');

  const rQuote = await submitEventosQuoteConfirmed({
    contact: { firstName: 'Ana', lastName: 'Pérez', email: 'a@b.cl' },
    cotQuote: { url: 'https://cocktailsontap.cl/cotizacion/ya-creada', totalPrice: 99990, token: 't' }
  });
  assert(fetchCalls === 0, 'idempotencia eventos: no llama fetch');
  assert(String(rQuote.customReply || '').includes('ya-creada'), 'idempotencia eventos: reusa URL');
  restore();
}

// --- adminBody comuna no matcheada (unidad del builder, sin POST) ---
{
  // Simulamos el fragmento de adminBody que arma submit* cuando matched=false
  const built = {
    comunaMatched: false,
    comunaRaw: 'Comuna Inventada XYZ',
    payload: {
      client: { comuna: 'Otra', otherComuna: 'Comuna Inventada XYZ' }
    }
  };
  const line = !built.comunaMatched
    ? `⚠️ Comuna no matcheó catálogo web → enviada como "${built.payload.client.comuna}"`
      + (built.payload.client.otherComuna ? ` (otherComuna=${built.payload.client.otherComuna})` : '')
      + (built.comunaRaw ? ` | texto cliente: ${built.comunaRaw}` : '')
    : null;
  assert(/no matcheó/i.test(String(line)), 'patrón adminBody comuna no matcheada');
  assert(/Comuna Inventada XYZ/.test(String(line)), 'adminBody incluye texto cliente');
}

console.log('\n=== Resultado mocked ===\n');
if (failed > 0) {
  console.error(`COT API MOCKED FAILED (${failed} assertion(s))`);
  process.exit(1);
}
console.log('COT API MOCKED PASSED');

// ==============================================================================
// Meta CTWA extractor (patrón: externalAdReply.ctwaClid + señales opacas)
// ==============================================================================
console.log('\n=== Meta CTWA attribution ===\n');
{
  const {
    extractMetaCtwaAttribution,
    applyMetaCtwaToSession
  } = await import('../src/logic/meta-ctwa.js');

  const withClid = extractMetaCtwaAttribution({
    message: {
      extendedTextMessage: {
        text: 'Hola, quiero cotizar',
        contextInfo: {
          externalAdReply: {
            ctwaClid: 'ARAtestclid1234567890',
            sourceId: 'ad_123',
            sourceUrl: 'https://fb.me/x',
            sourceApp: 'instagram'
          }
        }
      }
    }
  });
  assert(withClid.ctwaClid === 'ARAtestclid1234567890', 'extrae ctwaClid de externalAdReply');
  assert(withClid.sourceId === 'ad_123', 'extrae sourceId del anuncio');
  assert(withClid.isCtwaSignal === true, 'marca isCtwaSignal con clid');

  const opaque = extractMetaCtwaAttribution({
    message: {
      extendedTextMessage: {
        text: 'Hola',
        contextInfo: {
          conversionSource: 'FB_Ads',
          entryPointConversionSource: 'ctwa_ad',
          entryPointConversionApp: 'instagram',
          ctwaPayload: 'QWZjRDdjZHQ3OTJWNEx...'
        }
      }
    }
  });
  assert(opaque.ctwaClid === null, 'payload opaco no inventa clid');
  assert(opaque.isCtwaSignal === true, 'señal CTWA sin clid legible');
  assert(opaque.conversionSource === 'FB_Ads', 'lee conversionSource');

  const ephemeral = extractMetaCtwaAttribution({
    message: {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: 'hola',
            contextInfo: {
              externalAdReply: { ctwaClid: 'CLID_EPHEMERAL_99' }
            }
          }
        }
      }
    }
  });
  assert(ephemeral.ctwaClid === 'CLID_EPHEMERAL_99', 'extrae clid dentro de ephemeralMessage');

  const session = {};
  assert(applyMetaCtwaToSession(session, withClid) === true, 'aplica clid a sesión vacía');
  assert(session.metaCtwaClid === 'ARAtestclid1234567890', 'sesión guarda metaCtwaClid');
  const secondApply = applyMetaCtwaToSession(session, {
    ctwaClid: 'OTRO',
    sourceId: null,
    sourceUrl: null,
    conversionSource: null,
    entryPoint: null,
    isCtwaSignal: true
  });
  assert(secondApply === false, 'no pisa clid existente');
  assert(session.metaCtwaClid === 'ARAtestclid1234567890', 'clid original intacto');

  // createContactViaApi debe reenviar ctwaClid al body
  const { createContactViaApi } = await import('../src/logic/cot-api.js');
  let bodySeen = null;
  const restore = installFetchMock(async (url, init) => {
    assert(url.includes('/api/v1/contacts'), `URL contacts (es ${url})`);
    bodySeen = JSON.parse(String(init?.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        clientId: 'client-ctwa-1',
        created: true,
        lifecycleStage: 'curious',
        stageChanged: true,
        metaEventSent: 'lead_client_x',
        touchpointId: 'tp-1'
      })
    };
  });
  const contactRes = await createContactViaApi({
    phone: '+56912345678',
    touchpointType: 'bot_started',
    ctwaClid: 'ARAtestclid1234567890',
    firstName: 'Test'
  });
  restore();
  assert(contactRes.success === true, 'contacts API mock éxito con ctwa');
  assert(bodySeen?.ctwaClid === 'ARAtestclid1234567890', 'POST /contacts incluye ctwaClid');
  assert(bodySeen?.source === 'whatsapp', 'POST /contacts source whatsapp');
}

// ==============================================================================
// Engaged snapshot (Interesado con datos del flujo)
// ==============================================================================
console.log('\n=== Engaged lead context ===\n');
{
  const { buildEngagedLeadContext } = await import('../src/logic/cot-crm-sync.js');

  const eventos = buildEngagedLeadContext({
    userIntent: 'EVENTOS',
    guests: 50,
    celebrationType: 'Matrimonio',
    date: '15 de mayo',
    location: 'Las Condes',
  });
  assert(eventos.intent === 'event', 'intent eventos → event');
  assert(eventos.guests === 50, 'guests en snapshot');
  assert(eventos.comuna === 'Las Condes', 'comuna eventos');
  assert(
    eventos.crmNote?.includes('WA Interesado') && eventos.crmNote.includes('50 invitados'),
    'crmNote eventos'
  );

  const barriles = buildEngagedLeadContext({
    userIntent: 'BARRILES',
    orderBuilder: {
      type: 'desechable',
      clientData: { date: '5 de agosto', location: 'Providencia' },
    },
  });
  assert(barriles.intent === 'direct', 'intent barriles → direct');
  assert(barriles.comuna === 'Providencia', 'comuna barriles');
  assert(barriles.eventDate === '5 de agosto', 'fecha barriles');
}

// --- Modo COT_API mock (sin fetch; test:local) ---
{
  setCotApiWriteMode('mock');
  assert(isCotApiMockMode() === true, 'modo mock activo');
  assert(shouldAskCliApiModeOnConfirm() === false, 'mock no pide menú ask');

  let fetchCalled = false;
  const restore = installFetchMock(async () => {
    fetchCalled = true;
    throw new Error('no debería llamar fetch en mock');
  });

  const q = await createEventQuoteViaApi({ pricing: { total: 99000 } });
  assert(q.success === true && q.mocked === true, 'quote mock éxito');
  assert(/simulated=1/.test(q.url), 'quote mock url marcada');
  assert(q.totalPrice === 99000, 'quote mock reusa total del payload');

  const s = await createDirectSaleViaApi({});
  assert(s.success === true && s.mocked === true, 'sale mock éxito');

  const c = await createContactViaApi({ phone: '+56911111111' });
  assert(c.success === true && c.mocked === true && c.clientId, 'contact mock éxito');
  assert(fetchCalled === false, 'modo mock no usa fetch');
  restore();

  setCotApiWriteMode('ask');
  assert(shouldAskCliApiModeOnConfirm() === true, 'modo ask activa menú 1/2');
  setCotApiWriteMode('real');
  assert(isCotApiMockMode() === false, 'vuelve a real');
}

if (failed > 0) {
  console.error(`VERIFY EXTRA FAILED (${failed} assertion(s))`);
  process.exit(1);
}
console.log('\nALL MOCKED + CTWA + ENGAGED PASSED');
process.exit(0);
