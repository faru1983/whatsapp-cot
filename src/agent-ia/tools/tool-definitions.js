// ==============================================================================
// OBJETIVO: Definiciones de Herramientas (Tools / Function Calling) para el LLM.
// Formato compatible con Google Gemini y OpenAI/Nvidia.
// ==============================================================================

export const AGENT_TOOLS_DEFINITIONS = [
  {
    name: 'calculate_event_estimate',
    description: 'Calcula la propuesta recomendada oficial para un evento en 2 burbujas (Burbuja 1: Medida recomendada en barriles de 5L/10L, presupuesto base, costo por trago servido y servicio 100% gratis; Burbuja 2: Catálogo de sabores agrupado en texto desde la API). ESTÁ ESTRICTAMENTE PROHIBIDO USAR SI EL CLIENTE AÚN NO HA INDICADO LOS TRAGOS POR PERSONA. Si el cliente solo dio los invitados pero aún no ha respondido cuántos tragos por persona desea calcular, NO uses esta herramienta: responde con texto anotando los invitados y pregúntale cómo quiere enfocar la barra (2 p/p complemento o 3+ p/p principal).',
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
          enum: ['dispensador'],
          description: 'Formato del servicio: "dispensador" (bar móvil autoservicio, barriles 5L y 10L, mín. 10L).'
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
    name: 'send_cocktails_catalog',
    description: 'Envía el catálogo oficial completo de variedades y precios agrupados por tramos en texto vivo desde la API. ÚSALO OBLIGATORIAMENTE cuando el cliente pida ver la carta o catálogo de cócteles.',
    parameters: {
      type: 'OBJECT',
      properties: {
        format: {
          type: 'STRING',
          enum: ['dispensador'],
          description: 'Formato del evento (por defecto dispensador).'
        }
      },
      required: []
    }
  },
  {
    name: 'build_custom_cart_quote',
    description: 'Arma el resumen oficial tipo carrito de compras con los cócteles y litros elegidos por el cliente, calculando los subtotales por ítem, el total neto, las estadísticas de consumo (cócteles, tragos p/p y valor unitario) y los servicios incluidos ($0). ÚSALO OBLIGATORIAMENTE cuando el cliente indique las variedades o sabores que quiere para su evento (ej: "10L de Mojito y 10L de Sangría", "quiero Mojito y Aperol").',
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
                description: 'Nombre del cóctel elegido (ej: "Mojito Tradicional", "Sangría", "Aperol Spritz", "Pisco Sour Clásico", "Moscow Mule", "Gin & Tonic", "Caipiriña", "Piscola").'
              },
              liters: {
                type: 'INTEGER',
                description: 'Litros del sabor (ej: 5, 10, 20 o 30).'
              }
            },
            required: ['flavor', 'liters']
          },
          description: 'Lista de variedades elegidas con sus respectivos litros.'
        }
      },
      required: ['items']
    }
  },
  {
    name: 'silent_admin_escalation',
    description: 'Silencia el bot (MUTE) de forma invisible para el cliente y envía una alerta interna inmediata al administrador de Cocktails on Tap. REGLA ESTRICTA: SOLO DEBES USARLA cuando: 1) El cliente ya tiene un carrito o cotización confirmada y entrega la FECHA de su evento para coordinar disponibilidad y cierre con el admin. 2) El cliente pide hablar con un humano o hace una pregunta compleja imposible de responder con la base de conocimiento. NUNCA la uses en saludos, preguntas iniciales, ni antes de cotizar. Tras invocar esta herramienta, NO envíes ningún mensaje al cliente; guarda absoluto silencio.',
    parameters: {
      type: 'OBJECT',
      properties: {
        clientQuestion: {
          type: 'STRING',
          description: 'La fecha indicada por el cliente para el evento o su consulta específica.'
        },
        context: {
          type: 'STRING',
          description: 'Breve contexto del estado actual de la conversación (ej: "Cliente confirmó carrito de 20L y fecha 15 de noviembre").'
        }
      },
      required: ['clientQuestion']
    }
  },
  {
    name: 'handle_payment_confirmation',
    description: 'Úsala obligatoriamente cuando el cliente envíe una confirmación de pago, comprobante de transferencia bancaria o indique que ya pagó/transfirió por la compra de un barril desechable o pedido web. Envía la confirmación al cliente ("¡Muchas gracias! Revisamos y te confirmamos enseguida 🍹"), alerta al administrador y activa MUTE para revisión humana.',
    parameters: {
      type: 'OBJECT',
      properties: {
        details: {
          type: 'STRING',
          description: 'Detalle de la confirmación de pago o comprobante enviado por el cliente (ej: "Comprobante de transferencia barril Mojito", "Cliente pagó compra web").'
        }
      },
      required: ['details']
    }
  }
];
