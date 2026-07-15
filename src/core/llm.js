// ==============================================================================
// OBJETIVO: Motor de Inteligencia Artificial (Conector LLM).
// Aquí se gestionan las conexiones físicas hacia los servidores de OpenAI o Google,
// enviando el historial y recibiendo la respuesta inteligente (texto puro).
// ==============================================================================
import OpenAI from 'openai'; // Importamos la librería OpenAI. Aunque usemos Nvidia, sus servidores son compatibles con el formato de OpenAI.
import { GoogleGenerativeAI } from '@google/generative-ai'; // Importamos la librería oficial de Google para usar Gemini.
import { getEnv } from './config.js'; // Función para cargar las claves API Keys y configuraciones de proveedor.
import { buildFaqCatalogContext, sanitizeCustomerFacingReply } from '../logic/utils.js'; // Catálogo/despachos + limpieza de jerga interna.
import { testLog } from './debug-log.js';

/**
 * generateResponse: Función que se conecta con la IA (Gemini o Nvidia)
 * y genera la respuesta inteligente que le enviaremos al cliente de WhatsApp.
 * 
 * @param {Object} config - Parámetros como la temperatura (creatividad) y tokens máximos.
 * @param {string} systemInstruction - Las instrucciones de comportamiento y tabla de precios oficial.
 * @param {Array} contents - Historial de chat en formato de turnos de Gemini.
 * @returns {Promise<string|null>} La respuesta escrita por la IA, o "null" si falla la conexión.
 */
export async function generateResponse(config, systemInstruction, contents) {
  // Leemos las claves API y qué proveedor usar (desde el archivo .env)
  const env = getEnv();
  const { provider, apiKey, model } = env;

  try {
    // =========================================================================
    // CASO 1: GOOGLE GEMINI (Por defecto)
    // =========================================================================
    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(apiKey); // Conectamos con el cliente de Google
      
      // Creamos la instancia del modelo inyectándole la personalidad del bot y precios (systemInstruction)
      const genModel = client.getGenerativeModel({ model, systemInstruction });
      
      // Enviamos el historial de la charla y esperamos la respuesta
      const result = await genModel.generateContent({
        contents,
        generationConfig: { 
          temperature: config.temperature ?? 0.8, // Regula la creatividad del bot (0.8 es ideal para conversar natural)
          maxOutputTokens: config.maxOutputTokens ?? 400 // Límite de palabras de respuesta
        }
      });
      
      const responseText = result.response?.text?.().trim();
      // Quitamos jerga interna ("DATOS OFICIALES", "FAQ", etc.) si el modelo la filtró
      const cleaned = sanitizeCustomerFacingReply(responseText);
      return cleaned || null;
    }

    // =========================================================================
    // CASO 2: NVIDIA (Llama 3 u otros modelos)
    // =========================================================================
    if (provider === 'nvidia') {
      // Configuramos el cliente con la URL del servidor de Nvidia y su API Key
      const openai = new OpenAI({
        apiKey,
        baseURL: 'https://integrate.api.nvidia.com/v1',
      });

      // Gemini y OpenAI/Nvidia guardan el historial en formatos distintos.
      // Aquí "traducimos" el historial de Gemini al formato que entiende OpenAI:
      // - El rol 'model' pasa a llamarse 'assistant'.
      // - El texto se extrae de la estructura de partes.
      const messages = [
        { role: 'system', content: systemInstruction }, // Primera instrucción con las reglas
        ...contents.map((c) => ({
          role: c.role === 'model' ? 'assistant' : c.role,
          content: Array.isArray(c.parts) ? c.parts[0].text : c.content,
        }))
      ];

      // Solicitamos a Nvidia la generación de respuesta por chat completions
      const completion = await openai.chat.completions.create({
        model,
        messages,
        temperature: config.temperature ?? 0.8,
        max_tokens: config.maxOutputTokens ?? 400,
        stream: false,
      });

      const reply = completion.choices?.[0]?.message?.content?.trim();
      // Misma limpieza que en Gemini: el cliente no debe ver nombres de archivos ni "FAQ"
      const cleaned = sanitizeCustomerFacingReply(reply);
      return cleaned || null;
    }

    // Si el archivo .env tiene un proveedor desconocido, lanzamos un error en la terminal
    throw new Error(`Proveedor de IA no soportado: ${provider}`);

  } catch (err) {
    // RED DE SEGURIDAD: Si los servidores de la IA fallan o no hay internet:
    // 1. Imprimimos el error detallado en la terminal para que los administradores lo revisen.
    const providerLabel = (provider || 'llm').toUpperCase();
    console.error(`[bot] Error en API ${providerLabel}:`, err.message);
    
    // 2. Devolvemos null para que el bot se quede callado y no le mande textos rotos o raros al cliente.
    return null;
  }
}

/**
 * extractProductsWithAI: Módulo NLU Híbrido. Extrae la intención del usuario
 * de comprar cócteles y la mapea estrictamente a los nombres oficiales del catálogo.
 * También detecta ambigüedades (ej: "piscola") para preguntar por la variante.
 * Devuelve un objeto JSON. Ej: { productos: [], dudas: [] }
 * 
 * @param {string} userMessage - Lo que escribió el cliente
 * @param {Array<string>} catalogNames - Nombres válidos del catálogo
 * @param {string} lastBotMessage - El último mensaje del bot para dar contexto
 * @returns {Promise<{productos: Array<{name: string, quantity: number}>, dudas: Array<{mencionado: string, opciones: Array<string>}>}>}
 */
export async function extractProductsWithAI(userMessage, catalogNames, lastBotMessage = "") {
  const env = getEnv();
  const { provider, apiKey, model } = env;
  const config = { temperature: 0.1, maxOutputTokens: 800 };

  const systemInstruction = `Eres un extractor de datos de compras estructurado (NLU).
El usuario intentará pedir cócteles de una lista.
Tu única tarea es leer su mensaje y devolver estrictamente un JSON válido.

Contexto del bot (último mensaje que el bot le envió al usuario):
"${lastBotMessage}"
USA ESTE CONTEXTO para entender si el usuario está respondiendo a una duda previa (ej: eligiendo una marca) o pidiendo algo nuevo. Si está respondiendo a una opción que el bot le dio, asume cantidad 1 a menos que especifique otra.

El formato debe ser un objeto JSON con 4 llaves: "analisis", "productos", "dudas" y "quiere_avanzar".
1. "analisis": Escribe un breve razonamiento de lo que pidió el usuario.
2. "productos": Array de objetos con "name" y "quantity". Úsalo para los productos que el usuario especificó claramente.
3. "dudas": Array de objetos con "mencionado" y "opciones" (nombres exactos del catálogo). Úsalo si el usuario menciona un término genérico y existen varias opciones posibles.
4. "quiere_avanzar": Booleano (true o false). Ponlo en true si el usuario indica que NO quiere más cócteles, que está listo, o escribe "seguimos", "solo estos", "listo", "continuar", "no".

Ejemplo 1 (Duda real): {"analisis": "Pidió piscola (hay varias marcas).", "productos": [], "dudas": [{"mencionado": "piscola", "opciones": ["Piscola Alto 35°", "Piscola Mistral 35°"]}], "quiere_avanzar": false}
Ejemplo 2 (Sin duda): {"analisis": "Pidió margarita.", "productos": [{"name": "Tequila Margarita", "quantity": 1}], "dudas": [], "quiere_avanzar": false}
Ejemplo 3 (Múltiple pedido): {"analisis": "Pidió 2 mojitos y piscola.", "productos": [{"name": "Mojito", "quantity": 2}], "dudas": [{"mencionado": "piscola", "opciones": ["Piscola Alto 35°", "Piscola Mistral 35°"]}], "quiere_avanzar": false}
Ejemplo 4 (Avance): {"analisis": "Dijo que no quiere agregar más nada.", "productos": [], "dudas": [], "quiere_avanzar": true}
Ejemplo 5 (Solo "seguimos"): {"analisis": "Confirmó el pedido con seguimos; no agrega productos nuevos.", "productos": [], "dudas": [], "quiere_avanzar": true}

IMPORTANTE: Si el usuario solo dice "seguimos", "listo", "solo estos" o similar, productos DEBE ser [] (nunca copies el carrito del mensaje anterior del bot).
Si no pide nada o pide cosas que no existen, devuelve arrays vacíos.
REGLA CRÍTICA: En los campos "name" y "opciones", debes usar EXACTAMENTE el nombre que aparece en el catálogo. Copia y pega letra por letra. Prohibido cambiar el orden de las palabras.
Catálogo válido estricto:
${catalogNames.join('\n')}`;

  try {
    let rawText = "";

    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({ model, systemInstruction });
      const result = await genModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { 
          temperature: config.temperature, 
          maxOutputTokens: config.maxOutputTokens,
          responseMimeType: "application/json"
        }
      });
      rawText = result.response?.text?.().trim() || "[]";
    }

    if (provider === 'nvidia') {
      const openai = new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userMessage }
        ],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        response_format: { type: "json_object" },
        stream: false,
      });
      rawText = completion.choices?.[0]?.message?.content?.trim() || "[]";
    }

    testLog(`NLU productos (barriles) provider=${provider}: ${rawText}`);

    let parsed = JSON.parse(rawText);
    
    return {
      productos: (parsed && Array.isArray(parsed.productos)) ? parsed.productos : [],
      dudas: (parsed && Array.isArray(parsed.dudas)) ? parsed.dudas : [],
      quiere_avanzar: (parsed && typeof parsed.quiere_avanzar === 'boolean') ? parsed.quiere_avanzar : false
    };
  } catch (err) {
    console.error(`[bot] Error en NLU Híbrido (extractProductsWithAI):`, err.message);
    return { productos: [], dudas: [], quiere_avanzar: false }; 
  }
}

/**
 * extractEventProductsWithAI: NLU híbrido para el flujo de eventos.
 * A diferencia de barriles (siempre 5L), aquí el cliente elige litraje
 * (5L/10L en dispensador; 10L/20L/30L en muro). El número junto a "L"
 * es el tamaño del barril, NO la cantidad de unidades.
 *
 * @param {string} userMessage - Lo que escribió el cliente
 * @param {Array<string>} catalogNames - Nombres válidos del catálogo
 * @param {string} formatType - 'dispensador' | 'muro' (define litrajes válidos)
 * @param {string} lastBotMessage - Último mensaje del bot (contexto)
 * @returns {Promise<{productos: Array<{name: string, quantity: number, litrage: string}>, dudas: Array, quiere_avanzar: boolean}>}
 */
export async function extractEventProductsWithAI(userMessage, catalogNames, formatType = 'dispensador', lastBotMessage = "") {
  const env = getEnv();
  const { provider, apiKey, model } = env;
  const config = { temperature: 0.1, maxOutputTokens: 800 };

  // Litrajes permitidos según el formato elegido (dispensador o muro)
  const allowedLitrages = formatType === 'muro'
    ? ['10L', '20L', '30L']
    : ['5L', '10L'];
  const defaultLitrage = formatType === 'muro' ? '10L' : '5L';

  const systemInstruction = `Eres un extractor de datos de compras estructurado (NLU) para EVENTOS de coctelería.
El usuario pedirá cócteles con litraje (tamaño del barril).
Tu única tarea es leer su mensaje y devolver estrictamente un JSON válido.

Contexto del bot (último mensaje que el bot le envió al usuario):
"${lastBotMessage}"
USA ESTE CONTEXTO para entender si el usuario está respondiendo a una duda previa (ej: eligiendo una marca) o pidiendo algo nuevo.

Formato del evento: "${formatType}".
Litrajes VÁLIDOS para este formato: ${allowedLitrages.join(', ')}.
Litraje por defecto si el cliente NO indica tamaño: ${defaultLitrage}.

El formato debe ser un objeto JSON con 4 llaves: "analisis", "productos", "dudas" y "quiere_avanzar".
1. "analisis": Breve razonamiento de lo que pidió el usuario.
2. "productos": Array de objetos con "name", "quantity" y "litrage".
   - "name": nombre EXACTO del catálogo.
   - "quantity": cantidad de barriles (unidades). Si no dice cuántos, asume 1.
   - "litrage": tamaño del barril como string ("5L", "10L", "20L" o "30L").
3. "dudas": Array de objetos con "mencionado" y "opciones" (nombres exactos del catálogo) si hay ambigüedad (ej. "piscola").
4. "quiere_avanzar": true SOLO si el usuario indica que NO quiere más, que está listo, o escribe "no" / "solo estos" / "listo" / "seguimos".

REGLA CRÍTICA DE LITRAJE (léela con cuidado):
- En eventos, el número suele ser el TAMAÑO del barril (5/10/20/30), NO la cantidad de unidades.
- "Mojito de 20L", "20L de Mojito", "10 de mojito", "10 mojito" → quantity=1, litrage="10L" o "20L".
  Correcto: {"name":"Mojito","quantity":1,"litrage":"10L"}
  Incorrecto: quantity=10 con litrage="5L" (eso es el error más común).
- Solo usa quantity>1 si dice explícitamente unidades: "2 barriles de Mojito 10L", "2x Mojito 10L", "dos Mojitos de 10L".
- Si en el mismo mensaje hay "5L de sangría" y "10 de mojito", ambos son litrajes: 1x Sangría 5L + 1x Mojito 10L.
- Si pide un litraje NO válido para este formato, igual extráelo (el sistema validará después).

Ejemplo 1: {"analisis":"Pidió 1 mojito de 10L.","productos":[{"name":"Mojito","quantity":1,"litrage":"10L"}],"dudas":[],"quiere_avanzar":false}
Ejemplo 2: {"analisis":"Pidió aperol 20L y piscola (ambigua).","productos":[{"name":"Aperol Spritz","quantity":1,"litrage":"20L"}],"dudas":[{"mencionado":"piscola","opciones":["Piscola Alto 35°","Piscola Mistral 35°"]}],"quiere_avanzar":false}
Ejemplo 3: {"analisis":"Dijo que solo esos.","productos":[],"dudas":[],"quiere_avanzar":true}
Ejemplo 4: {"analisis":"Pidió 10 de mojito y 5L de sangría (ambos litrajes).","productos":[{"name":"Mojito","quantity":1,"litrage":"10L"},{"name":"Sangría","quantity":1,"litrage":"5L"}],"dudas":[],"quiere_avanzar":false}

Si no pide nada o pide cosas que no existen, devuelve arrays vacíos.
REGLA CRÍTICA: En "name" y "opciones" usa EXACTAMENTE el nombre del catálogo. Copia y pega letra por letra.
Catálogo válido estricto:
${catalogNames.join('\n')}`;

  try {
    let rawText = "";

    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({ model, systemInstruction });
      const result = await genModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          responseMimeType: "application/json"
        }
      });
      rawText = result.response?.text?.().trim() || "[]";
    }

    if (provider === 'nvidia') {
      const openai = new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userMessage }
        ],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        response_format: { type: "json_object" },
        stream: false,
      });
      rawText = completion.choices?.[0]?.message?.content?.trim() || "[]";
    }

    testLog(`NLU productos (eventos) provider=${provider}: ${rawText}`);

    let parsed = JSON.parse(rawText);

    // Normalizamos cada producto: name, quantity >= 1, litrage con formato "NL"
    const productos = (parsed && Array.isArray(parsed.productos) ? parsed.productos : [])
      .map((p) => {
        if (!p || !p.name) return null;
        const quantity = Math.max(1, parseInt(p.quantity, 10) || 1);
        // Aceptamos "10", "10l", "10L" → "10L"
        let litrage = String(p.litrage || defaultLitrage).toUpperCase().replace(/\s+/g, '');
        if (/^\d+$/.test(litrage)) litrage = `${litrage}L`;
        if (!/^\d+L$/.test(litrage)) litrage = defaultLitrage;
        return { name: p.name, quantity, litrage };
      })
      .filter(Boolean);

    return {
      productos,
      dudas: (parsed && Array.isArray(parsed.dudas)) ? parsed.dudas : [],
      quiere_avanzar: (parsed && typeof parsed.quiere_avanzar === 'boolean') ? parsed.quiere_avanzar : false
    };
  } catch (err) {
    console.error(`[bot] Error en NLU Eventos (extractEventProductsWithAI):`, err.message);
    return { productos: [], dudas: [], quiere_avanzar: false };
  }
}

/**
 * normalizeFaqResult: Si el modelo no devolvió exactamente NO_FAQ pero claramente
 * no respondió una FAQ (saludos, "no tengo respuesta", etc.), forzamos NO_FAQ.
 *
 * @param {string} textResult - Salida cruda del LLM
 * @returns {string} Respuesta FAQ válida o "NO_FAQ"
 */
function normalizeFaqResult(textResult) {
  const raw = (textResult || '').trim();
  if (!raw) return 'NO_FAQ';

  // Match estricto o con puntuación/espacios alrededor
  if (/^NO_FAQ[.!]?\s*$/i.test(raw)) return 'NO_FAQ';
  if (raw.toUpperCase().includes('NO_FAQ')) return 'NO_FAQ';

  // El modelo a veces inventa "no tengo esa info" en vez de NO_FAQ (ej. ante "Hola")
  const looksLikeRefusal = /no tengo (una )?respuesta|no (est[aá]|se encuentra) en (nuestra |la )?base|no (puedo|s[eé]) (responder|ayudar)|fuera de (mi|la) (conocimiento|base)|no aplica|no corresponde/i.test(raw);
  if (looksLikeRefusal) return 'NO_FAQ';

  return raw;
}

/**
 * classifyStepIntent: Clasificador NLU para pasos de DECISIÓN (menú corto / sí-no).
 * Cajita 2: cuando las keywords fallan, la IA elige UNA etiqueta permitida
 * (typos, sinónimos, frases naturales). NO busca FAQ ni genera respuesta al cliente.
 *
 * Preferir importar desde logic/nlu-intent.js (puerta clara de NLU).
 * Orquestación keywords→IA: logic/decision-intent.js.
 * IMPORTANTE: NO usar en pasos de datos (fecha, comuna, cócteles, litraje).
 *
 * @param {object} opts
 * @param {string} opts.userMessage - Lo que escribió el cliente
 * @param {string} opts.stepQuestion - Pregunta del paso (contexto)
 * @param {string[]} opts.allowedLabels - Etiquetas válidas (ej. ['WEB','CHAT'])
 * @param {string} [opts.lastBotMessage] - Último mensaje del bot (opcional)
 * @param {Record<string, string>} [opts.labelHints] - Qué significa cada etiqueta (evita confusiones)
 * @returns {Promise<string|null>} Una etiqueta de allowedLabels, o null si no hay certeza
 */
export async function classifyStepIntent({
  userMessage,
  stepQuestion,
  allowedLabels,
  lastBotMessage = '',
  labelHints = {}
}) {
  const labels = Array.isArray(allowedLabels)
    ? allowedLabels.map((l) => String(l).trim().toUpperCase()).filter(Boolean)
    : [];
  if (!userMessage || labels.length === 0) return null;

  const env = getEnv();
  const { provider, apiKey, model } = env;
  // Temperatura baja: queremos clasificación estable, no creatividad
  const config = { temperature: 0.1, maxOutputTokens: 120 };
  const labelsList = labels.join(', ');

  // Si el flujo pasó pistas, las mostramos para que la IA no confunda (ej. WEB vs CHAT)
  const labelBlock = labels.map((l) => {
    const hint = labelHints[l] || labelHints[l.toLowerCase()];
    return hint ? `- ${l}: ${hint}` : `- ${l}`;
  }).join('\n');

  const systemInstruction = `Eres un clasificador de intención estricto para un bot de WhatsApp de cotizaciones.
Tu ÚNICA tarea: leer el mensaje del cliente y devolver un JSON con la etiqueta que mejor describe su respuesta al paso actual.

Pregunta del paso (lo que el bot acaba de preguntar):
"${stepQuestion}"

Último mensaje del bot (contexto extra):
"${lastBotMessage || '(no disponible)'}"

Etiquetas PERMITIDAS (elige EXACTAMENTE una, o UNCLEAR):
${labelBlock}
- UNCLEAR: no responde al paso, es ambiguo, o es otra pregunta

REGLAS:
1. Responde SOLO un JSON válido: {"intent":"ETIQUETA","confidence":"high"|"low"}
2. "intent" debe ser una de las etiquetas permitidas O "UNCLEAR".
3. Usa "high" solo si estás bastante seguro (incluye typos leves y sinónimos claros).
4. Si el mensaje es una pregunta de otra cosa, saludo vacío, o no responde al paso → UNCLEAR + low.
5. PROHIBIDO inventar etiquetas nuevas. PROHIBIDO devolver texto fuera del JSON.
6. No clasifiques datos concretos (fechas, comunas, nombres de cócteles) como decisión: eso es UNCLEAR.
7. Lee bien las pistas de cada etiqueta. Ej.: si WEB = ir al sitio y CHAT = seguir en WhatsApp, "voy a meterme a ver / entrar a la página / prefiero el link / lo veré / lo veo / lo reviso" es WEB, NO CHAT.
8. Si el paso es web vs chat y el cliente solo dice "precio", "valor", "cuánto", "cuánto cuestan" SIN elegir canal → UNCLEAR (es duda, no decisión).
9. Cortesía o entusiasmo SIN elegir opción → UNCLEAR + low. Ej.: "gracias", "ok", "dale", "hola", "Hoooola q genial". NUNCA elijas WEB/BARRILES/EVENTOS/CHAT solo por el último mensaje del bot.
10. No adivines por el orden del menú ni por la última opción citada. Si el cliente no eligió de forma explícita o con sinónimo claro → UNCLEAR.

Ejemplo: {"intent":"${labels[0]}","confidence":"high"}`;

  try {
    let rawText = '';

    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({ model, systemInstruction });
      const result = await genModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          responseMimeType: 'application/json'
        }
      });
      rawText = result.response?.text?.().trim() || '';
    }

    if (provider === 'nvidia') {
      const openai = new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userMessage }
        ],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        response_format: { type: 'json_object' },
        stream: false
      });
      rawText = completion.choices?.[0]?.message?.content?.trim() || '';
    }

    if (!rawText) return null;

    // A veces el modelo envuelve el JSON en markdown; lo limpiamos
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const intent = String(parsed?.intent || '').trim().toUpperCase();
    const confidence = String(parsed?.confidence || '').trim().toLowerCase();

    testLog(`NLU decisión: labels=[${labelsList}] → intent=${intent} confidence=${confidence}`);

    // Solo aceptamos etiqueta permitida con confianza alta (evita avances dudosos)
    if (confidence !== 'high') {
      testLog(`NLU decisión: descartado (confidence≠high)`);
      return null;
    }
    if (!labels.includes(intent)) {
      testLog(`NLU decisión: descartado (etiqueta no permitida)`);
      return null;
    }
    return intent;
  } catch (err) {
    console.error(`[bot] Error en classifyStepIntent:`, err.message);
    return null;
  }
}

/**
 * responderFAQ: Evalúa si el mensaje del cliente es una pregunta frecuente y responde
 * usando faq.json + un resumen oficial de datos.json (catálogo y despachos RM).
 * Si no corresponde a ninguna FAQ ni a esos datos, devuelve "NO_FAQ".
 *
 * @param {string} userMessage - El mensaje que escribió el cliente.
 * @param {Array} faqData - Arreglo de objetos {pregunta, respuesta}
 * @param {object} [sessionContext] - Contexto del chat para adaptar respuestas (ej. rendimiento)
 * @param {string} [sessionContext.userIntent] - 'BARRILES' | 'EVENTOS' | undefined
 * @param {string} [sessionContext.eventoFormato] - 'Dispensador Portátil' | 'Muro de Coctelería' | undefined
 * @returns {Promise<string>} Devuelve la respuesta redactada o "NO_FAQ".
 */
export async function responderFAQ(userMessage, faqData, sessionContext = {}) {
  const env = getEnv();
  const { provider, apiKey, model } = env;
  // Un poco más de tokens: respuestas de precio/despacho pueden listar 1–3 ítems
  const config = { temperature: 0.1, maxOutputTokens: 350 };

  // Catálogo + despachos RM compactos (misma fuente que usa OrderBuilder / carta)
  const catalogContext = buildFaqCatalogContext();

  // Contexto del flujo: sirve para no listar litrajes de evento si está en desechables
  const intent = sessionContext.userIntent || 'No definido';
  const eventoFormato = sessionContext.eventoFormato || 'No elegido';
  const sessionBlock = `=== CONTEXTO DE SESIÓN ===
- Intención actual: ${intent} (BARRILES = desechables 5L; EVENTOS = dispensador/muro)
- Formato de evento elegido: ${eventoFormato}`;

  const systemInstruction = `Eres un clasificador + redactor de FAQ estricto.
El usuario escribió: "${userMessage}"

=== BASE FAQ (faq.json) ===
${JSON.stringify(faqData, null, 2)}

=== ${catalogContext} ===

${sessionBlock}

REGLAS:
1. Responde SOLO si el mensaje es claramente una pregunta sobre:
   - Una FAQ de la lista (horarios, envíos/regiones, dónde entregan, de dónde son / de qué parte son, pago, web, Instagram, correo, teléfono, rendimiento, duración/conservación de barriles), O
   - Precios / catálogo / carta / valor de un cóctel o extra (usar la información oficial de arriba), O
   - Ingredientes / de qué está hecho un cóctel del catálogo (usar SOLO el campo "Ingredientes" de la información oficial), O
   - Costo de despacho a una comuna de la RM (usar tabla DESPACHOS; distinguir desechable vs evento).
2. Saludos ("hola", "buenas"), "ok", "gracias", ruido o mensajes sin pregunta → responde EXACTAMENTE: NO_FAQ
3. Si no hay match claro → responde EXACTAMENTE: NO_FAQ
4. PROHIBIDO inventar precios, comunas, tarifas o ingredientes. Si el dato no está en FAQ ni en la información oficial → NO_FAQ
5. INGREDIENTES (muy importante):
   - Si preguntan de qué está hecho un cóctel (ej. "¿qué ingredientes tiene la Sangría?"): responde SOLO con la lista "Ingredientes:" de ese producto. Amable y breve.
   - PROHIBIDO agregar frutas, licores u otros ingredientes que no aparezcan en esa ficha (nada de "frutas frescas" genéricas si no están escritas ahí).
   - Si el cóctel no está en el catálogo → NO_FAQ
6. PRECIOS DE CÓCTELES (muy importante):
   - Todos los productos son BARRILES, en 3 categorías: (1) barril desechable 5L, (2) barril para eventos con Dispensador Portátil, (3) barril para eventos con Muro de Coctelería.
   - Si preguntan el precio de un cóctel SIN indicar categoría (ej. "¿cuánto vale el Pisco Sour?"): NO listes los 3 precios. Aclara brevemente que hay 3 formatos de barril y PREGUNTA cuál quiere cotizar (desechable 5L / Dispensador / Muro).
   - Solo da el precio numérico cuando el cliente ya eligió la categoría (o la dejó inequívoca). Entonces responde SOLO ese canal, con litraje si aplica.
   - PROHIBIDO pegar la tabla completa desechable+dispensador+muro en una sola respuesta.
7. Origen / cobertura / envíos:
   - "¿De dónde son?": Somos de Santiago (FAQ de origen).
   - Cobertura: repartimos en todas las comunas de la RM; a otras regiones por Blue Express o empresas similares de encomiendas (FAQ de envíos).
   - Si preguntan costo a una comuna de RM: usa la tabla DESPACHOS. Fuera de RM: no inventes monto; di encomienda y que el costo se confirma al comprar. En RM: si no dicen si es barril desechable o evento, pregunta antes de cotizar el envío.
8. RENDIMIENTO DE BARRILES (según CONTEXTO DE SESIÓN; vaso/copa con hielo ≈ 200ml):
   - Si intención = BARRILES: responde SOLO que el barril desechable de 5L rinde aprox. 25 cócteles. NO menciones 10L, 20L, 30L ni formatos de evento.
   - Si intención = EVENTOS y formato = Dispensador Portátil: solo 5L≈25 y 10L≈50 tragos.
   - Si intención = EVENTOS y formato = Muro de Coctelería: solo 10L≈50, 20L≈100, 30L≈150 tragos.
   - Si intención = EVENTOS sin formato aún: puedes dar 5L/10L (dispensador) y mencionar que el Muro usa 10L/20L/30L, o preguntar el formato.
   - Si intención no definida: resumen breve y pregunta si cotiza desechable o evento. NO pegues la tabla completa si el contexto ya es claro.
9. DURACIÓN / CONSERVACIÓN (no confundir con rendimiento):
   - Si preguntan cuánto DURAN, se conservan, caducidad o si se pueden guardar/volver a refrigerar: usa la FAQ de duración.
   - Responde SOLO sobre Barriles Desechables 5L: ≈ 3 semanas refrigerados; se pueden servir y, si sobra, volver a guardar en el refri.
   - NO inventes duración para Dispensador/Muro. Redacta en español natural de vendedor; NUNCA copies instrucciones internas ("Habla SOLO", "Responde SOLO según…").
10. Si preguntan "precios" o "carta" de forma general: explica las 3 categorías de barril en 1–2 líneas, menciona la web https://cocktailsontap.cl/cotizar y ofrece cotizar un cóctel concreto cuando digan formato. No pegues el catálogo completo.
11. Extras o comuna concreta (con categoría clara): responde solo ese dato, amable y breve, en pesos chilenos.
12. PROHIBIDO decir "no tengo respuesta" o disculparte cuando no hay match. En ese caso SOLO: NO_FAQ
13. ANTI-JERGA INTERNA (crítica): NUNCA escribas al cliente palabras como "DATOS OFICIALES", "FAQ", "faq.json", "datos.json", "sección", "base de datos", "CONTEXTO DE SESIÓN" ni "consultar la tabla en...". Habla solo como vendedor: da la info útil en español chileno cordial. NUNCA pegues meta-instrucciones de la base FAQ.`;

  try {
    let textResult = "NO_FAQ";
    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({ model, systemInstruction });
      const result = await genModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { temperature: config.temperature, maxOutputTokens: config.maxOutputTokens }
      });
      textResult = result.response?.text?.().trim() || "NO_FAQ";
    }

    if (provider === 'nvidia') {
      const openai = new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userMessage }
        ],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: false,
      });
      textResult = completion.choices?.[0]?.message?.content?.trim() || "NO_FAQ";
    }

    // Primero normalizamos NO_FAQ; si es respuesta real, limpiamos jerga interna
    const normalized = normalizeFaqResult(textResult);
    if (normalized === 'NO_FAQ') return 'NO_FAQ';
    return sanitizeCustomerFacingReply(normalized) || 'NO_FAQ';
  } catch (err) {
    console.error(`[bot] Error en responderFAQ:`, err.message);
    return "NO_FAQ";
  }
}

