// ==============================================================================
// OBJETIVO: Conector LLM del Agente IA con soporte de Tools / Function Calling.
// Gestiona el ciclo conversacional completo con Gemini u OpenAI/Nvidia.
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { getEnv } from '../core/config.js';
import { sanitizeCustomerFacingReply } from '../logic/utils.js';
import { ensureCatalogIndex } from '../logic/cot-catalog.js';
import { AGENT_TOOLS_DEFINITIONS } from './tools/tool-definitions.js';
import { executeAgentTool } from './tools/tool-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * loadSystemPromptAndKnowledge: Carga el system prompt y todos los .md de knowledge.
 * 
 * @returns {string} Instrucción del sistema completa
 */
function loadSystemPromptAndKnowledge() {
  const promptPath = path.join(__dirname, 'prompts', 'system-prompt.md');
  let basePrompt = '';
  try {
    basePrompt = fs.readFileSync(promptPath, 'utf8');
  } catch (err) {
    basePrompt = 'Eres un asesor comercial cordial de Cocktails on Tap en Santiago de Chile.';
  }

  const knowledgeDir = path.join(__dirname, 'knowledge');
  let knowledgeContent = '\n\n=== BASE DE CONOCIMIENTO OFICIAL ===\n';
  try {
    if (fs.existsSync(knowledgeDir)) {
      const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const fullPath = path.join(knowledgeDir, file);
        const text = fs.readFileSync(fullPath, 'utf8');
        knowledgeContent += `\n--- DOCUMENTO: ${file} ---\n${text}\n`;
      }
    }
  } catch (err) {
    console.warn('No se pudo cargar knowledge directory:', err.message);
  }

  return `${basePrompt}\n${knowledgeContent}`;
}

/**
 * formatWhatsAppReply: Da formato profesional y limpio para WhatsApp.
 * - Corrige Markdown a sintaxis nativa de WhatsApp (*negrita*, _cursiva_).
 * - Garantiza saltos de línea (\n\n) correctos entre párrafos, listas y preguntas.
 * - Evita que viñetas, precios o emojis queden comprimidos en una sola línea.
 * 
 * @param {string} text - Texto generado por el LLM o tool handler
 * @returns {string} Texto formateado para WhatsApp
 */
export function formatWhatsAppReply(text) {
  if (!text) return '';
  let out = String(text);

  // 1. Normalizar saltos de línea Windows CRLF -> LF
  out = out.replace(/\r\n/g, '\n');

  // 2. Convertir markdown headers a negrita WhatsApp (### Título -> *Título*)
  out = out.replace(/^#{1,6}[ \t]*(.+)$/gm, '*$1*');

  // 3. Convertir negrita Markdown **texto** a negrita WhatsApp *texto*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');

  // 4. Convertir listas markdown "* " o "- " a viñetas limpias "• "
  out = out.replace(/^([ \t]*)[*-][ \t]+/gm, '$1• ');

  // 5. Arreglar si las viñetas se pegaron a los dos puntos en una sola línea
  out = out.replace(/:[ \t]*•[ \t]*/g, ':\n\n• ');

  // 6. Arreglar viñetas consecutivas que quedaron en la misma línea
  out = out.replace(/([^\n])[ \t]+•[ \t]+/g, '$1\n• ');

  // 7. Separar preguntas que quedaron en la misma línea después de viñeta o texto
  out = out.replace(/([^\n])[ \t]+([*_]*¿[^?\n]+\?[*_]*)/g, '$1\n\n$2');
  // Asegurar doble salto si quedó con salto simple después de una viñeta
  out = out.replace(/(•[^\n]+)\n(?!\n)[ \t]*([*_]*¿[^?\n]+\?[*_]*)/g, '$1\n\n$2');

  // 8. Normalizar formato específico para la pregunta de tragos por persona (consumiendo asteriscos existentes)
  out = out.replace(
    /[*_]*¿Cuántos tragos por persona te gustaría calcular\?[*_]*([ \t]*[*_]*Con eso te entrego un presupuesto estimado\.?[*_]*)?/gi,
    '*¿Cuántos tragos por persona te gustaría calcular?*'
  );

  // 9. Asegurar que preguntas con ¿ ... ? queden siempre en negrita WhatsApp (*¿...?*)
  out = out.replace(/(^|\n)([ \t]*)[*_]*(¿[^?\n]+\?)[*_]*/gm, '$1$2*$3*');

  // 10. Colapsar cualquier asterisco múltiple remanente (ej: ** o *** -> *) para formato WhatsApp
  out = out.replace(/\*{2,}/g, '*');

  // 11. Separar bloques clave de cotización si quedaron en la misma línea o con salto simple
  out = out.replace(/([^\n])[ \t]+(\*Presupuesto Estimado:?\*?)/gi, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(\*Presupuesto Estimado:?\*?)/gi, '$1\n\n$2');

  out = out.replace(/([^\n])[ \t]+([*•👉]*[ \t]*Costo por trago:?\*?)/gi, '$1\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*([*•👉]*[ \t]*Costo por trago:?\*?)/gi, '$1\n$2');

  out = out.replace(/([^\n])[ \t]+(\*Servicio Todo Incluido:?\*?)/gi, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(\*Servicio Todo Incluido:?\*?)/gi, '$1\n\n$2');
  out = out.replace(/([^\n])[ \t]+(\*Todo Incluido:?\*?)/gi, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(\*Todo Incluido:?\*?)/gi, '$1\n\n$2');

  out = out.replace(/([^\n])[ \t]+(Lo mejor es que solo pagas)/gi, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(Lo mejor es que solo pagas)/gi, '$1\n\n$2');

  out = out.replace(/:\s*(🧊[ \t]*Hielo)/g, ':\n\n$1');
  out = out.replace(/([^\n])[ \t]+(🧊[ \t]*Hielo)/g, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(🧊[ \t]*Hielo)/g, '$1\n\n$2');

  out = out.replace(/([^\n])[ \t]+(📌[ \t*\*]*Importante:?\*?)/g, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(📌[ \t*\*]*Importante:?\*?)/g, '$1\n\n$2');

  out = out.replace(/([^\n])[ \t]+(🤔)/g, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(🤔)/g, '$1\n\n$2');
  out = out.replace(/🤔\n+[ \t]*(\*?¿)/g, '🤔 $1');

  // Separar también antes de la lista de cócteles / combinados en catálogo
  out = out.replace(/([^\n])[ \t]+(🍹[ \t*\*]*Cócteles)/gi, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(🍹[ \t*\*]*Cócteles)/gi, '$1\n\n$2');

  // 12. Limpiar espacios horizontales duplicados en cada línea y espacios antes de puntuación
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+([.,;:!?])/g, '$1');

  // 13. Limpiar espacios vacíos al final de cada línea
  out = out.replace(/[ \t]+$/gm, '');

  // 14. Máximo 2 saltos de línea consecutivos
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

/**
 * parseReplyToBubbles: Parsea la respuesta del bot hacia WhatsApp.
 * - Si contiene '===BURBUJA===', separa en múltiples burbujas (array).
 * - Si contiene '[IMG:archivo.webp]' o '[VID:archivo.mp4]', crea el objeto de media { type: 'image'|'video', file: '...' }.
 * - Soporta tags multimedia en cualquier posición (inicio, medio o final del texto).
 * - Garantiza que si se envía la carta de precios, la imagen sea la primera burbuja y siempre vaya acompañada de la guía de litros.
 * 
 * @param {string} text - Texto completo a procesar
 * @param {object} [session={}] - Sesión actual para extraer litros cotizados
 * @returns {string|object|Array<string|object>|null}
 */
export function parseReplyToBubbles(text, session = {}) {
  if (!text) return null;
  const rawStr = String(text).trim();
  if (!rawStr) return null;

  // 1. Separar primero por el delimitador explícito ===BURBUJA=== si existe
  const rawChunks = rawStr.split(/\n*[ \t]*===BURBUJA===[ \t]*\n*/i);
  const outBubbles = [];

  for (const chunk of rawChunks) {
    const trimmedChunk = chunk.trim();
    if (!trimmedChunk) continue;

    // 2. Extraer cualquier tag [IMG:archivo] o [VID:archivo] que esté en cualquier posición
    const segments = trimmedChunk.split(/(\[(?:IMG|VID):[^\]]+\])/gi);

    for (const seg of segments) {
      const trimmedSeg = seg.trim();
      if (!trimmedSeg) continue;

      const imgMatch = trimmedSeg.match(/^\[IMG:([^\]]+)\]$/i);
      if (imgMatch) {
        outBubbles.push({ type: 'image', file: imgMatch[1].trim() });
        continue;
      }

      const vidMatch = trimmedSeg.match(/^\[VID:([^\]]+)\]$/i);
      if (vidMatch) {
        outBubbles.push({ type: 'video', file: vidMatch[1].trim() });
        continue;
      }

      // Segmento de texto normal
      const cleaned = sanitizeCustomerFacingReply(trimmedSeg);
      const formatted = formatWhatsAppReply(cleaned);
      if (formatted) {
        outBubbles.push(formatted);
      }
    }
  }

  // 3. Garantía para la carta de variedades:
  // Si se envió lista_precios_completa.webp pero el texto no incluye la pregunta de avance
  const hasCatalogImg = outBubbles.some((b) => typeof b === 'object' && b.file === 'lista_precios_completa.webp');
  const hasCatalogQuestion = outBubbles.some((b) => typeof b === 'string' && /¿Qué variedades|Para cubrir tus/i.test(b));

  if (hasCatalogImg && !hasCatalogQuestion) {
    const liters = session?.lastTotalLiters || session?.cartLiters || 20;
    let exampleBullets = '';
    if (liters <= 10) {
      exampleBullets = `• *10L* de Mojito Tradicional\n• _(O 2 variedades de 5L como 5L Mojito y 5L Sangría)_`;
    } else if (liters === 15) {
      exampleBullets = `• *10L* de Mojito Tradicional\n• *5L* de Sangría`;
    } else if (liters === 20) {
      exampleBullets = `• *10L* de Mojito Tradicional\n• *10L* de Sangría`;
    } else if (liters === 25) {
      exampleBullets = `• *10L* de Mojito Tradicional\n• *10L* de Aperol Spritz\n• *5L* de Sangría`;
    } else {
      const mitad = Math.round(liters / 20) * 10;
      const resto = liters - mitad;
      exampleBullets = `• *${mitad}L* de Mojito Tradicional\n• *${resto}L* de Sangría`;
    }

    const followUpBubble = `👆 *¡Aquí tienes nuestra carta completa!*

Para cubrir tus *${liters} Litros*, puedes armar tu combinación favorita en formatos de 5L o 10L.

Por ejemplo:
${exampleBullets}

_(También puedes sumar combinados como Piscola o Mocktails sin alcohol)._

*¿Qué variedades te gustaría incluir en tu barra?*`;

    outBubbles.push(formatWhatsAppReply(followUpBubble));
  }

  // Si hay imagen de catálogo, nos aseguramos de que la imagen sea la primera burbuja
  if (hasCatalogImg && outBubbles.length >= 2) {
    const imgIndex = outBubbles.findIndex((b) => typeof b === 'object' && b.file === 'lista_precios_completa.webp');
    if (imgIndex > 0) {
      const [imgObj] = outBubbles.splice(imgIndex, 1);
      outBubbles.unshift(imgObj);
    }
  }

  if (outBubbles.length === 0) return null;
  return outBubbles.length === 1 ? outBubbles[0] : outBubbles;
}

/**
 * sanitizeRoboticReplies: Escudo de seguridad contra alucinaciones o mensajes de error
 * técnico generados por el LLM (ej: "No se puede responder...", "Se necesita una respuesta numérica").
 * Si detecta una respuesta robótica:
 * - Si tenemos contexto de invitados y faltan los tragos p/p, la transforma en una respuesta humana y cordial.
 * - Si no hay forma de humanizarla limpiamente, la silencia y escala para no exponer respuestas robotizadas.
 * 
 * @param {string} rawReply
 * @param {object} session
 * @param {string} userMessage
 * @returns {string|null}
 */
export function sanitizeRoboticReplies(rawReply, session = {}, userMessage = '') {
  if (!rawReply || typeof rawReply !== 'string') return rawReply;

  const isRobotic = /\b(?:no se puede responder|respuesta num[eé]rica|indique el n[uú]mero de tragos|formato inv[aá]lido|opci[oó]n inv[aá]lida|no es v[aá]lido|no es una respuesta v[aá]lida|por favor,? indique el n[uú]mero)\b/i.test(rawReply);

  if (!isRobotic) return rawReply;

  console.warn(`[LLM SHIELD] Interceptada respuesta robótica del LLM: "${rawReply.slice(0, 100)}..." ante mensaje: "${userMessage}"`);

  const guests = session?.guests;
  if (guests && !session?.drinksPerPerson) {
    const isApprox = /aprox|m[aá]s\s+o\s+menos/i.test(userMessage);
    const prefix = isApprox
      ? `¡Perfecto! Consideramos ~${guests} personas 🙌`
      : `¡Anotado! Tomamos en cuenta el detalle 🙌`;

    return `${prefix}\n\nPara poder calcular los litros ideales:\n• *2 tragos p/p:* ideal si habrá cerveza o vino.\n• *3 o más tragos p/p:* si será la barra principal de la fiesta.\n\n*¿Cuántos tragos por persona te gustaría calcular?*`;
  }

  // Si no hay contexto seguro para responder con gracia, es mejor silenciar y que un humano atienda
  return null;
}

/**
 * mapToolsForGemini: Convierte las definiciones de tools al formato de Google Generative AI.
 */
function mapToolsForGemini() {
  const declarations = AGENT_TOOLS_DEFINITIONS.map((tool) => {
    // Transformación de tipos schema a los que espera Gemini
    const transformProperties = (props) => {
      const out = {};
      for (const [key, val] of Object.entries(props || {})) {
        const copy = { ...val };
        if (copy.type === 'OBJECT' && copy.properties) {
          copy.properties = transformProperties(copy.properties);
        } else if (copy.type === 'ARRAY' && copy.items?.properties) {
          copy.items = {
            ...copy.items,
            properties: transformProperties(copy.items.properties)
          };
        }
        out[key] = copy;
      }
      return out;
    };

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.parameters.type.toLowerCase(),
        properties: transformProperties(tool.parameters.properties),
        required: tool.parameters.required || []
      }
    };
  });

  return [{ functionDeclarations: declarations }];
}

/**
 * mapToolsForOpenAI: Convierte las definiciones de tools al formato OpenAI / Nvidia.
 */
function mapToolsForOpenAI() {
  return AGENT_TOOLS_DEFINITIONS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters.properties,
        required: tool.parameters.required || []
      }
    }
  }));
}

/**
 * extractTextToolCall: Extrae llamadas a herramientas cuando el LLM las devuelve en texto plano
 * (ej: JSON {"name": "..."}, formato bracket [silent_admin_escalation(...)], o XML <function=...>)
 * muy común en modelos como Llama 3 en Nvidia/Groq/OpenAI.
 */
function extractTextToolCall(textContent) {
  if (!textContent) return null;
  const raw = String(textContent).trim();

  // 1. JSON puro o dentro del texto: { "name": "...", ... }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.name && (parsed.parameters || parsed.arguments || parsed.args)) {
        return { name: parsed.name, args: parsed.parameters || parsed.arguments || parsed.args || {} };
      }
    } catch (_) {}
  }

  // 2. Formato función estilo Python o bracket:
  // [silent_admin_escalation(clientQuestion="...", context="...")]
  // o silent_admin_escalation(clientQuestion="...")
  const fnMatch = raw.match(/\[?\b([a-zA-Z0-9_]+)\(([\s\S]*?)\)\]?/);
  if (fnMatch) {
    const fnName = fnMatch[1];
    const knownTools = ['silent_admin_escalation', 'calculate_event_estimate', 'calculate_formal_quote', 'calculate_direct_sale', 'get_available_cocktails_catalog', 'sync_lead_crm'];
    if (knownTools.includes(fnName)) {
      const rawArgs = fnMatch[2].trim();
      const args = {};
      const argRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\d+(?:\.\d+)?)|true|false)/gi;
      let m;
      while ((m = argRegex.exec(rawArgs)) !== null) {
        const key = m[1];
        const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? Number(m[4]) : true));
        args[key] = val;
      }
      return { name: fnName, args };
    }
  }

  // 3. Formato tag XML <function=name>{...}</function>
  const xmlMatch = raw.match(/<function=([a-zA-Z0-9_]+)>(.*?)<\/function>/s);
  if (xmlMatch) {
    let args = {};
    try { args = JSON.parse(xmlMatch[2]); } catch (_) {}
    return { name: xmlMatch[1], args };
  }

  return null;
}

/**
 * runAiAgentTurn: Ejecuta un turno del agente IA resolviendo posibles tool calls.
 * 
 * @param {Array<{ role: string, text: string }>} conversationTurns - Historial previo
 * @param {string} userMessage - Mensaje actual del cliente
 * @param {object} context - Contexto { session, sessionId, alertAdmin, applyBusinessLabel }
 * @returns {Promise<{ replyText: string, toolCallsMade: Array<object> }>}
 */
export async function runAiAgentTurn(conversationTurns, userMessage, context = {}) {
  const env = getEnv();
  const { provider, apiKey, model } = env;

  // Carga catálogo vivo si está disponible
  try {
    await ensureCatalogIndex({ silent: true });
  } catch (_) {}

  const baseSystemInstruction = loadSystemPromptAndKnowledge();
  const session = context.session || {};
  const guestsKnown = session.guests || context.contextMeta?.detectedGuests;
  const celebrationKnown = session.celebrationType || context.contextMeta?.detectedCelebration;
  const drinksKnown = session.drinksPerGuest || context.contextMeta?.detectedDrinksPerPerson;
  const dateKnown = session.eventDate || context.contextMeta?.detectedDate;
  const communeKnown = session.commune || context.contextMeta?.detectedCommune;
  const proposalDelivered = session.proposalDelivered || context.contextMeta?.waitingForFlavors;

  let stateContextBlock = '\n\n=== ESTADO ACTUAL DE LA CONVERSACIÓN ===\n';
  if (dateKnown) {
    stateContextBlock += `- Fecha indicada por el cliente: "${dateKnown}". (¡Ya se conoce la fecha, PROHIBIDO volver a preguntarla!).\n`;
  }
  if (communeKnown) {
    stateContextBlock += `- Comuna / Ciudad indicada: "${communeKnown}". (¡Ya se conoce la ubicación, PROHIBIDO volver a preguntarla!).\n`;
  }

  if (proposalDelivered) {
    stateContextBlock += `- La propuesta estimada de coctelería YA FUE ENTREGADA al cliente en 2 burbujas (con la pregunta si desea ver la carta de variedades).\n`
      + `- Si el cliente responde afirmativamente ("sí", "dale", "porfa", "mándala", "bueno") o pide la carta: LLAMA OBLIGATORIAMENTE a send_cocktails_catalog().\n`
      + `- Si el cliente indica qué variedades o sabores quiere (ej: "10L Mojito y 10L Sangría", "Mojito y Aperol"): LLAMA OBLIGATORIAMENTE a build_custom_cart_quote(items).\n`
      + `- Si el cliente confirma que el carrito está correcto ("sí", "me parece bien", "perfecto así"): responde entusiasmado y pregunta la fecha del evento (*¿Para qué fecha estás cotizando tu evento, así revisamos la disponibilidad de inmediato en el calendario?*).\n`
      + `- Si el cliente responde con la fecha del evento (ej: "15 de noviembre") o consultas complejas de reserva: LLAMA INMEDIATAMENTE a silent_admin_escalation(clientQuestion, context) y GUARDA ABSOLUTO SILENCIO.\n`;
  } else if (guestsKnown && !drinksKnown) {
    const lastModelTurn = [...conversationTurns].reverse().find((t) => t.role === 'model');
    const alreadyAskedDrinks = Boolean(lastModelTurn && (
      lastModelTurn.text.includes('tragos por persona') ||
      lastModelTurn.text.includes('consumo por persona')
    ));

    if (alreadyAskedDrinks) {
      stateContextBlock += `- Invitados indicados: ${guestsKnown} personas (aprox).\n`
        + `- Tipo de celebración: ${celebrationKnown || 'No indicada aún'}.\n`
        + `- Tragos por persona: AÚN PENDIENTES DE RESPONDER POR EL CLIENTE.\n`
        + `- El cliente acaba de enviar un mensaje de seguimiento o aclaración: "${userMessage}".\n`
        + `- INSTRUCCIÓN CLAVE: Acusa recibo con simpatía y calidez humana de lo que acaba de escribir (ej: si es "aprox" o aclaración de invitados, di "¡Perfecto! Consideramos ~${guestsKnown} personas 🙌"; si indicó la celebración como "bautizo" o "matrimonio", di "¡Qué linda celebración un ${celebrationKnown || 'bautizo'}! 🥂").\n`
        + `- Luego recuérdale amablemente lo que necesitamos para armar su propuesta: *¿Cuántos tragos por persona te gustaría calcular?* (puedes recordar brevemente: 2 p/p de complemento o 3+ p/p para barra principal).\n`
        + `- PROHIBICIÓN ESTRICTA: NUNCA digas que no se puede responder, que se necesita un número o que es inválido. Si no entiendes su mensaje, llama a silent_admin_escalation y guarda silencio.\n`;
    } else {
      let introMention = `tus ${guestsKnown} invitados`;
      if (celebrationKnown) introMention += ` para el ${celebrationKnown}`;
      if (communeKnown && dateKnown) introMention += ` en ${communeKnown} (${dateKnown})`;
      else if (communeKnown) introMention += ` en ${communeKnown}`;
      else if (dateKnown) introMention += ` para el ${dateKnown}`;

      stateContextBlock += `- Invitados indicados: ${guestsKnown} personas.\n`
        + `- Celebración: ${celebrationKnown || 'No indicada aún'}.\n`
        + `- Tragos por persona: AÚN NO DEFINIDOS.\n`
        + `- INSTRUCCIÓN OBLIGATORIA: NO uses herramientas de cálculo todavía. Valida con entusiasmo y calidez (menciona brevemente ${introMention}) y dale las dos referencias para definir el consumo:\n\n`
        + `• *2 tragos p/p:* ideal como complemento si habrá cerveza, vino u otras bebidas.\n`
        + `• *3 o más tragos p/p:* recomendado si será la barra principal de la fiesta.\n\n`
        + `Cierra preguntando en negrita: *¿Cuántos tragos por persona te gustaría calcular?*\n`;
    }
  } else if (guestsKnown && drinksKnown) {
    stateContextBlock += `- Invitados: ${guestsKnown} personas.\n- Tragos por persona: ${drinksKnown}.\n- INSTRUCCIÓN: Llama a calculate_event_estimate con guests=${guestsKnown} y drinksPerPerson=${drinksKnown} para entregar la "Propuesta de Barra Sugerida" destacando siempre el costo por trago.\n`;
  } else {
    stateContextBlock += `- Invitados: AÚN NO INDICADOS POR EL CLIENTE. PROHIBIDO ASUMIR O INVENTAR NÚMERO DE INVITADOS. NO USES TOOLS DE CÁLCULO NI CATÁLOGO.
- Si el cliente pregunta por valores, precios o cuánto cuesta en general: explica las dos modalidades (Eventos desde $109.990 vs Barriles Desechables de 5L desde $31.990) y pregunta cuál de las dos le interesa.
- Si pregunta por servicio de eventos: explica que el bar portátil parte desde $109.990 (incluye 10L ~ 50 cócteles con dispensador portátil, hielo, vasos, garnish e instalación gratuita, lo que da un costo por trago de solo ~$2.200 con todo incluido) y pregunta: *¿Cuántos invitados tendrás aproximadamente en tu evento?*
- Si el cliente envía un comprobante de pago o confirmación de compra de barril: llama a handle_payment_confirmation.
- Si el cliente hace una consulta fuera de catálogo, sobre comida/mago/DJ o pide un humano: llama a silent_admin_escalation y guarda silencio.\n`;
  }

  const systemInstruction = `${baseSystemInstruction}${stateContextBlock}`;
  const toolCallsMade = [];

  // ===========================================================================
  // CASO 1: GOOGLE GEMINI
  // ===========================================================================
  if (provider === 'gemini') {
    const client = new GoogleGenerativeAI(apiKey);
    const genModel = client.getGenerativeModel({
      model: model || 'gemini-1.5-flash',
      systemInstruction,
      tools: mapToolsForGemini()
    });

    // Formatear historial turnos a contents de Gemini
    const contents = [];
    for (const t of conversationTurns) {
      contents.push({
        role: t.role === 'user' ? 'user' : 'model',
        parts: [{ text: t.text }]
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    let currentResponse = await genModel.generateContent({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
    });

    // Loop de Tool Calling (máximo 4 rondas para evitar bucles infinitos)
    let loopCount = 0;
    let lastToolFormattedText = null;
    while (loopCount < 4) {
      const candidates = currentResponse.response?.candidates || [];
      const functionCalls = candidates[0]?.content?.parts?.filter((p) => p.functionCall) || [];

      if (functionCalls.length === 0) {
        break;
      }

      // Guardamos la respuesta del modelo con functionCall en el historial
      contents.push(candidates[0].content);

      // Ejecutamos las llamadas a tools
      const responseParts = [];
      let shouldMuteImmediately = false;

      for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        toolCallsMade.push({ name, args });
        const toolResult = await executeAgentTool(name, args, context);

        if (toolResult?.formattedProposalText || toolResult?.formattedCatalogText || toolResult?.formattedCartText) {
          lastToolFormattedText = toolResult.formattedProposalText || toolResult.formattedCatalogText || toolResult.formattedCartText;
        }

        if (toolResult?.allowSingleReply) {
          return {
            replyText: toolResult.reply,
            toolCallsMade,
            muted: true
          };
        }

        if (name === 'silent_admin_escalation' || toolResult?.silenceClient || session?.isMuted) {
          shouldMuteImmediately = true;
        }

        responseParts.push({
          functionResponse: {
            name,
            response: toolResult
          }
        });
      }

      if (shouldMuteImmediately || session?.isMuted) {
        return {
          replyText: null,
          toolCallsMade,
          muted: true
        };
      }

      // Enviamos el resultado de las tools de vuelta al modelo
      contents.push({
        role: 'user',
        parts: responseParts
      });

      currentResponse = await genModel.generateContent({
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
      });

      loopCount++;
    }

    if (session?.isMuted) {
      return {
        replyText: null,
        toolCallsMade,
        muted: true
      };
    }

    let rawReply = currentResponse.response?.text?.() || '';
    if (!rawReply && lastToolFormattedText) {
      rawReply = lastToolFormattedText;
    }
    rawReply = sanitizeRoboticReplies(rawReply, session, userMessage);
    if (!rawReply) {
      return {
        replyText: null,
        toolCallsMade,
        muted: true
      };
    }
    const bubbles = parseReplyToBubbles(rawReply, session);
    return {
      replyText: bubbles || null,
      toolCallsMade
    };
  }

  // ===========================================================================
  // CASO 2: NVIDIA / OPENAI
  // ===========================================================================
  if (provider === 'nvidia' || provider === 'openai') {
    const baseURL = provider === 'nvidia' ? 'https://integrate.api.nvidia.com/v1' : undefined;
    const openai = new OpenAI({ apiKey, baseURL });

    const messages = [
      { role: 'system', content: systemInstruction }
    ];

    for (const t of conversationTurns) {
      messages.push({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.text
      });
    }
    messages.push({
      role: 'user',
      content: userMessage
    });

    let completion = await openai.chat.completions.create({
      model: model || 'meta/llama-3.1-70b-instruct',
      messages,
      tools: mapToolsForOpenAI(),
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 500
    });

    let loopCount = 0;
    let lastToolFormattedText = null;
    while (loopCount < 4) {
      const choice = completion.choices[0];
      const message = choice.message;

      // 1. Tool calls nativos en message.tool_calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);

        for (const tc of message.tool_calls) {
          const fnName = tc.function.name;
          let fnArgs = {};
          try {
            fnArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {});
          } catch (_) {}

          toolCallsMade.push({ name: fnName, args: fnArgs });
          const toolResult = await executeAgentTool(fnName, fnArgs, context);

          if (toolResult?.formattedProposalText || toolResult?.formattedCatalogText || toolResult?.formattedCartText) {
            lastToolFormattedText = toolResult.formattedProposalText || toolResult.formattedCatalogText || toolResult.formattedCartText;
          }

          if (toolResult?.allowSingleReply) {
            return {
              replyText: toolResult.reply,
              toolCallsMade,
              muted: true
            };
          }

          if (fnName === 'silent_admin_escalation' || toolResult?.silenceClient || session?.isMuted) {
            return {
              replyText: null,
              toolCallsMade,
              muted: true
            };
          }

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          });
        }

        completion = await openai.chat.completions.create({
          model: model || 'meta/llama-3.1-70b-instruct',
          messages,
          temperature: 0.7,
          max_tokens: 500
        });

        loopCount++;
        continue;
      }

      // 2. Tool calls devueltos en texto plano (JSON, Python/Llama [fn(...)], o XML)
      const textContent = (message.content || '').trim();
      const parsedJsonCall = extractTextToolCall(textContent);

      if (parsedJsonCall) {
        const fnName = parsedJsonCall.name;
        let fnArgs = parsedJsonCall.args;
        if (typeof fnArgs === 'string') {
          try { fnArgs = JSON.parse(fnArgs); } catch (_) {}
        }

        toolCallsMade.push({ name: fnName, args: fnArgs });
        const toolResult = await executeAgentTool(fnName, fnArgs, context);

        if (toolResult?.allowSingleReply) {
          return {
            replyText: toolResult.reply,
            toolCallsMade,
            muted: true
          };
        }

        if (fnName === 'silent_admin_escalation' || toolResult?.silenceClient || session?.isMuted) {
          return {
            replyText: null,
            toolCallsMade,
            muted: true
          };
        }

        messages.push({
          role: 'assistant',
          content: textContent
        });
        messages.push({
          role: 'user',
          content: `[SISTEMA - RESULTADO DE HERRAMIENTA ${fnName}]: ${JSON.stringify(toolResult)}\nPor favor responde ahora al cliente en español chileno cordial con un texto natural y atractivo para WhatsApp.`
        });

        completion = await openai.chat.completions.create({
          model: model || 'meta/llama-3.1-70b-instruct',
          messages,
          temperature: 0.7,
          max_tokens: 500
        });

        loopCount++;
        continue;
      }

      break;
    }

    if (session?.isMuted) {
      return {
        replyText: null,
        toolCallsMade,
        muted: true
      };
    }

    let rawReply = completion.choices[0]?.message?.content || '';
    if (!rawReply && lastToolFormattedText) {
      rawReply = lastToolFormattedText;
    }
    rawReply = sanitizeRoboticReplies(rawReply, session, userMessage);
    if (!rawReply) {
      return {
        replyText: null,
        toolCallsMade,
        muted: true
      };
    }
    const bubbles = parseReplyToBubbles(rawReply, session);
    return {
      replyText: bubbles || null,
      toolCallsMade
    };
  }

  throw new Error(`Proveedor de LLM no soportado para agente IA: ${provider}`);
}
