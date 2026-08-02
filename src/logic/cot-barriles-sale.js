// ==============================================================================
// OBJETIVO: Armar el payload de venta desechable para POST /api/v1/direct-sales.
// Convierte carrito barriles, fecha/comuna y contacto al DTO de la web.
// ==============================================================================
import { mapDisposableCartToApiItems, resolveComunaForApi } from './cot-catalog.js';
import { createDirectSaleViaApi } from './cot-api.js';
import { toIsoDateFromBotText } from './cot-event-quote.js';
import { formatPrice } from './utils.js';

/**
 * formatExtrasAsComments: Resume extras del bot (hielo, etc.) para comments de la API.
 * La venta directa no tiene ítems de extras en el catálogo web.
 *
 * @param {object} extras - { nombreExtra: cantidad }
 * @returns {string}
 */
function formatExtrasAsComments(extras) {
  const lines = [];
  for (const [name, qty] of Object.entries(extras || {})) {
    if (!name || !qty) continue;
    lines.push(`${qty}x ${name}`);
  }
  return lines.length ? `Extras WhatsApp: ${lines.join(', ')}` : '';
}

/**
 * buildBarrilesSalePayload: Arma el body para POST /api/v1/direct-sales.
 * Fecha/comuna salen de orderBuilder.clientData (fuente canónica de Barriles).
 *
 * @param {object} session
 * @returns {Promise<{ ok: true, payload: object, catalogSource?: string }|{ ok: false, error: string }>}
 */
export async function buildBarrilesSalePayload(session) {
  const contact = session.contact || {};
  const clientData = session.orderBuilder?.clientData || {};
  const firstName = String(contact.firstName || '').trim();
  const lastName = String(contact.lastName || '').trim();
  const email = String(contact.email || '').trim().toLowerCase();
  const phone = String(contact.phone || session.clientPhoneE164 || '').trim();
  const address = String(contact.address || '').trim();
  const comunaRaw = String(clientData.location || session.location || contact.comuna || '').trim();
  const isoDate = toIsoDateFromBotText(clientData.date || session.date || contact.eventDate);

  if (!firstName || firstName.length < 2) {
    return { ok: false, error: 'Falta el nombre del cliente.' };
  }
  if (!lastName || lastName.length < 2) {
    return { ok: false, error: 'Falta el apellido del cliente.' };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Falta un email válido.' };
  }
  if (!address || address.length < 5) {
    return { ok: false, error: 'Falta la dirección de despacho.' };
  }
  if (!comunaRaw) {
    return { ok: false, error: 'Falta la comuna de entrega.' };
  }
  if (!isoDate) {
    return { ok: false, error: 'Falta la fecha de entrega (usa formato día y mes, ej. 15 de mayo).' };
  }

  // Catálogo vivo → UUIDs y etiqueta size desechable exacta (ej. "5L - Desechable")
  const { items, errors, catalogSource } = await mapDisposableCartToApiItems(
    session.orderBuilder?.products || {}
  );
  if (errors.length) {
    return { ok: false, error: errors.join(' ') };
  }
  if (!items.length) {
    return { ok: false, error: 'El carrito de cócteles está vacío o no se pudo mapear.' };
  }

  const comunaResolved = await resolveComunaForApi(comunaRaw);
  if (!comunaResolved.matched) {
    console.warn(
      `COT direct-sale: comuna "${comunaRaw}" no está en catálogo → ${comunaResolved.comuna}`
      + (comunaResolved.otherComuna ? ` (otherComuna=${comunaResolved.otherComuna})` : '')
    );
  }

  const extrasComment = formatExtrasAsComments(session.orderBuilder?.extras);
  const clientComments = String(contact.comments || '').trim();
  const comments = [clientComments, extrasComment].filter(Boolean).join('\n');

  const payload = {
    source: 'whatsapp',
    client: {
      firstName,
      lastName,
      email,
      phone,
      comuna: comunaResolved.comuna,
      otherComuna: comunaResolved.otherComuna,
      address: address,
      comments: comments
    },
    event: {
      date: isoDate,
      startTime: String(contact.startTime || '').trim()
    },
    items,
    comments
  };

  return {
    ok: true,
    payload,
    catalogSource,
    comunaMatched: Boolean(comunaResolved.matched),
    comunaRaw
  };
}

/**
 * submitBarrilesSaleFromSession: Valida sesión → llama API → formatea mensaje de cierre.
 *
 * @param {object} session
 * @returns {Promise<{ success: boolean, url?: string, totalPrice?: number, closingReply?: string, error?: string, adminBody?: string }>}
 */
export async function submitBarrilesSaleFromSession(session) {
  const built = await buildBarrilesSalePayload(session);
  if (!built.ok) {
    return { success: false, error: built.error };
  }

  console.log(
    `COT direct-sale: creando venta (catalogSource=${built.catalogSource || '?'},`
    + ` items=${built.payload.items.length}, comuna=${built.payload.client.comuna})`
  );

  const apiResult = await createDirectSaleViaApi(built.payload);
  if (!apiResult.success) {
    return { success: false, error: apiResult.error };
  }

  const totalStr = apiResult.totalPrice != null
    ? formatPrice(apiResult.totalPrice)
    : null;

  const clientEmail = built.payload.client.email;
  const closingReply = [
    '✅ *Compra creada*',
    '',
    totalStr ? `Total: *${totalStr}*` : null,
    'Aquí tienes el link de tu pedido:',
    apiResult.url,
    '',
    clientEmail
      ? `También te enviamos una *copia a tu correo* (*${clientEmail}*).`
      : 'También te enviamos una *copia a tu correo*.',
    '',
    'En esa página puedes *revisar el detalle* y ver las *instrucciones de pago*. Una vez confirmado el pago, tu pedido queda agendado.',
    '',
    'Cualquier duda, escríbenos por este chat y te ayudamos. 🍹'
  ].filter(Boolean).join('\n');

  const clientData = session.orderBuilder?.clientData || {};
  const adminBody = [
    `Cliente: ${built.payload.client.firstName} ${built.payload.client.lastName}`,
    `Email: ${built.payload.client.email}`,
    `WhatsApp: ${built.payload.client.phone || '—'}`,
    `Entrega: ${built.payload.event.date} | ${built.payload.client.comuna}`,
    `Dirección: ${built.payload.client.address || '—'}`,
    clientData.location && clientData.location !== built.payload.client.comuna
      ? `Comuna chat: ${clientData.location}`
      : null,
    !built.comunaMatched
      ? `⚠️ Comuna no matcheó catálogo web → enviada como "${built.payload.client.comuna}"`
        + (built.payload.client.otherComuna ? ` (otherComuna=${built.payload.client.otherComuna})` : '')
        + (built.comunaRaw ? ` | texto cliente: ${built.comunaRaw}` : '')
      : null,
    `URL: ${apiResult.url}`,
    totalStr ? `Total API: ${totalStr}` : null
  ].filter(Boolean).join('\n');

  // Guardamos ambas claves por simetría con eventos (cotQuote) y semántica de venta
  session.cotSale = {
    token: apiResult.token,
    quoteId: apiResult.quoteId,
    url: apiResult.url,
    totalPrice: apiResult.totalPrice,
    status: apiResult.status
  };
  session.cotQuote = session.cotSale;

  return {
    success: true,
    url: apiResult.url,
    totalPrice: apiResult.totalPrice,
    closingReply,
    adminBody
  };
}
