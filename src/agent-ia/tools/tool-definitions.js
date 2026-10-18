// ==============================================================================
// OBJETIVO: Definiciones de Herramientas (Tools / Function Calling) para el LLM.
// Formato compatible con Google Gemini y OpenAI/Nvidia.
// ==============================================================================

export const AGENT_TOOLS_DEFINITIONS = [
  {
    name: 'calculate_event_estimate',
    description: 'Calcula el presupuesto estimado oficial para un evento en 2 burbujas, destacando el costo por trago servido y el servicio todo incluido ($0 adicional). ESTÁ PROHIBIDO USAR SI EL CLIENTE AÚN NO HA INDICADO SUS INVITADOS EN EL CHAT. Si el cliente pregunta cómo funciona o precios generales, responde con texto y NO uses esta herramienta.',
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
    name: 'send_cocktails_catalog',
    description: 'Envía la carta oficial completa de variedades y precios (imagen lista_precios_completa.webp en la primera burbuja + texto de instrucciones y ejemplo dinámico según los litros del evento en la segunda burbuja). ÚSALO OBLIGATORIAMENTE cuando el cliente responda afirmativamente a la propuesta (ej: "sí", "dale", "porfa", "mándala", "claro", "bueno") o pida ver la carta de cócteles.',
    parameters: {
      type: 'OBJECT',
      properties: {
        format: {
          type: 'STRING',
          enum: ['dispensador', 'muro'],
          description: 'Formato del evento (opcional, por defecto dispensador).'
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
    description: 'Silencia el bot (MUTE) de forma invisible para el cliente y envía una alerta interna inmediata al administrador de Cocktails on Tap. ÚSALO OBLIGATORIAMENTE cuando: 1) El cliente responda con la fecha de su evento tras confirmar el carrito de compras (o en cualquier momento que indique la fecha final para coordinar reserva). 2) El cliente haga preguntas específicas complejas fuera de catálogo o pida hablar con un humano. REGLA ESTRICTA: Tras invocar esta herramienta, NO envíes ningún mensaje al cliente; guarda absoluto silencio.',
    parameters: {
      type: 'OBJECT',
      properties: {
        clientQuestion: {
          type: 'STRING',
          description: 'La fecha indicada por el cliente, su solicitud o mensaje.'
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
