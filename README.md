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
| **Node.js** versión 20 o superior | Es el “motor” que ejecuta el programa (escrito en JavaScript) | Sí |
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

Deberías ver algo como `v20.0.0` o un número mayor (por ejemplo `v20...` o `v22...`).  
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

Los comandos se escriben desde **Mensaje para ti mismo** (chat contigo) o desde un número en `ADMIN_NUMBERS`, **nunca en la ventana del cliente**. El número del cliente es **obligatorio**:

| Comando | Ejemplo | Qué hace |
|---|---|---|
| `/detenerbot` | `/detenerbot 56912345678` | Silencia el bot para ese cliente |
| `/iniciarbot` | `/iniciarbot 56912345678` | Reactiva el bot para ese cliente |
| `/reiniciarbot` | `/reiniciarbot 56912345678` | Borra la sesión y empieza de cero |

Si escribes el comando sin número, el bot te responde con el formato correcto. Si lo escribes en el chat del cliente, se ignora (así evitamos borrar mensajes ahí y confusiones con el mute automático).

**Mute automático:** si un humano escribe texto o manda multimedia en el chat de un cliente, el bot se silencia solo en ese chat. No cuenta como “intervención humana” activar/desactivar mensajes temporales ni borrar un mensaje (son eventos de sistema de WhatsApp).

**Mensajes temporales:** si el cliente los tiene activos, el bot igual puede leer el texto (los desempaqueta). A veces WhatsApp los desactiva al responder; eso es normal y no debe silenciar el bot.

**Etiquetas WhatsApp Business:** el bot etiqueta el chat del cliente al avisar a los admins. Config en `.env` (`LABEL_*`):

| Uso | Nombre (default) | ID | Marcar no leído |
|---|---|---|---|
| SOS / asistencia | `Asistencia` | `99` | `true` |
| Cierre cotización barriles | `Cotizacion Barriles` | `98` | `false` |
| Cierre cotización eventos | `Cotizacion Eventos` | `97` | `false` |

El bot crea/asegura la etiqueta con ese ID (las del celular a menudo no sincronizan a Baileys) y la aplica al chat (prioriza `@lid`).

> Nota: a veces la etiqueta se ve primero en WhatsApp Web / dispositivo vinculado y tarda o no aparece en el celular principal (limitación conocida de sync de etiquetas en Baileys).

Alias legacy (solo asistencia): si no defines `LABEL_ASISTENCIA_*`, aún funcionan `SOS_LABEL_NAME`, `SOS_LABEL_ID` y `SOS_MARK_UNREAD`.

---

### Problemas frecuentes al instalar

**“Falta GEMINI_API_KEY / NVIDIA_API_KEY”**  
→ No creaste el `.env`, o está vacío, o elegiste un proveedor y pegaste la clave del otro.

**El QR no aparece / no conecta**  
→ Revisa tu internet. Cierra otras sesiones raras. Vuelve a correr `npm start`. Si la carpeta `auth/` quedó a medias, a veces hay que borrarla y vincular de nuevo (solo si sabes que quieres re-escanear).

**`npm install` falla**  
→ Lee el error completo. En Windows, `better-sqlite3` suele pedir herramientas de compilación. Asegúrate de tener Node ≥ 20.

**El bot no responde**  
→ ¿Está corriendo `npm start`? ¿El chat está muteado? (prueba `/iniciarbot 569...` o `/reiniciarbot 569...` desde tu chat). ¿Es un grupo? (por defecto suele ignorar grupos). ¿El cliente tiene mensajes temporales? (ya deberían funcionar; si un chat viejo quedó muteado por error, reactívalo con el comando).

**Quiero verificar que el código no tenga errores de sintaxis**

```bash
npm run check
```

---

## Instalar en un servidor Linux (VPS / nube)

Esta guía es para dejar el bot **siempre encendido** en un servidor, no en tu PC de casa. Sirve para Ubuntu (y similares) en la nube, por ejemplo una máquina gratuita o barata de Oracle Cloud como **VM.Standard.E2.1.Micro**.

> **Idea simple:** el servidor es un computador remoto que está 24/7. Tú te conectas por SSH (una terminal a distancia), instalas lo mismo que en tu PC, vinculas WhatsApp una vez, y dejas el bot corriendo con **PM2** para que no se apague al cerrar la ventana.

### Qué vas a necesitar

| Qué | Para qué |
|---|---|
| Una VM Linux (Ubuntu 22.04 LTS recomendado) | Donde vivirá el bot |
| Acceso SSH (IP pública + usuario, a menudo `ubuntu` o `opc`) | Entrar al servidor desde tu PC |
| Tu repositorio en GitHub | Para clonar el código |
| Claves de IA y número admin | Igual que en la instalación local (archivo `.env`) |
| El celular con WhatsApp | Para escanear el QR la primera vez |

No hace falta instalar Baileys ni SQLite “a mano”: `npm install` ya trae esas piezas dentro del proyecto.

---

### Paso A — Conectarte al servidor

Desde tu computador (PowerShell, Terminal, etc.):

```bash
ssh ubuntu@TU_IP_PUBLICA
```

En Oracle a veces el usuario es `opc` en vez de `ubuntu`. Usa el que te dio la consola de la nube.

Si te pide confirmar la huella del servidor (`Are you sure you want to continue connecting?`), escribe `yes` la primera vez.

Cuando veas un prompt tipo `ubuntu@nombre-vm:~$`, ya estás dentro.

---

### Paso B — Comprobar lo esencial (e instalar lo que falte)

Ejecuta estas comprobaciones **una por una**. Si un comando dice “not found” o “command not found”, instálalo con el bloque de abajo.

#### 1) Actualizar la lista de paquetes del sistema

```bash
sudo apt update
sudo apt upgrade -y
```

#### 2) ¿Hay Git?

```bash
git --version
```

Si no está:

```bash
sudo apt install -y git
```

#### 3) ¿Hay herramientas para compilar? (las necesita `better-sqlite3`)

```bash
gcc --version
python3 --version
make --version
```

Si falta alguna:

```bash
sudo apt install -y build-essential python3
```

#### 4) ¿Hay Node.js 20 o superior?

```bash
node -v
npm -v
```

Si no está, o la versión es menor a `v20.0.0`, instala Node 20 LTS con NodeSource (método habitual en Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Debes ver algo como `v20.x.x` y un número de `npm`.

#### 5) ¿Hay PM2? (para dejar el bot corriendo en segundo plano)

```bash
pm2 -v
```

Si no está:

```bash
sudo npm install -g pm2
pm2 -v
```

Con esto ya tienes lo esencial: Git, compiladores, Node/npm y PM2.

---

### Paso C — Clonar el repositorio

Elige una carpeta (por ejemplo tu home) y clona:

```bash
cd ~
git clone https://github.com/TU_USUARIO/whatsapp-cot.git
cd whatsapp-cot
```

Cambia la URL por la de **tu** repositorio en GitHub.

Si el repo es privado, GitHub te pedirá autenticación (token personal o SSH). En repos públicos basta con la URL HTTPS.

Comprueba que estás en la carpeta correcta:

```bash
ls
```

Deberías ver cosas como `package.json`, `src`, `db`, `.env.example`.

---

### Paso D — Instalar dependencias del proyecto

Dentro de `whatsapp-cot`:

```bash
npm install
```

Esto descarga Baileys, SQLite embebido, clientes de IA, etc. en `node_modules/`.  
Si falla por compilación, vuelve al Paso B (instalar `build-essential` y `python3`) y reintenta `npm install`.

Opcional: verificar sintaxis:

```bash
npm run check
```

---

### Paso E — Configurar el archivo `.env`

El `.env` **no** viene en el clone (es secreto). Créalo en el servidor:

```bash
cp .env.example .env
nano .env
```

Completa al menos:

- `LLM_PROVIDER` (`gemini` o `nvidia`)
- la API key del proveedor elegido (`GEMINI_API_KEY` o `NVIDIA_API_KEY`)
- `ADMIN_NUMBERS` (WhatsApp sin `+`, ej. `56912345678`)

Guarda en nano: `Ctrl+O`, Enter, luego `Ctrl+X` para salir.

> Nunca subas `.env` a GitHub. En el servidor también conviene no pegarlo en capturas ni chats públicos.

---

### Paso F — Primera conexión a WhatsApp (escanear el QR)

La carpeta `auth/` guarda la sesión (como WhatsApp Web). La **primera vez** debes ver el QR en la terminal.

**Todavía no uses PM2.** Arranca a mano:

```bash
npm start
```

1. Aparece un código QR en la consola.
2. En el celular: WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo**.
3. Escanea el QR (mejor desde un PC con terminal ancha; por SSH en pantalla chica el QR a veces se deforma).
4. Cuando diga `WhatsApp conectado. El bot está listo para trabajar.`, ya quedó vinculado.
5. Detén el proceso con `Ctrl+C`.

Si el QR expira o falla, vuelve a correr `npm start`. No borres `auth/` salvo que quieras forzar un vínculo nuevo.

---

### Paso G — Dejar el bot corriendo con PM2

Desde la carpeta del proyecto (`~/whatsapp-cot` o donde lo hayas clonado):

```bash
pm2 start src/index.js --name whatsapp-cot
```

Comprueba:

```bash
pm2 status
pm2 logs whatsapp-cot
```

Debe aparecer `online`. Si ya existe `auth/`, no debería pedir QR otra vez.

#### Que sobreviva un reinicio del servidor

```bash
pm2 save
pm2 startup
```

PM2 imprimirá un comando que empieza con `sudo env PATH=...`. **Cópialo, pégalo y ejecútalo.** Luego:

```bash
pm2 save
```

Así, si la VM de Oracle se reinicia, el bot vuelve solo.

#### Comandos útiles de PM2

| Comando | Qué hace |
|---|---|
| `pm2 status` | Ver si está online |
| `pm2 logs whatsapp-cot` | Ver mensajes en vivo |
| `pm2 restart whatsapp-cot` | Reiniciar el bot |
| `pm2 stop whatsapp-cot` | Detenerlo |
| `pm2 delete whatsapp-cot` | Quitar el proceso de la lista de PM2 |

---

### Paso H — Probar que responde

1. Escribe al número de WhatsApp **vinculado** desde **otro celular** (un número de prueba).
2. **No respondas tú** en ese chat mientras pruebas: si un humano escribe texto o manda multimedia ahí, el bot se silencia solo en ese chat (protección de “intervención humana”).
3. Si quedó silenciado, desde **tu chat** (cuenta del bot o un admin), **no** desde la ventana del cliente:

```text
/iniciarbot 56912345678
```

Para empezar de cero:

```text
/reiniciarbot 56912345678
```

(Usa el número real del cliente de prueba, sin `+`.)

---

### Actualizar el bot en el servidor (cuando cambies el código)

```bash
cd ~/whatsapp-cot
git pull
npm install
pm2 restart whatsapp-cot
```

Si cambió mucho la lógica de sesión o perdiste `auth/`, puede hacer falta volver a escanear el QR (`npm start` una vez, luego otra vez PM2).

---

### Notas importantes en servidores (Oracle Micro y similares)

- **Un solo proceso** con el mismo número de WhatsApp. No corras `npm start` y PM2 a la vez, ni dos instancias PM2: WhatsApp se desconecta.
- **`auth/` y `*.sqlite*`** son locales del servidor. No los subas a Git. Haz respaldo si te importa no re-vincular.
- **RAM limitada** (la E2.1.Micro tiene poca memoria): cierra cosas innecesarias; este bot es liviano, pero evita muchos procesos extra.
- **Firewall de Oracle:** este bot no abre un puerto web para clientes; habla hacia afuera con WhatsApp e IA. En la mayoría de casos no necesitas abrir puertos de entrada solo por el bot. Si no puedes salir a internet, revisa reglas de egress / security lists en la consola de Oracle.
- Trabaja siempre **dentro** de la carpeta del repo al usar PM2, para que encuentre `.env`, `auth/` y `db/`.

---

### Checklist rápido (servidor Linux)

- [ ] SSH al servidor OK  
- [ ] `git`, `build-essential`, `python3`, Node ≥ 20, `pm2` instalados  
- [ ] Repo clonado y `npm install` OK  
- [ ] `.env` creado y con claves + `ADMIN_NUMBERS`  
- [ ] `npm start` → QR escaneado → `Ctrl+C`  
- [ ] `pm2 start src/index.js --name whatsapp-cot`  
- [ ] `pm2 save` + `pm2 startup` (y el comando `sudo` que muestra)  
- [ ] Prueba desde otro número de WhatsApp  

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
| `src/flows/router/states/` | Primer filtro: ¿barriles, eventos, o ambos? (`ESPERANDO_INTENCION`) |
| `src/flows/barriles/states/` | Un archivo por paso del flujo Barriles (`BARRILES_*`) |
| `src/flows/eventos/states/` | Un archivo por paso del flujo Eventos (`EVENTOS_*`) |
| `src/flows/cerrado.js` | Estado final: conversación cerrada / bot en silencio |
| `src/flows/index.js` | Junta todos los estados en un solo mapa (`statesMap`) |
| `src/logic/compile-state.js` | Arma el objeto de estado que consume el engine |
| `src/logic/utils.js` | Utilidades: normalizar texto, precios, fechas, comunas, etc. |
| `src/logic/media.js` | Imágenes para WhatsApp: `img('archivo.ext')` desde la carpeta `assets/` |
| `src/logic/order-builder.js` | Arma la cotización con números reales |
| `src/views/templates.js` | Textos compartidos (cotización, alertas admin, pitches eventos) |
| `src/views/prompts.js` | Reglas globales de la IA (`readPrompt`); prompts por paso van en cada estado |
| `db/datos.json` | Catálogo y precios del negocio |
| `db/faq.json` | Preguntas frecuentes |
| `assets/` | Fotos que el bot puede enviar (ej. lista de precios de barriles) |
| `scripts/verify-flows.mjs` | Tests automáticos de integridad + smoke (`npm run verify`) |

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

- **Mute:** si un humano intervino con texto/multimedia en el chat del cliente, o el cliente pidió ayuda (SOS / “quiero hablar con alguien”), o hubo demasiados errores seguidos, el bot se calla. Cambios de mensajes temporales o borrados **no** cuentan como intervención.
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

1. Créalo en `src/flows/barriles/states/` o `src/flows/eventos/states/` (un archivo por paso, con textos + `aiPrompt` + lógica)
2. Expórtalo en el `index.js` del flujo (`barriles/index.js` o `eventos/index.js`)
3. Queda registrado vía `flows/index.js` → `statesMap`
4. Corre `npm run verify` para chequear sintaxis + smoke tests

### Enviar una imagen en un paso

1. Pon el archivo en la carpeta `assets/` (nombre completo con extensión, ej. `barril_desechable_precios.webp`).
2. En el flujo, dentro de `customReplies` o `customReply`:

```js
import { img } from '../logic/media.js';

customReplies: [
  img('barril_desechable_precios.webp'),           // solo imagen
  // img('foto.webp', 'Texto opcional bajo la foto'),
  '¿Te armo una cotización?'
]
```

Si el archivo no está en `assets/`, el bot **se silencia** (sin mensaje al cliente) y manda un **SOS** al admin con la ruta esperada. En `npm run test:local` verás `[IMAGEN] nombre.ext` o el aviso `[TEST]` de mute/SOS.

---

## Requisitos resumidos

- Node.js **≥ 20**
- Dependencias del `package.json` (se instalan con `npm install`)
- Archivo `.env` con proveedor de IA + API key + `ADMIN_NUMBERS`
- WhatsApp para vincular (solo si usas `npm start`)

---

## Código libre / licencia y autor

Este proyecto es de **código libre**: puedes estudiarlo, usarlo para aprender, adaptarlo a tu negocio y compartirlo respetando el espíritu abierto del código.

Hecho por **Felipe Ramírez**  
Correo: [feliperamirez1983@gmail.com](mailto:feliperamirez1983@gmail.com)

Si te sirvió — aunque sea un poco — **escríbeme para contármelo**. Me alegra saber que el bot (o el README) te ayudó, y también recibo con gusto dudas, ideas o mejoras.
