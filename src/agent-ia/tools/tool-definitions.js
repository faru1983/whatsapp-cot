// ==============================================================================
// OBJETIVO: Definiciones de Herramientas (Tools / Function Calling) para el LLM.
// Formato compatible con Google Gemini y OpenAI/Nvidia.
// ==============================================================================

export const AGENT_TOOLS_DEFINITIONS = [
  {
    name: 'calculate_event_estimate',
    description: 'Calcula el presupuesto estimado oficial para un evento. ESTÁ PROHIBIDO USAR SI EL CLIENTE AÚN NO HA INDICADO SUS INVITADOS EN EL CHAT. Si el cliente pregunta cómo funciona o precios generales, responde con texto y NO uses esta herramienta.',
    parameters: {
      type: 'OBJECT',
      properties: {
        guests: {
          type: 'INTEGER',
          description: 'Número de invitados o personas para el evento (ej: 40, 80, 150).'
        },
        drinksPerPerson: {
          type: 'NUMBER',
          description: 'Promedio de cócteles por persona (ej: 2 para barra complemento, 3 para estándar/recomendado, 4 para barra principal).'
        },
        format: {
          type: 'STRING',
          enum: ['dispensador', 'muro', 'auto'],
          description: 'Formato preferido: "dispensador" (portátil, min 10L), "muro" (barra grande, min 30L), o "auto" según cantidad de invitados.'
        }
      },
      required: ['guests', 'drinksPerPerson']
    }
  },
  {
    name: 'calculate_formal_quote',
    description: 'Calcula la cotización formal matemática y desglose de precios para un evento según los sabores específicos elegidos, litrajes, formato y comuna de entrega.',
    parameters: {
      type: 'OBJECT',
      properties: {
        format: {
          type: 'STRING',
          enum: ['dispensador', 'muro'],
          description: 'Formato del servicio: "dispensador" o "muro".'
        },
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              flavor: {
                type: 'STRING',
                description: 'Nombre del cóctel (ej: "Mojito Tradicional", "Aperol Spritz", "Pisco Sour Clásico", "Moscow Mule", "Gin & Tonic", "Mojito Mocktail").'
              },
              liters: {
                type: 'INTEGER',
                description: 'Litros del sabor (5, 10, 20 o 30).'
              }
            },
            required: ['flavor', 'liters']
          },
          description: 'Lista de cócteles con sus respectivos litros.'
        },
        comuna: {
          type: 'STRING',
          description: 'Comuna donde se realizará el evento para calcular el traslado (opcional).'
        },
        guests: {
          type: 'INTEGER',
          description: 'Cantidad de invitados (opcional, para incluir promedio p/p).'
        }
      },
      required: ['format', 'items']
    }
  },
  {
    name: 'calculate_direct_sale',
    description: 'Calcula el total para la compra de barriles desechables de 5L (venta directa a casa) incluyendo el costo de envío a domicilio según la comuna o región. ÚSALO SOLO CUANDO EL CLIENTE HAYA INDICADO SABORES Y CANTIDADES ESPECÍFICAS DE BARRILES.',
    parameters: {
      type: 'OBJECT',
      properties: {
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              flavor: {
                type: 'STRING',
                description: 'Nombre del cóctel en barril desechable de 5L (ej: "Mojito Tradicional", "Pisco Sour Clásico", "Sangría").'
              },
              quantity: {
                type: 'INTEGER',
                description: 'Cantidad de barriles de 5L de este sabor.'
              }
            },
            required: ['flavor', 'quantity']
          },
          description: 'Lista de barriles desechables de 5L.'
        },
        comuna: {
          type: 'STRING',
          description: 'Comuna o ciudad de despacho (ej: "Providencia", "Viña del Mar", "Concepción").'
        }
      },
      required: ['items']
    }
  },
  {
    name: 'sync_lead_crm',
    description: 'Registra o actualiza al cliente como Lead Interesado en el CRM/ERP de Cocktails on Tap con los datos recopilados en la conversación.',
    parameters: {
      type: 'OBJECT',
      properties: {
        intent: {
          type: 'STRING',
          enum: ['event', 'direct'],
          description: 'Tipo de interés: "event" (servicio eventos) o "direct" (barriles desechables).'
        },
        summary: {
          type: 'STRING',
          description: 'Resumen en una línea de lo conversado o cotizado (ej: "40 personas, 25L Mojito y Aperol en Providencia").'
        },
        guests: {
          type: 'INTEGER',
          description: 'Cantidad de invitados (opcional).'
        },
        eventDate: {
          type: 'STRING',
          description: 'Fecha tentativa o exacta del evento/entrega (opcional).'
        },
        comuna: {
          type: 'STRING',
          description: 'Comuna del evento o despacho (opcional).'
        }
      },
      required: ['intent', 'summary']
    }
  },
  {
    name: 'get_available_cocktails_catalog',
    description: 'Obtiene la carta de sabores de cócteles. ESTÁ ESTRICTAMENTE PROHIBIDO USAR ante preguntas genéricas de precios como "¿cuáles son los valores?" o "¿cuánto cuesta?". ÚSALO ÚNICAMENTE cuando el cliente ya esté cotizando y pida ver la carta de sabores o la lista de cócteles disponibles (ej: "qué sabores tienen", "muéstrame las variedades", "qué cócteles hay").',
    parameters: {
      type: 'OBJECT',
      properties: {
        format: {
          type: 'STRING',
          enum: ['dispensador', 'muro'],
          description: 'Formato a consultar (dispensador o muro).'
        },
        category: {
          type: 'STRING',
          enum: ['all', 'cocteles', 'combinados', 'mocktails'],
          description: 'Categoría a consultar (all por defecto).'
        }
      },
      required: ['format']
    }
  },
  {
    name: 'silent_admin_escalation',
    description: 'Silencia el bot (MUTE) de forma invisible para el cliente y envía una alerta interna inmediata al administrador de Cocktails on Tap. ÚSALO OBLIGATORIAMENTE cuando: 1) El cliente responda indicando qué sabores le interesan o la fecha de su evento tras recibir la cotización estimada (listo para coordinar y cerrar reserva con un humano). 2) El cliente haga preguntas específicas, complejas o dudosas fuera de la base de conocimiento (comida, catering, DJ, bandas, magos, traslados especiales, etc.). 3) El cliente solicite hablar con una persona humana o negociar precios. 4) El mensaje sea confuso o ambiguo y no se pueda responder con certeza. REGLA ESTRICTA: Tras invocar esta herramienta, NO envíes ningún mensaje al cliente; guarda absoluto silencio.',
    parameters: {
      type: 'OBJECT',
      properties: {
        clientQuestion: {
          type: 'STRING',
          description: 'La consulta puntual, sabores elegidos, fecha o solicitud del cliente.'
        },
        context: {
          type: 'STRING',
          description: 'Breve contexto del estado actual de la conversación (ej: "Cotizó 80 personas, 3 tragos p/p. Ahora respondió con Aperol y Mojito para el 15 de noviembre").'
        }
      },
      required: ['clientQuestion']
    }
  }
];
