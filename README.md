# WhatsApp COT — Bot de cotizaciones para Cocktails on Tap

## ¿Qué es este proyecto?

**WhatsApp COT** es un bot de WhatsApp pensado para el negocio **Cocktails on Tap** (Chile). Su trabajo es conversar con clientes por WhatsApp y guiarlos paso a paso para armar una **cotización**, sin que un vendedor tenga que responder cada mensaje a mano.

El bot ayuda con dos tipos de pedidos:

1. **Barriles desechables (5 litros)** — cócteles listos para llevar o recibir en casa.
2. **Servicio para eventos** — dispensadores o muro de cócteles para fiestas, matrimonios, cumpleaños, etc.

En la práctica, el cliente escribe por WhatsApp (por ejemplo: “quiero cotizar un mojito para 50 personas”) y el bot:

- Entiende qué quiere (barriles o evento).
- Va haciendo las preguntas necesarias (productos, fecha, comuna, cantidad, etc.).
- Calcula precios con datos reales del negocio (no inventa números).
- Entrega una cotización clara.
- Si se complica o el cliente pide hablar con una persona, avisa a un administrador y se queda en silencio.

Este README está escrito para que **cualquiera** pueda entenderlo: desde alguien que nunca programó hasta alguien que quiere estudiar o adaptar el código. Si algo suena técnico, lo explicamos en lenguaje simple.

---

## Cómo instalarlo (guía paso a paso)

Esta sección es la más importante si quieres **hacerlo funcionar en tu computador**. No hace falta ser experto: solo seguir los pasos en orden.

### Qué vas a necesitar antes de empezar

Piensa en esto como la “lista de compras” antes de cocinar:

| Qué necesitas | Para qué sirve | ¿Es gratis? |
|---|---|---|
| Un computador (Windows, Mac o Linux) | Aquí corre el bot | — |
| **Node.js** versión 18.18 o superior | Es el “motor” que ejecuta el programa (escrito en JavaScript) | Sí |
| Una cuenta de WhatsApp | El bot se conecta como un “dispositivo vinculado”, igual que WhatsApp Web | Sí (tu número) |
| Una clave de Inteligencia Artificial (API Key) | Para que el bot entienda mensajes libres y responda dudas | Hay planes gratis / de prueba |
| Un editor de texto (opcional pero recomendado) | Por ejemplo VS Code o Cursor, para editar archivos | Sí |

> **Idea clave:** el bot **no** es una app de celular. Es un programa que corre en tu PC (o en un servidor) y se conecta a WhatsApp. Mientras el programa esté encendido, el bot puede responder.

---

### Paso 1 — Instalar Node.js

1. Entra a la página oficial: [https://nodejs.org/](https://nodejs.org/)
2. Descarga la versión **LTS** (la recomendada para la mayoría de personas).
3. Instálala con el instalador (siguiente, siguiente, aceptar).
4. Abre una terminal (en Windows: PowerShell o “Símbolo del sistema”) y escribe:

```bash
node -v
```

Deberías ver algo como `v18.18.0` o un número mayor (por ejemplo `v20...` o `v22...`).  
Si aparece un error del tipo “no se reconoce el comando”, Node no quedó bien instalado: vuelve a instalarlo y cierra/abre la terminal.

También puedes comprobar el gestor de paquetes:

```bash
npm -v
```

`npm` es la herramienta que descarga las librerías que el proyecto necesita (como piezas de Lego ya hechas).

---

### Paso 2 — Bajar el código del proyecto

Si tienes el proyecto en una carpeta (por ejemplo `D:\Webs\whatsapp-cot`), ábrela en la terminal:

```bash
cd D:\Webs\whatsapp-cot
```

(En Mac/Linux la ruta será distinta; lo importante es estar **dentro** de la carpeta del proyecto.)

Si lo descargas desde GitHub con `git`:

```bash
git clone <url-del-repositorio>
cd whatsapp-cot
```

---

### Paso 3 — Instalar las dependencias (las “piezas” del programa)

Dentro de la carpeta del proyecto, ejecuta:

```bash
npm install
```

Esto lee el archivo `package.json` y descarga todo lo necesario en una carpeta llamada `node_modules`.  
Puede tardar unos minutos la primera vez. Si termina sin errores en rojo grandes, vas bien.

> **Nota:** una dependencia (`better-sqlite3`) a veces necesita herramientas de compilación en Windows. Si `npm install` falla por eso, instala las “Visual Studio Build Tools” o busca el error exacto; en muchos PCs funciona a la primera.

---

### Paso 4 — Crear tu archivo de secretos (`.env`)

El proyecto trae un ejemplo llamado `.env.example`. Tú debes crear un archivo llamado **`.env`** (con el punto al inicio) copiando ese ejemplo.

**En Windows (PowerShell), desde la carpeta del proyecto:**

```powershell
Copy-Item .env.example .env
```

**En Mac/Linux:**

```bash
cp .env.example .env
```

Luego abre `.env` con un editor de texto y completa los valores. Explicación de cada cosa importante:

#### Proveedor de IA

```env
LLM_PROVIDER=nvidia
```

Opciones:

- `gemini` → usa Google Gemini
- `nvidia` → usa modelos vía Nvidia (por ejemplo Llama)

Elige **uno** y pon la clave correspondiente más abajo.

#### Números de administradores

```env
ADMIN_NUMBERS=56912345678
```

- Escribe el número de WhatsApp **sin** el signo `+`.
- Si hay varios, sepáralos por coma: `56911111111,56922222222`
- Esas personas reciben alertas (por ejemplo cuando un cliente pide ayuda humana) y pueden usar comandos de control.

#### Claves de Inteligencia Artificial

Si usas **Gemini**:

1. Entra a [https://aistudio.google.com/](https://aistudio.google.com/)
2. Crea una API Key
3. Pégala en:

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=tu_clave_aqui
GEMINI_MODEL=gemini-2.5-flash-8b
```

Si usas **Nvidia**:

1. Entra a [https://build.nvidia.com/](https://build.nvidia.com/)
2. Crea una API Key
3. Pégala en:

```env
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=tu_clave_aqui
NVIDIA_MODEL=meta/llama-3.1-8b-instruct
```

#### Red de seguridad (opcional, ya vienen valores por defecto)

```env
SECURITY_MAX_CONSECUTIVE_ERRORS=3
SECURITY_MAX_INTENT_SWITCHES=3
```

- El primero: cuántas veces seguidas el bot “no entiende” antes de callarse y avisar a un admin.
- El segundo: cuántas veces el cliente puede cambiar de idea entre barriles y eventos al inicio.

> **Seguridad importante:** nunca subas el archivo `.env` a internet ni lo compartas en capturas. Ahí están tus claves. El proyecto ya está configurado para ignorarlo en Git.

---

### Paso 5 — (Recomendado) Probar sin WhatsApp primero

Antes de conectar el celular, puedes simular conversaciones en la terminal:

```bash
npm run test:local
```

Escribes como si fueras el cliente y el bot responde en la consola.  
Comandos útiles en esa prueba:

- `/reset` — reinicia la conversación
- `/mute` — silencia el bot
- `/unmute` — lo vuelve a activar
- `/exit` — sale del simulador

Esto es ideal para aprender el flujo sin gastar tiempo vinculando WhatsApp.

---

### Paso 6 — Encender el bot real de WhatsApp

Cuando ya tengas el `.env` listo:

```bash
npm start
```

Qué va a pasar:

1. En la terminal aparecerá un **código QR**.
2. En tu celular abre WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo**.
3. Escanea el QR.
4. Cuando diga algo como “WhatsApp conectado”, el bot ya está listo.

A partir de ahí, si alguien escribe al número vinculado, el bot puede responder (según la configuración).

> **Importante:** deja la terminal abierta (o el proceso corriendo). Si cierras el programa, el bot deja de responder. La carpeta `auth/` guarda la sesión para no escanear QR cada vez; no la subas a internet.

---

### Paso 7 — Comandos de administrador por WhatsApp

Desde un número admin (o desde la misma cuenta del bot), puedes escribir:

| Comando | Qué hace |
|---|---|
| `/detenerbot` | Silencia el bot en ese chat (útil si un humano toma el control) |
| `/iniciarbot` | Vuelve a activar el bot en ese chat |
| `/reiniciarbot` | Reinicia la conversación de ese chat |

Algunos aceptan un número opcional para actuar sobre otro cliente (según cómo esté implementado el comando en `src/index.js`).

---

### Problemas frecuentes al instalar

**“Falta GEMINI_API_KEY / NVIDIA_API_KEY”**  
→ No creaste el `.env`, o está vacío, o elegiste un proveedor y pegaste la clave del otro.

**El QR no aparece / no conecta**  
→ Revisa tu internet. Cierra otras sesiones raras. Vuelve a correr `npm start`. Si la carpeta `auth/` quedó a medias, a veces hay que borrarla y vincular de nuevo (solo si sabes que quieres re-escanear).

**`npm install` falla**  
→ Lee el error completo. En Windows, `better-sqlite3` suele pedir herramientas de compilación. Asegúrate de tener Node ≥ 18.18.

**El bot no responde**  
→ ¿Está corriendo `npm start`? ¿El chat está muteado? ¿Es un grupo? (por defecto suele ignorar grupos). ¿El mensaje es solo texto? (este bot trabaja principalmente con texto).

**Quiero verificar que el código no tenga errores de sintaxis**

```bash
npm run check
```

---

## La tecnología (explicada sin misterio)

Aquí no asumimos que sepas programar. Vamos de lo general a lo particular.

### En una frase

Es un programa en **JavaScript (Node.js)** que:

1. Se conecta a WhatsApp.
2. Guarda el “dónde iba” cada conversación.
3. Sigue un guion de preguntas (máquina de estados).
4. Cuando hace falta, pide ayuda a una Inteligencia Artificial.
5. Calcula cotizaciones con precios guardados en un archivo de datos.

### Las piezas principales (como un equipo de trabajo)

| Pieza | Nombre técnico | Rol en lenguaje simple |
|---|---|---|
| Motor del programa | **Node.js** | Ejecuta el código en el computador |
| Conexión a WhatsApp | **Baileys** | Habla con WhatsApp sin ser la app oficial; maneja QR, mensajes, reconexión |
| Memoria de chats | **SQLite** (`better-sqlite3`) | Guarda en un archivo local en qué paso está cada cliente |
| Cerebro flexible | **Gemini o Nvidia (LLM)** | Entiende frases libres, dudas frecuentes y extracción de productos |
| Secretos y ajustes | **dotenv** (archivo `.env`) | Guarda claves y opciones fuera del código |
| Datos del negocio | `db/datos.json` | Precios, comunas, extras, rendimientos |
| Preguntas frecuentes | `db/faq.json` | Respuestas base para dudas típicas |

### ¿Por qué no es “solo ChatGPT”?

Porque un negocio necesita **control**:

- Los precios deben salir de una lista real (`datos.json`), no de la imaginación de la IA.
- La conversación debe avanzar por pasos (fecha → comuna → productos → cotización).
- Si algo falla, un humano debe poder intervenir.

Por eso el diseño es **híbrido**:

- **Reglas del programa** primero (validar, calcular, cambiar de paso).
- **Inteligencia Artificial** cuando el mensaje es libre, ambiguo, o es una pregunta tipo FAQ.

Eso es más estable y más barato que dejar que la IA decida todo sola.

---

## Arquitectura: cómo está organizado el código

Imagina una empresa pequeña con roles claros. Cada carpeta/archivo tiene un trabajo y no se mete en el del otro.

```
index.js  →  engine.js  →  statesMap (flows/)  →  utils.js + order-builder.js
                ↘ llm.js (IA: fallback / NLU / FAQ)
                ↘ db.js (sesiones en SQLite)
                ↘ views/ (textos fijos + prompts)
                ↘ db/datos.json + db/faq.json
```

### Mapa de archivos (qué hace cada uno)

| Archivo / carpeta | Responsabilidad |
|---|---|
| `src/index.js` | Puerta de entrada: QR, conexión WhatsApp, escuchar mensajes, comandos admin, alertas |
| `src/core/engine.js` | Cerebro: decide el estado, aplica seguridad, llama FAQ/IA si hace falta; también el simulador local |
| `src/core/llm.js` | Todas las llamadas a la Inteligencia Artificial |
| `src/core/db.js` | Leer/guardar/reiniciar sesiones en SQLite |
| `src/core/config.js` | Leer el `.env` y armar la configuración del bot |
| `src/flows/router.js` | Primer filtro: ¿barriles, eventos, o ambos? |
| `src/flows/barriles.js` | Todo el recorrido de cotización de barriles |
| `src/flows/eventos.js` | Todo el recorrido de cotización de eventos |
| `src/flows/cerrado.js` | Estado final: conversación cerrada / bot en silencio |
| `src/flows/index.js` | Junta todos los estados en un solo mapa |
| `src/logic/utils.js` | Utilidades: normalizar texto, precios, fechas, comunas, etc. |
| `src/logic/order-builder.js` | Arma la cotización con números reales |
| `src/views/templates.js` | Mensajes fijos bonitos (bienvenida, cotización, etc.) |
| `src/views/prompts.js` | Instrucciones que se le dan a la IA según el paso |
| `db/datos.json` | Catálogo y precios del negocio |
| `db/faq.json` | Preguntas frecuentes |

### La idea central: “máquina de estados”

Una **máquina de estados** es como un formulario conversacional:

- En cada momento, el bot está en un **estado** (un paso).
- El cliente responde.
- El programa **valida** la respuesta.
- Si está bien, avanza al **siguiente estado**.
- Si no, pide de nuevo o usa un plan B (FAQ / IA).

Cada estado suele definir:

- Un identificador (`id`), por ejemplo `BARRILES_RECOGIDA_PRODUCTOS`
- Qué preguntar (`promptQuestion` / `shortQuestion`)
- Contexto para la IA (`aiContextPrompt`)
- Una función `validateAndProcess(...)` que decide:
  - ¿tuvo éxito?
  - ¿a qué estado ir?
  - ¿qué mensaje enviar?
  - ¿hay que silenciar?
  - ¿avisar al admin?

El `engine.js` orquesta todo eso de forma uniforme.

---

## Cómo funciona una conversación (de punta a punta)

### 1) Llega un mensaje de WhatsApp

`index.js` recibe el mensaje, filtra basura (estados de WhatsApp, grupos si no están permitidos, etc.) y se lo pasa al motor:

`processMessage(sessionId, texto)`

### 2) Se recupera la “memoria” del cliente

`db.js` busca la sesión en SQLite. Ahí está, por ejemplo:

- En qué estado iba
- Qué productos ya eligió
- Fecha, comuna, etc.
- Si el bot está silenciado (`isMuted`)

Si es la primera vez, se crea una sesión nueva.

### 3) El motor mira el estado actual

Según el estado, llama a la función de validación de ese paso (en `flows/`).

### 4) Red de seguridad (antes de “improvisar”)

El motor protege la experiencia:

- **Mute:** si un humano intervino, o el cliente pidió ayuda (SOS / “quiero hablar con alguien”), o hubo demasiados errores seguidos, el bot se calla.
- **Cambio de intención:** si el cliente salta muchas veces entre barriles y eventos al inicio, se corta el loop.
- **Fallback:** si la validación falla, intenta:
  1. Responder con FAQ (si la duda encaja),
  2. Si no, pedir ayuda a la IA con el contexto del paso,
  3. Y volver a orientar con la pregunta del paso actual.

### 5) Flujos de negocio

#### Flujo Barriles (resumen)

1. Filtro de canal / bienvenida  
2. Ofrecer catálogo  
3. ¿Cotizar o solo mirar?  
4. Recoger productos (aquí la IA ayuda a entender “2 mojitos y un pisco sour”)  
5. Recoger datos (entrega, comuna, etc.)  
6. Revisar cotización (calculada por `OrderBuilder`)  
7. Router de modificación (cambiar algo / confirmar / cerrar)

#### Flujo Eventos (resumen)

1. Filtro de canal / bienvenida  
2. Datos del evento  
3. Elegir formato (dispensador / muro, etc.)  
4. Elegir menú / carrito (también con ayuda de IA)  
5. Cotización final

Los nombres de estado son semánticos (`BARRILES_*`, `EVENTOS_*`), no números mágicos. El orden real lo define cada `nextState`.

### 6) Se guarda la sesión y se responde

El motor guarda el nuevo estado y arma la respuesta.  
En WhatsApp, a veces se envían **varios mensajes** seguidos (`customReplies`) para que se lea más natural.

### 7) Cierre

Cuando la venta se cierra o se pide silencio, se puede ir al estado `CERRADO` con `mute: true`: el bot deja de intervenir para no molestar mientras un humano cierra el trato.

---

## Datos del negocio: de dónde salen los precios

Todo lo “de verdad” del negocio vive en JSON, no hardcodeado en mil sitios:

- **`db/datos.json`**: precios de cócteles (desechable / dispensador / muro), extras (hielo, bombillas…), comunas de la Región Metropolitana con costo de despacho, regiones, rendimientos por litros, etc.
- **`db/faq.json`**: un conjunto pequeño de preguntas frecuentes. La IA solo responde FAQ si realmente aplica; si no, puede devolver algo tipo “no es FAQ” y el motor sigue otro camino.

**Regla de oro del proyecto:** la IA no inventa precios. Lee (indirectamente) de estos datos a través de la lógica en `utils.js` y `order-builder.js`.

---

## Scripts útiles (comandos npm)

| Comando | Qué hace |
|---|---|
| `npm start` | Enciende el bot real de WhatsApp |
| `npm run test:local` | Simulador en consola (sin WhatsApp) |
| `npm run check` | Revisa sintaxis de los archivos principales |

---

## Convenciones del proyecto (para quien quiera estudiar o contribuir)

El código está pensado como **material de aprendizaje** (comentarios didácticos, secciones claras, funciones documentadas). Algunas reglas prácticas:

1. **Validación programática primero; IA después.**
2. Cambios pequeños y enfocados: no tocar archivos ajenos al problema.
3. Precios siempre desde `datos.json`.
4. En WhatsApp, la negrita usa un solo asterisco: `*texto*` (no `**doble**`).
5. Respuestas al cliente en español chileno, cordial.
6. No subir `.env`, carpeta `auth/`, ni la base `conversation-memory.sqlite`.
7. Capas separadas: WhatsApp ≠ motor ≠ flujos ≠ lógica ≠ vistas ≠ datos.

Si agregas un estado nuevo:

1. Créalo en `barriles.js` o `eventos.js`
2. Agrega su prompt en `views/prompts.js`
3. Regístralo en el mapa de `flows/index.js`

---

## Requisitos resumidos

- Node.js **≥ 18.18**
- Dependencias del `package.json` (se instalan con `npm install`)
- Archivo `.env` con proveedor de IA + API key + `ADMIN_NUMBERS`
- WhatsApp para vincular (solo si usas `npm start`)

---

## Código libre / licencia y autor

Este proyecto es de **código libre**: puedes estudiarlo, usarlo para aprender, adaptarlo a tu negocio y compartirlo respetando el espíritu abierto del código.

Hecho por **Felipe Ramírez**  
Correo: [feliperamirez1983@gmail.com](mailto:feliperamirez1983@gmail.com)

Si te sirvió — aunque sea un poco — **escríbeme para contármelo**. Me alegra saber que el bot (o el README) te ayudó, y también recibo con gusto dudas, ideas o mejoras.
