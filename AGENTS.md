# Instrucciones para agentes — whatsapp-cot

Fuente de verdad del proyecto (no duplicar en otros sitios):

| Archivo | Contenido |
|---|---|
| [`.cursor/rules/whatsapp-cot-context.mdc`](.cursor/rules/whatsapp-cot-context.mdc) | Arquitectura, flujos, convenciones, scripts |
| [`.cursor/rules/agent-workflow.mdc`](.cursor/rules/agent-workflow.mdc) | **Cómo interpretar pedidos de cambio** + terminal `test:local` + mapa estado→archivo |
| [`.cursor/rules/eventos-implementation.mdc`](.cursor/rules/eventos-implementation.mdc) | **Reglas de implementación Eventos** — Dispensador/Muro, sabores, precios, IA, strikes |
| [`.cursor/rules/coding-standards.mdc`](.cursor/rules/coding-standards.mdc) | Estilo, comentarios didácticos, modularidad |
| [`.cursor/rules/systemic-fixes.mdc`](.cursor/rules/systemic-fixes.mdc) | Arreglar patrones, no casos puntuales |
| [`.cursor/rules/conversational-rails.mdc`](.cursor/rules/conversational-rails.mdc) | **Validación + tres oficios de IA**, FAQ, strikes, handoff |

## Inicio de sesión (agente)

1. Si el usuario adjunta **terminal** o texto del bot → leer `agent-workflow.mdc` y ubicar estado + archivo.
2. Si el cambio es de copy visible → grep del string + actualizar `scripts/verify-flows.mjs` + `npm run verify`.
3. Asumir flujo **Eventos** salvo que el terminal muestre `BARRILES_*` o `ESPERANDO_INTENCION`.
4. Si tocas Eventos (`flows/eventos/`, `eventos-*.js`) → leer **`eventos-implementation.mdc`** y mantener paridad Dispensador/Muro.
5. Si tocas parsers, FAQ, NLU o fallback del engine → leer **`conversational-rails.mdc`**.

## Comandos útiles

- `npm run test:local` — simulador CLI (el usuario prueba cambios aquí)
- `npm run verify` — obligatorio antes de dar por terminado un cambio de flujos
