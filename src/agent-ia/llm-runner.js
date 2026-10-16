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

  // 7. Formato específico para la pregunta de tragos por persona (sin duplicaciones)
  out = out.replace(
    /(?:\*|_)*¿Cuántos tragos por persona te gustaría calcular\?(?:\*|_)*[ \t]*(?:\*|_)*Con eso te entrego un presupuesto estimado\.?(?:\*|_)*|¿Cuántos tragos por persona te gustaría calcular\?/gi,
    '*¿Cuántos tragos por persona te gustaría calcular?* _Con eso te entrego un presupuesto estimado._'
  );

  // 8. Si la pregunta de cierre quedó pegada después de una viñeta, separar con doble salto
  out = out.replace(/(•[^\n]+?)[ \t]+(\*?¿)/g, '$1\n\n$2');

  // 9. Separar bloques clave de cotización si quedaron en la misma línea o con salto simple
  out = out.replace(/([^\n])[ \t]+(\*Presupuesto Estimado\*)/g, '$1\n\n$2');
  out = out.replace(/([^\n])\n(?!\n)[ \t]*(\*Presupuesto Estimado\*)/g, '$1\n\n$2');

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

  // 10. Limpiar espacios horizontales duplicados en cada línea y espacios antes de puntuación
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+([.,;:!?])/g, '$1');

  // 11. Limpiar espacios vacíos al final de cada línea
  out = out.replace(/[ \t]+$/gm, '');

  // 12. Máximo 2 saltos de línea consecutivos
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
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

  let stateContextBlock = '\n\n=== ESTADO ACTUAL DE LA CONVERSACIÓN ===\n';
  if (guestsKnown && !drinksKnown) {
    stateContextBlock += `- Invitados indicados: ${guestsKnown} personas.\n- Tragos por persona: AÚN NO DEFINIDOS.\n- INSTRUCCIÓN OBLIGATORIA: NO uses herramientas de cálculo todavía. Tu respuesta obligatoria debe ser exactamente:
"¡Genial! 🍹 Ahora necesitamos definir cuántos tragos quieres calcular por persona:

• *2 tragos p/p:* ideal como complemento de otras bebidas.
• *3 o más tragos p/p:* recomendado si será la barra principal.

*¿Cuántos tragos por persona te gustaría calcular?* _Con eso te entrego un presupuesto estimado."\n`;
  } else if (guestsKnown && drinksKnown) {
    stateContextBlock += `- Invitados: ${guestsKnown} personas.\n- Tragos por persona: ${drinksKnown}.\n- INSTRUCCIÓN: Llama a calculate_event_estimate con guests=${guestsKnown} y drinksPerPerson=${drinksKnown} para entregar la "Propuesta de Barra Sugerida" con el formato oficial.\n`;
  } else {
    stateContextBlock += `- Invitados: AÚN NO INDICADOS POR EL CLIENTE. PROHIBIDO ASUMIR O INVENTAR NÚMERO DE INVITADOS. NO USES TOOLS DE CÁLCULO NI CATÁLOGO.
- Si el cliente pregunta por valores, precios o cuánto cuesta en general: explica las dos modalidades (Eventos desde $109.990 vs Barriles Desechables de 5L desde $31.990) y pregunta cuál de las dos le interesa.
- Si pregunta por servicio de eventos: explica que parte desde $109.990 y pregunta cuántos invitados tendrán.
- NO uses silent_admin_escalation a menos que pidan comida, magos, DJ, toro mecánico o hablar con un humano.\n`;
  }

  const systemInstruction = `${baseSystemInstruction}${stateContextBlock}`;
  // console.log('[DEBUG LLM STATE BLOCK]:', stateContextBlock);
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
      for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        toolCallsMade.push({ name, args });
        const toolResult = await executeAgentTool(name, args, context);

        responseParts.push({
          functionResponse: {
            name,
            response: toolResult
          }
        });
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

    const rawReply = currentResponse.response?.text?.() || '';
    const cleaned = sanitizeCustomerFacingReply(rawReply);
    const formatted = formatWhatsAppReply(cleaned);
    return {
      replyText: formatted || '¡Hola! Cuéntame cuántos invitados calculas para tu evento y te armo una propuesta de inmediato.',
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

      // 2. Tool calls devueltos en texto plano JSON por modelos como Llama 3
      const textContent = (message.content || '').trim();
      let parsedJsonCall = null;
      if (textContent.startsWith('{') && textContent.endsWith('}')) {
        try {
          const parsed = JSON.parse(textContent);
          if (parsed.name && (parsed.parameters || parsed.arguments || parsed.args)) {
            parsedJsonCall = {
              name: parsed.name,
              args: parsed.parameters || parsed.arguments || parsed.args || {}
            };
          }
        } catch (_) {}
      }

      if (parsedJsonCall) {
        const fnName = parsedJsonCall.name;
        let fnArgs = parsedJsonCall.args;
        if (typeof fnArgs === 'string') {
          try { fnArgs = JSON.parse(fnArgs); } catch (_) {}
        }

        toolCallsMade.push({ name: fnName, args: fnArgs });
        const toolResult = await executeAgentTool(fnName, fnArgs, context);

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

    const rawReply = completion.choices[0]?.message?.content || '';
    const cleaned = sanitizeCustomerFacingReply(rawReply);
    const formatted = formatWhatsAppReply(cleaned);
    return {
      replyText: formatted || '¡Hola! Cuéntame cuántos invitados calculas para tu evento y te armo una propuesta de inmediato.',
      toolCallsMade
    };
  }

  throw new Error(`Proveedor de LLM no soportado para agente IA: ${provider}`);
}
