// ==============================================================================
// OBJETIVO: Caja de Herramientas y Seguridad (Helpers).
// ==============================================================================
import fs from 'node:fs';
import { DATOS_JSON_PATH } from '../core/paths.js';
import { testLog } from '../core/debug-log.js';

// ==============================================================================
// BASE DE DATOS GENERAL (datos.json)
// ==============================================================================
// Ruta fija a la raíz del repo (no depende de process.cwd() / PM2).
const preciosPath = DATOS_JSON_PATH;
export let preciosData = {};

try {
	if (fs.existsSync(preciosPath)) {
		preciosData = JSON.parse(fs.readFileSync(preciosPath, 'utf8'));
	} else {
		console.error(`No existe datos.json en: ${preciosPath}`);
	}
} catch (err) {
	console.error('Error cargando datos.json en utils.js:', err.message);
}

// ==============================================================================
// UTILERIAS DE TEXTO Y FORMATEO
// ==============================================================================
export function normalizeString(str) {
	if (!str) return '';
	return str
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/ñ/g, 'n')
		.replace(/[°º]/g, '')
		.trim();
}

export function formatPrice(val) {
	return `$${val.toLocaleString('es-CL')}`;
}

/**
 * formatPriceTable: Convierte un objeto { "5L": 47990, "10L": 119990 } en texto corto.
 * Ej: "5L $47.990 / 10L $119.990"
 *
 * @param {Record<string, number>|null|undefined} priceTable - Litraje → precio
 * @returns {string} Texto legible o "(sin precio)" si viene vacío
 */
function formatPriceTable(priceTable) {
	if (!priceTable || Object.keys(priceTable).length === 0) return '(sin precio)';
	return Object.entries(priceTable)
		.map(([litraje, price]) => `${litraje} ${formatPrice(price)}`)
		.join(' / ');
}

/**
 * sanitizeCustomerFacingReply: Quita jerga interna que a veces filtra el LLM
 * (nombres de archivos, "DATOS OFICIALES", "FAQ", etc.) antes de mandar el texto al cliente.
 * No cambia el sentido de la respuesta; solo limpia meta-referencias del prompt.
 *
 * @param {string|null|undefined} text - Respuesta cruda de FAQ o IA
 * @returns {string} Texto listo para WhatsApp (o string vacío si no había texto)
 */
export function sanitizeCustomerFacingReply(text) {
	if (text == null) return '';
	let out = String(text);

	// Frases típicas de leak → versión natural para el cliente
	const replacements = [
		// "consultar nuestra tabla... en la sección DATOS OFICIALES"
		[/consultar\s+(nuestra\s+)?tabla\s+de\s+despachos\s+en\s+la\s+secci[oó]n\s+["']?DATOS\s+OFICIALES["']?/gi,
			'decirme tu comuna para indicarte el costo de envío'],
		[/te\s+recomiendo\s+decirme\s+tu\s+comuna/gi, 'puedes decirme tu comuna'],
		[/en\s+la\s+secci[oó]n\s+["']?DATOS\s+OFICIALES["']?/gi, ''],
		[/nuestra\s+tabla\s+de\s+despachos\s+(en\s+)?(DATOS\s+OFICIALES|datos\s+oficiales)/gi,
			'los costos de envío por comuna'],
		[/consultar\s+nuestra\s+FAQ\s+sobre\s+env[ií]os\s+a\s+regiones/gi,
			'coordinar el envío a regiones por encomienda (el costo se confirma al comprar)'],
		[/nuestra\s+FAQ\s+sobre\s+env[ií]os\s+a\s+regiones/gi,
			'el envío a regiones por encomienda (el costo se confirma al comprar)'],
		[/te\s+recomiendo\s+coordinar\s+el\s+env[ií]o/gi, 'podemos coordinar el envío'],
		[/te\s+recomiendo\s+consultar\s+(nuestra\s+)?FAQ[^.!?]*/gi,
			'puedo ayudarte a coordinar el detalle'],
		[/\bDATOS\s+OFICIALES\b/gi, 'información del negocio'],
		[/\bdatos\.json\b/gi, 'nuestro catálogo'],
		[/\bfaq\.json\b/gi, 'nuestras respuestas frecuentes'],
		[/\bla\s+base\s+FAQ\b/gi, 'nuestra información'],
		[/\bnuestra\s+FAQ\b/gi, 'nuestra información'],
		[/\bla\s+FAQ\b/gi, 'nuestra información'],
		[/\bel\s+FAQ\b/gi, 'nuestra información'],
		[/\b(system\s+prompt|prompt\s+del\s+sistema)\b/gi, ''],
	];

	for (const [pattern, replacement] of replacements) {
		out = out.replace(pattern, replacement);
	}

	// Espacios y puntuación que quedan raros tras borrar frases
	out = out
		.replace(/\s{2,}/g, ' ')
		.replace(/\s+([.,;:!?])/g, '$1')
		.replace(/([.!?])\s*\1+/g, '$1')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return out;
}

/**
 * buildFaqCatalogContext: Arma un resumen compacto de datos.json para el FAQ con IA.
 * Incluye catálogo (barriles / dispensador / muro), extras, rendimientos e instalación,
 * y la tabla de despachos de la Región Metropolitana.
 * Así la IA puede responder precios y despachos sin inventar números.
 *
 * @param {object} [data=preciosData] - Contenido de datos.json (por defecto el ya cargado)
 * @returns {string} Texto listo para pegar en el system prompt del FAQ
 */
export function buildFaqCatalogContext(data = preciosData) {
	if (!data || typeof data !== 'object') {
		return '(Sin datos de catálogo disponibles)';
	}

	const lines = [];

	// --- Cabecera: reglas de lectura para la IA ---
	lines.push('DATOS OFICIALES (datos.json) — ÚNICA fuente de precios y despachos RM:');
	lines.push('');
	lines.push('IMPORTANTE — Todo es BARRIL, pero hay 3 categorías de servicio (precios distintos):');
	lines.push('1) "desechable" = Barril desechable 5L (venta para llevar / web, sin servicio de bar).');
	lines.push('2) "dispensador" = Barril para servicio de eventos con Dispensador Portátil.');
	lines.push('3) "muro" = Barril para servicio de eventos con Muro de Coctelería.');
	lines.push('Nunca digas solo "el precio del Pisco Sour": siempre aclara o pregunta la categoría.');
	lines.push('');
	lines.push('- Despacho RM: "desechable" = envío barriles desechables; "evento" = envío dispensador/muro.');
	lines.push('- Fuera de RM: NO inventar tarifa; di que va por encomienda y el costo se confirma al comprar.');
	lines.push('- Si el dato no está aquí ni en las respuestas frecuentes → NO_FAQ (no adivinar).');
	lines.push('- NUNCA digas al cliente "DATOS OFICIALES", "FAQ", "datos.json" ni "sección": habla solo como vendedor.');
	lines.push('');

	// --- Rendimientos e instalación muro ---
	// Misma tabla para todos; al responder al cliente filtrar según contexto (desechable solo 5L, etc.)
	const rendimientos = data.rendimientos_barriles || {};
	if (Object.keys(rendimientos).length > 0) {
		lines.push('Rendimiento aprox. (vaso/copa con hielo ≈ 200ml). Filtrar al cliente según contexto:');
		lines.push('- Barriles desechables: solo 5L.');
		lines.push('- Eventos Dispensador: 5L y 10L.');
		lines.push('- Eventos Muro: 10L, 20L y 30L.');
		for (const [litraje, tragos] of Object.entries(rendimientos)) {
			lines.push(`- ${litraje} → ~${tragos} cócteles`);
		}
		lines.push('');
	}

	const instalacionMuro = data.instalacion_muro;
	if (instalacionMuro != null) {
		lines.push(`Instalación Muro de Coctelería: ${formatPrice(instalacionMuro)} (Dispensador: instalación gratuita).`);
		lines.push('');
	}

	// --- Catálogo: mismas claves de datos.json, etiquetadas como categorías de barril ---
	const cocteles = data.cocteles || {};
	const nombres = Object.keys(cocteles);
	if (nombres.length > 0) {
		lines.push('CATÁLOGO (claves JSON → categoría de barril):');
		lines.push('  desechable = Barril desechable | dispensador = Barril eventos Dispensador | muro = Barril eventos Muro');
		for (const nombre of nombres) {
			const c = cocteles[nombre];
			const categoria = c.categoria || 'SIN CATEGORÍA';
			const desechable = formatPriceTable(c.desechable);
			const dispensador = formatPriceTable(c.dispensador);
			const muro = formatPriceTable(c.muro);
			// Ingredientes oficiales de datos.json (la IA no debe inventar otros)
			const ingredientes = (c.ingredientes || '').trim() || '(sin ficha de ingredientes)';
			lines.push(`- ${nombre} [${categoria}]`);
			lines.push(`    Ingredientes: ${ingredientes}`);
			lines.push(`    Barril desechable (desechable): ${desechable}`);
			lines.push(`    Barril eventos Dispensador Portátil (dispensador): ${dispensador}`);
			lines.push(`    Barril eventos Muro de Coctelería (muro): ${muro}`);
		}
		lines.push('');
	}

	// --- Extras (hielo, bombillas, etc.) ---
	const extras = data.extras || {};
	if (Object.keys(extras).length > 0) {
		lines.push('EXTRAS:');
		for (const [nombre, precio] of Object.entries(extras)) {
			lines.push(`- ${nombre}: ${formatPrice(precio)}`);
		}
		lines.push('');
	}

	// --- Despachos Región Metropolitana ---
	const comunas = data.comunas_rm || {};
	if (Object.keys(comunas).length > 0) {
		lines.push('DESPACHOS RM (comuna → envío barril desechable | envío servicio eventos):');
		lines.push('  "desechable" = envío de barriles desechables | "evento" = envío Dispensador/Muro (0 = sin costo)');
		for (const [comuna, tarifas] of Object.entries(comunas)) {
			const desechable = formatPrice(tarifas.desechable ?? 0);
			const evento = formatPrice(tarifas.evento ?? 0);
			lines.push(
				`- ${comuna}: barril desechable ${desechable} | eventos (Dispensador/Muro) ${evento}`
			);
		}
	}

	return lines.join('\n');
}

/**
 * getCoctelesByCategoria: Agrupa el catálogo de datos.json por categoría de negocio.
 *
 * @returns {{ 'CLÁSICOS': object[], COMBINADOS: object[], MOCKTAILS: object[] }}
 */
export function getCoctelesByCategoria() {
	const cats = {
		'CLÁSICOS': [],
		COMBINADOS: [],
		MOCKTAILS: []
	};
	if (!preciosData.cocteles) return cats;

	for (const [name, data] of Object.entries(preciosData.cocteles)) {
		if (data.categoria === 'CLÁSICOS') cats['CLÁSICOS'].push({ name, ...data });
		else if (data.categoria === 'COMBINADOS') cats.COMBINADOS.push({ name, ...data });
		else if (data.categoria === 'MOCKTAILS') cats.MOCKTAILS.push({ name, ...data });
	}
	return cats;
}

/**
 * getProductFamilyBase: Detecta la "familia" de un cóctel para agrupar sabores.
 * Ej: "Mojito Maracuyá" → "Mojito"; "Piscola Alto 35°" → "Piscola".
 * Si no hay familia clara, retorna null (se lista como producto suelto).
 *
 * @param {string} name - Nombre oficial del catálogo
 * @returns {string|null}
 */
function getProductFamilyBase(name) {
	if (!name) return null;
	// Familias conocidas con variantes de sabor/marca en el catálogo
	const knownFamilies = ['Mojito', 'Piscola', 'Sangría'];
	for (const family of knownFamilies) {
		const re = new RegExp(`^${family}\\b`, 'i');
		if (re.test(name)) return family;
	}
	return null;
}

/**
 * formatVariantLabel: Quita el prefijo de familia y "Mocktail" para mostrar solo el sabor.
 * Ej: "Mojito Maracuyá" → "Maracuyá"; "Mojito Mocktail" → "Clásico";
 *     "Mojito Maracuyá Mocktail" → "Maracuyá"
 *
 * @param {string} name - Nombre completo
 * @param {string} familyBase - Prefijo de familia
 * @returns {string}
 */
function formatVariantLabel(name, familyBase) {
	let rest = name.slice(familyBase.length).trim();
	const isMocktail = /\bmocktail\b/i.test(rest) || /\bmocktail\b/i.test(name);
	rest = rest.replace(/\bmocktail\b/gi, '').trim();
	if (!rest) return isMocktail ? 'Clásico' : 'Clásico';
	return rest;
}

/**
 * formatGroupedNames: Arma el texto de una línea agrupada.
 * - Misma familia + variantes → "Mojito (Maracuyá, Frambuesa, Mango)"
 * - Mezcla de familias y sueltos → "Mojito (Maracuyá, Mango) / Caipiriña"
 * - Productos distintos mismo precio → "Caipiriña / Sangría / Mojito"
 *
 * @param {string[]} names - Nombres oficiales del grupo
 * @returns {string}
 */
function formatGroupedNames(names) {
	if (names.length === 1) return names[0];

	/** @type {Map<string, string[]>} familia → nombres completos */
	const byFamily = new Map();
	/** @type {string[]} */ const singles = [];

	for (const name of names) {
		const base = getProductFamilyBase(name);
		if (base) {
			if (!byFamily.has(base)) byFamily.set(base, []);
			byFamily.get(base).push(name);
		} else {
			singles.push(name);
		}
	}

	const parts = [];

	// Familias con 2+ variantes primero (ej. Mojito sabores), luego ítems sueltos
	const familyParts = [];
	const singleParts = [];

	for (const [base, familyNames] of byFamily.entries()) {
		if (familyNames.length === 1) {
			singleParts.push(familyNames[0]);
		} else {
			const variants = familyNames.map((n) => formatVariantLabel(n, base));
			familyParts.push(`${base} (${variants.join(', ')})`);
		}
	}

	singleParts.push(...singles);
	singleParts.sort((a, b) => a.localeCompare(b, 'es'));
	familyParts.sort((a, b) => a.localeCompare(b, 'es'));

	parts.push(...familyParts, ...singleParts);
	return parts.join(' / ');
}

/**
 * buildGroupedCatalogLines: Agrupa ítems de una categoría por precio (o tabla de precios)
 * para acortar la carta en WhatsApp sin inventar datos.
 *
 * @param {object[]} items - Cócteles de una categoría
 * @param {function(object): string|null} priceKeyFn - Clave de agrupación (precio o JSON de litrajes)
 * @param {function(object): string} priceLabelFn - Texto de precio a mostrar
 * @returns {string[]} Líneas "- Nombre(s): $precio"
 */
function buildGroupedCatalogLines(items, priceKeyFn, priceLabelFn) {
	/** @type {Map<string, { names: string[], label: string, sortPrice: number }>} */
	const groups = new Map();

	for (const item of items) {
		const key = priceKeyFn(item);
		if (key == null) continue;

		if (!groups.has(key)) {
			groups.set(key, {
				names: [],
				label: priceLabelFn(item),
				sortPrice: Number(String(key).split('|')[0]) || 0
			});
		}
		groups.get(key).names.push(item.name);
	}

	// Ordenamos de más barato a más caro para que la carta se lea natural
	return Array.from(groups.values())
		.sort((a, b) => a.sortPrice - b.sortPrice)
		.map((g) => `- ${formatGroupedNames(g.names)}: ${g.label}`);
}

/**
 * getCartaCocteles: Arma la carta de precios para WhatsApp.
 * Agrupa productos con el mismo precio (y variantes de familia como Mojito)
 * para que el listado no sea tan largo. Los precios salen siempre de datos.json.
 *
 * @param {string} format - 'desechable' | 'dispensador' | 'muro'
 * @param {object} [options]
 * @param {boolean} [options.includeClosingQuestion=true] - Si false, solo la lista (sin pregunta final)
 * @returns {string} Texto formateado para el chat
 */
export function getCartaCocteles(format = 'desechable', options = {}) {
	const { includeClosingQuestion = true } = options;
	const cats = getCoctelesByCategoria();

	const buildSection = (items) => {
		if (format === 'desechable') {
			return buildGroupedCatalogLines(
				items,
				(c) => {
					const price = c.desechable?.['5L'];
					return price != null ? String(price) : null;
				},
				(c) => formatPrice(c.desechable?.['5L'] || 0)
			).join('\n');
		}

		// Eventos: agrupamos si la tabla de litrajes es idéntica
		return buildGroupedCatalogLines(
			items,
			(c) => {
				const formatPrices = c[format];
				if (!formatPrices || Object.keys(formatPrices).length === 0) return null;
				// Clave = primer precio + JSON de la tabla (para ordenar y comparar)
				const firstPrice = Object.values(formatPrices)[0] || 0;
				return `${firstPrice}|${JSON.stringify(formatPrices)}`;
			},
			(c) => {
				const formatPrices = c[format] || {};
				return Object.entries(formatPrices)
					.map(([litraje, price]) => `${litraje} (${formatPrice(price)})`)
					.join(' / ');
			}
		).join('\n');
	};

	const clasicosStr = buildSection(cats['CLÁSICOS']);
	const combinadosStr = buildSection(cats.COMBINADOS);
	const mocktailsStr = buildSection(cats.MOCKTAILS);

	let text = `🍸 *CLÁSICOS*\n${clasicosStr}`;
	text += `\n\n🥃 *COMBINADOS*\n${combinadosStr}`;
	text += `\n\n🍹 *MOCKTAILS (Sin Alcohol)*\n${mocktailsStr}`;

	// Rendimientos oficiales (datos.json): vaso/copa con hielo ≈ 200ml
	// Dispensador: 5L/10L | Muro: 10L/20L/30L | Desechable: solo 5L
	if (format !== 'desechable') {
		const rend = preciosData.rendimientos_barriles || {};
		const litrajesOrden = format === 'muro' ? ['10L', '20L', '30L'] : ['5L', '10L'];
		const partes = litrajesOrden
			.filter((l) => rend[l] != null)
			.map((l) => `${l} = ${rend[l]} tragos`);
		if (partes.length > 0) {
			text += `\n\n*Rendimientos Aprox.*: ${partes.join(' | ')}\n_(Calculando vaso/copa con hielo ≈ 200ml)_`;
		}
	}

	// En eventos, si includeClosingQuestion=true, pedimos cócteles + litraje al final.
	if (includeClosingQuestion && format !== 'desechable') {
		text += '\n\n¿Ahora indícame cuáles te gustarían, por ej. 5L Mojito, 10L Aperol Spritz?';
	}
	return text;
}

let dynamicDrinkKeywords = null;

export function hasDrinkSelection(text) {
	if (!dynamicDrinkKeywords) {
		const customKeywords = ['caipirinha', 'barril', 'barriles', 'litro', 'litros', 'litraje', 'envase', 'unidades'];
		const dbWords = new Set(customKeywords);

		const ignoredWords = ['clasico', 'clasicos', 'combinado', 'combinados', 'mocktail', 'mocktails', 'sin', 'alcohol'];

		if (preciosData && preciosData.cocteles) {
			for (const name of Object.keys(preciosData.cocteles)) {
				const words = name
					.toLowerCase()
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.replace(/[^a-z0-9\s]/g, ' ')
					.split(/\s+/)
					.filter((w) => w.length > 2 && !ignoredWords.includes(w));
				words.forEach((w) => dbWords.add(w));
			}
		}

		if (dbWords.size === customKeywords.length) {
			dynamicDrinkKeywords = /sangria|caipiriña|caipirinha|gin|ramazzotti|aperol|mule|margarita|tradicional|mango|frutilla|maracuya|maracuyá|alto|mistral|black|barril|barriles|litro|litros|litraje|envase|unidades|\b\d+\s*l\b/i;
		} else {
			const pattern = `${Array.from(dbWords).join('|')}|\\b\\d+\\s*l\\b`;
			dynamicDrinkKeywords = new RegExp(pattern, 'i');
		}
	}

	const normalizedText = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	const hasNumbers = /\b[1-9]\d*\b/.test(text);

	return dynamicDrinkKeywords.test(normalizedText) || hasNumbers;
}

// ==============================================================================
// INTENCIÓN: SOLO MIRANDO
// (usado en filtro de canal de barriles y despedidas similares)
// ==============================================================================

/**
 * isOnlyBrowsing: true si el cliente dice que solo mira / no quiere cotizar ahora.
 * Cubre: "mirando", "no gracias", "lo tendré presente", "para agosto", "no lo tomaré".
 * Sirve para cerrar con despedida suave (mute + CERRADO) en lugar de insistir.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function isOnlyBrowsing(messageText) {
	const trimmed = String(messageText || '').trim();
	if (!trimmed) return false;
	const lower = trimmed.toLowerCase();

	// Respuestas cortas de rechazo ("no", "nop", "nah") — en filtro barriles
	// la regla SOLO_MIRANDO excluye "no" solo (ahí "no" = no a la web → CHAT).
	if (/^(no|nop|nope|nah)$/i.test(trimmed)) return true;

	// Mensaje casi solo "mirando" / "consultando" (con o sin "gracias" / "solo" / "estoy")
	if (/^(gracias[,!.]?\s+)?(solo\s+)?(estoy\s+|estaba\s+|estuve\s+)?(mirando|consultando|viendo|miraba)[.!]?$/i.test(trimmed)) {
		return true;
	}

	// Frases de "solo mirar" en cualquier parte del mensaje
	if (/\b(solo\s+(estoy\s+|estaba\s+|estuve\s+)?(mirando|consultando|viendo|miraba)|estoy\s+mirando|estaba\s+mirando|solo\s+mirando|mirando\s+nom[aá]s|solo\s+consultaba|solo\s+viendo|solo\s+ver)\b/i.test(lower)) {
		return true;
	}

	// Rechazo explícito / "después" / no lo tomará
	if (/\b(no\s+gracias|gracias\s+no|no\s+quiero(\s+cotiz)?|no\s+deseo|no\s+me\s+interesa|no\s+lo\s+tomar[eé]|por\s+ahora\s+no|ahora\s+no|despu[eé]s|luego|en\s+otro\s+momento|nada|cancelar)\b/i.test(lower)) {
		return true;
	}

	// "Lo tendré presente", "lo tengo presente", "para agosto/más adelante"
	if (/\b(lo\s+tendr[eé]\s+presente|lo\s+tengo\s+presente|tendr[eé]\s+presente|m[aá]s\s+adelante|en\s+el\s+futuro)\b/i.test(lower)) {
		return true;
	}
	// Mes futuro sin pedir cotizar ahora (ej. "para agosto", "en diciembre quizás")
	if (/\b(para|en)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(lower)
		&& !/\b(cotiz|quiero|necesito|pedido|comprar|agendar)\b/i.test(lower)) {
		return true;
	}

	return false;
}

/**
 * wantsInstagramOrSocial: true si pide Instagram / redes / historias.
 * Se evalúa junto con isOnlyBrowsing para cerrar el chat con la despedida.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function wantsInstagramOrSocial(messageText) {
	return /\b(instagram|insta|\big\b|redes?|segu(ir|irme|irnos)|historia|historias|video|videos)\b/i.test(
		String(messageText || '').toLowerCase()
	);
}

// ==============================================================================
// COMPLEMENTOS DE PREFIJO DEL BOT
// ==============================================================================
export function shouldHandleMessage(text, config) {
	if (!config.triggerPrefix) return true;
	return text.trim().startsWith(config.triggerPrefix);
}

export function stripTriggerPrefix(text, config) {
	if (!config.triggerPrefix) return text.trim();
	const prefix = config.triggerPrefix;
	if (text.trim().startsWith(prefix)) {
		return text.trim().slice(prefix.length).trim();
	}
	return text.trim();
}

// ==============================================================================
// FUNCIONES MEJORADAS DE EXTRACCION (Para Order Builder)
// ==============================================================================

/** Palabras cortas que NUNCA son comuna (evita "no" → Ñuñoa por substring). */
const LOCATION_STOPWORDS = new Set([
	'no', 'si', 'ok', 'ya', 'el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una',
	'mi', 'tu', 'su', 'para', 'por', 'con', 'sin', 'mas', 'muy', 'solo', 'hola',
	'gracias', 'web', 'chat', 'aca', 'aqui', 'aka', 'dale', 'listo', 'sos', 'nop',
	'casa', 'fiesta', 'evento', 'semana', 'mes', 'ano', 'hoy', 'manana'
]);

/** Artículos típicos al inicio de comunas chilenas (La / Las / El / Lo…). */
const LOCATION_ARTICLES = ['el', 'la', 'los', 'las', 'lo'];

/** Largo mínimo para aceptar match parcial (typo "nuno" / "provid"). */
const LOCATION_MIN_PARTIAL_LEN = 4;

/**
 * Apodos / typos frecuentes → nombre oficial en datos.json.
 * Se buscan como frase dentro del mensaje ya normalizado.
 */
const LOCATION_ALIASES = {
	stgo: 'Santiago',
	'santiago centro': 'Santiago',
	'la condes': 'Las Condes',
	lasconde: 'Las Condes',
	lascondes: 'Las Condes',
	condes: 'Las Condes',
	pac: 'Pedro Aguirre Cerda',
	'pedro aguirre': 'Pedro Aguirre Cerda',
	provid: 'Providencia',
	'estacion central': 'Estación Central',
	'jose de maipo': 'San José de Maipo',
	'san jose de maipo': 'San José de Maipo',
	nunoa: 'Ñuñoa',
	penalolen: 'Peñalolén',
	'til til': 'Tiltil'
};

/**
 * normalizeLocationText: Normaliza para buscar comunas (sin tildes ni signos).
 * "Las Condes!" / "la condes," → "las condes" / "la condes".
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeLocationText(str) {
	return normalizeString(str)
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * stripLeadingArticle: Quita el artículo inicial de un nombre normalizado.
 * "las condes" → "condes"; "providencia" → "providencia".
 *
 * @param {string} norm
 * @returns {string}
 */
function stripLeadingArticle(norm) {
	return String(norm || '').replace(/^(el|la|los|las|lo)\s+/, '');
}

/**
 * textContainsLocationPhrase: ¿El texto normalizado contiene la comuna como frase?
 * Evita matches por pedazos ("no" dentro de "nunoa").
 *
 * @param {string} haystackNorm - Mensaje ya normalizado
 * @param {string} needleNorm - Nombre de comuna normalizado
 * @returns {boolean}
 */
function textContainsLocationPhrase(haystackNorm, needleNorm) {
	if (!haystackNorm || !needleNorm) return false;
	if (haystackNorm === needleNorm) return true;
	// Palabra/frase completa con bordes (espacios o inicio/fin)
	const escaped = needleNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystackNorm);
}

/**
 * buildLocationSearchKeys: Variantes con las que suele escribir el cliente.
 * Ej. "Las Condes" → "las condes", "condes", "la condes", "lascondes"…
 *
 * @param {string} comunaName - Nombre oficial
 * @returns {string[]} Claves normalizadas (más largas primero)
 */
function buildLocationSearchKeys(comunaName) {
	const base = normalizeLocationText(comunaName);
	if (!base) return [];

	const keys = new Set([base]);
	const core = stripLeadingArticle(base);
	keys.add(core);
	keys.add(base.replace(/\s+/g, ''));
	keys.add(core.replace(/\s+/g, ''));

	// Si la comuna lleva artículo, también aceptamos artículo "equivocado"
	// (muy común: "la condes" en vez de "las condes")
	if (core && core !== base) {
		for (const art of LOCATION_ARTICLES) {
			keys.add(`${art} ${core}`);
		}
	}

	return [...keys]
		.filter((k) => k.length >= 3 && !LOCATION_STOPWORDS.has(k))
		.sort((a, b) => b.length - a.length);
}

/**
 * extractLocationHints: Saca candidatos tras "en …" / "comuna …".
 * Así "proxima semana en la condes" aporta el hint "la condes".
 * No usamos "de …" suelto (evita "boda de María" → María Pinto).
 *
 * @param {string} normalized - Mensaje ya normalizado para ubicación
 * @returns {string[]}
 */
function extractLocationHints(normalized) {
	if (!normalized) return [];
	const hints = new Set();
	const re =
		/\b(?:en|comuna(?:\s+de)?|sector|zona|vivo\s+en|queda\s+en|es\s+en)\s+((?:(?:el|la|los|las|lo)\s+)?[a-z0-9]+(?:\s+[a-z0-9]+){0,3})/g;
	let m;
	while ((m = re.exec(normalized))) {
		let hint = String(m[1] || '').trim();
		// Recorta si pegó palabras de fecha al final del hint
		hint = hint
			.replace(
				/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|semana|hoy|manana)\b.*$/i,
				''
			)
			.trim();
		if (hint.length >= 3 && !LOCATION_STOPWORDS.has(hint)) hints.add(hint);
	}
	return [...hints];
}

/**
 * resolveComunaRecord: Arma el objeto de retorno para una comuna RM u otra región.
 *
 * @param {string} comunaName
 * @param {object} comunasRM
 * @param {object} regionesChile
 * @returns {{ name: string, region: string, deliveryCost: object|null, isRM: boolean }|null}
 */
function resolveComunaRecord(comunaName, comunasRM, regionesChile) {
	if (comunasRM[comunaName]) {
		const rates = comunasRM[comunaName];
		return {
			name: comunaName,
			region: 'Región Metropolitana',
			deliveryCost: { desechable: rates.desechable, evento: rates.evento },
			isRM: true
		};
	}
	for (const [regionName, comunasList] of Object.entries(regionesChile)) {
		if (comunasList.includes(comunaName)) {
			return {
				name: comunaName,
				region: regionName,
				deliveryCost: null,
				isRM: false
			};
		}
	}
	return null;
}

/**
 * findLocationByFuzzyMatch: Busca comuna/región en el texto del cliente.
 * Cubre: nombre exacto, con "en …", artículo mal puesto ("la condes"),
 * sin espacios ("lascondes"), apodos (stgo) y typos parciales cortos.
 * Nunca usa includes suelto con textos cortos (bug: "no" ⊂ "nunoa" → Ñuñoa).
 *
 * @param {string} userLocation - Mensaje o fragmento con posible comuna
 * @returns {{ name: string, region: string, deliveryCost: object|null, isRM: boolean }|null}
 */
export function findLocationByFuzzyMatch(userLocation) {
	if (!userLocation) return null;

	const normalized = normalizeLocationText(userLocation);
	if (!normalized || LOCATION_STOPWORDS.has(normalized)) return null;

	const comunasRM = preciosData.comunas_rm || {};
	const regionesChile = preciosData.regiones_chile || {};

	/**
	 * tryReturn: Resuelve nombre oficial → registro, o null si no existe.
	 * @param {string} officialName
	 */
	const tryReturn = (officialName) =>
		resolveComunaRecord(officialName, comunasRM, regionesChile);

	// --- A) Apodos / typos conocidos (frase completa en el mensaje) ---
	// Preferimos aliases más largos ("santiago centro" antes que "stgo")
	const aliasEntries = Object.entries(LOCATION_ALIASES)
		.filter(([, official]) => official)
		.sort((a, b) => b[0].length - a[0].length);
	for (const [alias, official] of aliasEntries) {
		if (textContainsLocationPhrase(normalized, alias)) {
			const hit = tryReturn(official);
			if (hit) return hit;
		}
	}

	// --- B) Mensaje = nombre exacto (RM u otra región) ---
	for (const comunaName of Object.keys(comunasRM)) {
		if (normalizeLocationText(comunaName) === normalized) {
			return tryReturn(comunaName);
		}
	}
	for (const [regionName, comunasList] of Object.entries(regionesChile)) {
		for (const comuna of comunasList) {
			if (normalizeLocationText(comuna) === normalized) {
				return {
					name: comuna,
					region: regionName,
					deliveryCost: null,
					isRM: false
				};
			}
		}
	}

	// Hints tras "en …" (sirven para match exacto de variante y para typos)
	const hints = extractLocationHints(normalized);

	// --- C) Variantes de cada comuna RM dentro del mensaje o de un hint ---
	// Elegimos la clave más larga que matchee (más específica).
	let best = null;
	let bestKeyLen = 0;

	for (const comunaName of Object.keys(comunasRM)) {
		const keys = buildLocationSearchKeys(comunaName);
		for (const key of keys) {
			const inMessage = textContainsLocationPhrase(normalized, key);
			const inHint = hints.some(
				(h) => h === key || stripLeadingArticle(h) === stripLeadingArticle(key)
			);
			if ((inMessage || inHint) && key.length > bestKeyLen) {
				best = comunaName;
				bestKeyLen = key.length;
			}
		}
	}

	if (best) return tryReturn(best);

	// --- D) Fuzzy fuera de RM: frase o hint ---
	for (const [regionName, comunasList] of Object.entries(regionesChile)) {
		for (const comuna of comunasList) {
			const keys = buildLocationSearchKeys(comuna);
			for (const key of keys) {
				if (textContainsLocationPhrase(normalized, key) || hints.includes(key)) {
					return {
						name: comuna,
						region: regionName,
						deliveryCost: null,
						isRM: false
					};
				}
			}
		}
	}

	// --- E) Typo parcial: mensaje corto O hint corto contenido en el nombre ---
	const partialCandidates = [
		normalized,
		...hints
	].filter((t) => t.length >= LOCATION_MIN_PARTIAL_LEN);

	for (const candidate of partialCandidates) {
		// Solo si el candidato es "casi" el nombre (no el mensaje largo entero)
		if (candidate === normalized && /\s/.test(normalized) && normalized.split(/\s+/).length > 4) {
			continue;
		}
		for (const comunaName of Object.keys(comunasRM)) {
			const normComuna = normalizeLocationText(comunaName);
			const core = stripLeadingArticle(normComuna);
			if (
				(normComuna.includes(candidate) || core.includes(candidate))
				&& candidate.length < normComuna.length
			) {
				return tryReturn(comunaName);
			}
		}
	}

	return null;
}

export function parseClientName(text) {
	if (!text) return null;

	const explicitPatterns = [
		/\bme\s+llamo\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i,
		/\bmi\s+nombre\s+es\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i,
		/\ba\s+nombre\s+de\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i,
		/\bnombre\s*:\s*([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i,
		/\bsoy\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i
	];

	for (const pattern of explicitPatterns) {
		const match = text.match(pattern);
		if (match && match[1]) {
			return match[1].trim();
		}
	}

	const beforeComma = text.match(/^([A-Za-záéíóúÁÉÍÓÚñÑ\s]+),/);
	if (beforeComma && beforeComma[1]) {
		const candidate = beforeComma[1].trim();
		const words = candidate.split(/\s+/);
		const commonWords = ['hola', 'buenas', 'estimado', 'estimada', 'si', 'no', 'para', 'en', 'el', 'la', 'lo', 'este', 'esta', 'hoy', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'jeuves', 'viernes', 'sabado', 'sábado', 'domingo', 'quiero', 'barril', 'barriles', 'servicio', 'evento'];
		const hasCommon = words.some((w) => commonWords.includes(w.toLowerCase()));

		if (!hasCommon && candidate.length > 2) {
			return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
		}
	}

	const tokens = text.trim().split(/[\s,]+/);
	const commonWords = ['hola', 'buenas', 'estimado', 'estimada', 'si', 'no', 'para', 'en', 'el', 'la', 'lo', 'este', 'esta', 'hoy', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado', 'domingo', 'quiero', 'barril', 'barriles', 'servicio', 'evento'];

	for (const token of tokens) {
		if (/^[A-Z][a-zñáéíóú]+$/.test(token) && !commonWords.includes(token.toLowerCase())) {
			return token;
		}
	}

	const simplifiedText = text.trim().toLowerCase();
	const words = simplifiedText.split(/[\s,]+/).filter((w) => w.length > 2);
	const nonNameWords = [...commonWords, 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'mañana', 'manana', 'hoy', 'ayer', 'nada', 'ninguno'];

	if (words.length === 1 && !nonNameWords.includes(words[0])) {
		return text.trim().charAt(0).toUpperCase() + text.trim().slice(1).toLowerCase();
	}

	return null;
}

/**
 * parseDate: Extrae una fecha del mensaje del cliente (texto libre).
 * Acepta día+mes ("15 de mayo"), solo mes ("para diciembre"), números,
 * días de la semana y relativas (hoy / mañana).
 *
 * @param {string} text - Mensaje del cliente
 * @returns {string|null} Fragmento de fecha encontrado, o null
 */
export function parseDate(text) {
	if (!text) return null;

	const months =
		'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

	const datePatterns = [
		// Día + mes: "15 de mayo", "el 3 de diciembre"
		new RegExp(`((?:el\\s+)?\\d{1,2}\\s+de\\s+(?:${months}))`, 'i'),
		// Solo mes (con o sin preposición/año): "diciembre", "para diciembre", "en marzo 2027"
		new RegExp(
			`((?:(?:para|en|durante|este|el)\\s+)?(?:${months})(?:\\s+(?:de\\s+)?\\d{4})?)`,
			'i'
		),
		/(\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?)/,
		/((?:el\s+)?(?:lunes|martes|mi[eé]rcoles|jueves|jeuves|viernes|s[aá]bado|domingo)(?:\s+\d{1,2})?)/i,
		/(hoy|ma[ñn]ana|mañana|pasado ma[ñn]ana|este (?:lunes|martes|mi[eé]rcoles|jueves|jeuves|viernes|s[aá]bado|domingo)|proxima (?:semana|semana)|próxima semana)/i,
		/(el\s+\d{1,2})/i
	];

	for (const pattern of datePatterns) {
		const match = text.match(pattern);
		if (match && match[1]) {
			return match[1].trim();
		}
	}

	return null;
}

/**
 * parseElimination: Detecta "quita 1 mojito" en el carrito de barriles
 * (donde products es { "Mojito": 2 }).
 *
 * @param {string} text - Mensaje del cliente
 * @param {object} currentItems - Carrito actual { nombre: cantidad }
 * @param {string[]} allAvailableItemNames - Nombres del catálogo
 * @returns {{ name: string, newQty: number }|null}
 */
export function parseElimination(text, currentItems, allAvailableItemNames) {
	const eliminationWords = text.match(/\b(elimina|borra|quita|saca|quiero quitar|quiero sacar)\b/gi);
	if (eliminationWords && Object.keys(currentItems).length > 0) {
		const eliminationPattern = /\b(elimina|borra|quita|saca)\s+(\d+)?\s*(?:el\s+|los\s+|las\s+)?([A-Za-záéíóúÁÉÍÓÚñÑ\s]+)/i;
		const match = text.match(eliminationPattern);

		if (match) {
			const quantityToRemove = match[2] ? parseInt(match[2], 10) : null;
			const itemNamePattern = match[3].trim();

			for (const itemName of allAvailableItemNames) {
				const itemWords = itemName.split(/\s+/);
				for (const word of itemWords) {
					const wordRegex = new RegExp(`\\b${word}\\b`, 'gi');
					if (wordRegex.test(itemNamePattern)) {
						if (currentItems[itemName]) {
							const currentQty = currentItems[itemName];
							if (quantityToRemove && quantityToRemove > 0 && quantityToRemove < currentQty) {
								return { name: itemName, newQty: currentQty - quantityToRemove };
							}
							return { name: itemName, newQty: 0 };
						}
						break;
					}
				}
			}
		}
	}
	return null;
}

/**
 * isEventMenuCorrection: true si el cliente corrige un pedido mal entendido
 * (ej. "me equivoqué, son 10L de mojito no 10x").
 * Sirve para reemplazar líneas del mismo cóctel en vez de sumar otra.
 *
 * @param {string} text - Mensaje del cliente
 * @returns {boolean}
 */
export function isEventMenuCorrection(text) {
	return /\b(me\s+equivoc|equivoc|correg|en\s+vez|en\s+realidad|no\s+son|no\s+es|no\s+era|mejor\s+(pon|deja|cambia)|reemplaz|cambia(r)?\s+(el|la|a)|no\s+\d+\s*x|\d+\s*x|son\s+solo|solo\s+(\d+|quiero|deja|pon|poner|1|10l|5l|20l)|deja(lo)?\s+en|solamente|era\s+solo|en\s+verdad)\b/i.test(
		String(text || '')
	);
}

/**
 * parseEventElimination: Igual que parseElimination, pero para el carrito de eventos
 * donde cada ítem es { "Mojito::10L": { name, quantity, litrage } }.
 * Si el cliente dice "quita el mojito" y hay varios litrajes, elimina el primero que coincida.
 * También acepta correcciones tipo "me equivoqué... quita/saca...".
 *
 * @param {string} text - Mensaje del cliente
 * @param {object} currentItems - Carrito de eventos con claves name::litrage
 * @returns {{ key: string, name: string, litrage: string, newQty: number }|null}
 */
export function parseEventElimination(text, currentItems) {
	if (!text || Object.keys(currentItems || {}).length === 0) return null;

	// Palabras de quitar + correcciones que implican sacar lo anterior
	const eliminationWords = text.match(
		/\b(elimina|borra|quita|saca|quiero quitar|quiero sacar|sacar|quitar)\b/gi
	);
	if (!eliminationWords) return null;

	const eliminationPattern = /\b(elimina|borra|quita|saca|sacar|quitar)\s+(\d+)?\s*(?:el\s+|los\s+|las\s+)?([A-Za-záéíóúÁÉÍÓÚñÑ0-9\s]+)/i;
	const match = text.match(eliminationPattern);
	if (!match) return null;

	const quantityToRemove = match[2] ? parseInt(match[2], 10) : null;
	const itemNamePattern = normalizeString(match[3].trim());

	// Buscamos litraje opcional en el texto ("quita mojito 10L")
	const litrageInText = itemNamePattern.match(/\b(\d+)\s*l\b/);
	const wantedLitrage = litrageInText ? `${litrageInText[1]}L` : null;

	for (const [key, entry] of Object.entries(currentItems)) {
		if (!entry || !entry.name) continue;
		const normName = normalizeString(entry.name);
		const nameWords = normName.split(/\s+/).filter((w) => w.length > 2);
		const matchesName = nameWords.some((w) => itemNamePattern.includes(w))
			|| itemNamePattern.includes(normName)
			|| normName.includes(itemNamePattern.replace(/\b\d+\s*l\b/g, '').trim());

		if (!matchesName) continue;
		if (wantedLitrage && entry.litrage !== wantedLitrage) continue;

		const currentQty = entry.quantity || 0;
		if (quantityToRemove && quantityToRemove > 0 && quantityToRemove < currentQty) {
			return { key, name: entry.name, litrage: entry.litrage, newQty: currentQty - quantityToRemove };
		}
		return { key, name: entry.name, litrage: entry.litrage, newQty: 0 };
	}

	return null;
}

/**
 * fixEventLitrageShorthand: Corrige el error típico del NLU:
 * "10 de mojito" → quantity=10 litrage=5L  ❌  →  quantity=1 litrage=10L  ✅
 * Solo actúa si la "cantidad" es un litraje válido (5/10/20/30) y no dijo "x"/"unidades".
 *
 * @param {string} userMessage - Mensaje original del cliente
 * @param {{ name: string, quantity: number, litrage: string }} product - Producto del NLU
 * @param {string[]} allowedLitrages - Litrajes del formato (ej. ['5L','10L'])
 * @param {string} defaultLitrage - Litraje por defecto del formato
 * @returns {{ name: string, quantity: number, litrage: string }}
 */
export function fixEventLitrageShorthand(userMessage, product, allowedLitrages, defaultLitrage) {
	if (!product?.name || !product.quantity) return [product];

	const qty = product.quantity;
	const qtyAsLitrage = `${qty}L`;
	const msg = String(userMessage || '');

	// Explicó unidades: "10x", "10 unidades", "10 barriles", "10 cajas" → sí es cantidad explícita
	const hasExplicitUnits = new RegExp(`\\b${qty}\\s*x\\b`, 'i').test(msg)
		|| (/\b(unidades?|barriles?|cajas?)\b/i.test(msg) && new RegExp(`\\b${qty}\\b`).test(msg));

	if (hasExplicitUnits) {
		return [product];
	}

	// 1) Si qtyAsLitrage está directamente en allowedLitrages (ej. 10L o 20L es un barril válido):
	if (allowedLitrages.includes(qtyAsLitrage)) {
		return [{ ...product, quantity: 1, litrage: qtyAsLitrage }];
	}

	// 2) Partición óptima (ej. 35L en formato [10L, 5L] → 3x 10L y 1x 5L)
	const numericAllowed = allowedLitrages
		.map((l) => parseInt(l, 10))
		.filter((n) => !isNaN(n) && n > 0)
		.sort((a, b) => b - a);

	let tempRemaining = qty;
	const tempResults = [];
	for (const size of numericAllowed) {
		if (tempRemaining >= size) {
			const count = Math.floor(tempRemaining / size);
			tempResults.push({ ...product, quantity: count, litrage: `${size}L` });
			tempRemaining %= size;
		}
	}

	if (tempRemaining === 0 && tempResults.length > 0) {
		return tempResults;
	}

	// 3) Si es una cantidad > 3 o litraje no estándar (ej. "15 mojito" sin partición exacta), NUNCA asumir error.
	// Asignar quantity=1 y litrage=qtyAsLitrage (ej: 1x 15L), para que la validación notifique el litraje inválido.
	if (product.litrage && product.litrage !== defaultLitrage && product.litrage !== qtyAsLitrage) {
		return [product];
	}

	return [{ ...product, quantity: 1, litrage: qtyAsLitrage }];
}

export function resolveDoubtsProgrammatically(dudas, lastBotMessage = '') {
	const resolved = [];
	const remaining = [];

	// Extraer opciones que el bot ofreció en su último mensaje (líneas "- Nombre")
	const botOfferedOptions = [];
	if (lastBotMessage) {
		const lines = String(lastBotMessage).split('\n');
		for (const line of lines) {
			const m = line.match(/^\s*-\s*([A-Za-záéíóúÁÉÍÓÚñÑ0-9°º\s]+)/);
			if (m && m[1]) {
				botOfferedOptions.push(normalizeString(m[1].trim()));
			}
		}
	}

	for (const duda of dudas) {
		if (!duda || !duda.opciones || duda.opciones.length <= 1) {
			if (duda && duda.opciones && duda.opciones.length === 1) {
				resolved.push({ name: duda.opciones[0], quantity: 1 });
			}
			continue;
		}

		let opciones = duda.opciones;

		// Si el bot ofreció opciones en el turno anterior, y de la duda actual solo 1 opción coincide con la lista previa del bot:
		if (botOfferedOptions.length > 0) {
			const matchingBotOptions = opciones.filter((op) =>
				botOfferedOptions.some((botOp) => botOp === normalizeString(op) || botOp.includes(normalizeString(op)))
			);
			if (matchingBotOptions.length === 1) {
				testLog(`duda resuelta por contexto previo del bot: "${duda.mencionado}" → "${matchingBotOptions[0]}"`);
				resolved.push({ name: matchingBotOptions[0], quantity: 1 });
				continue;
			} else if (matchingBotOptions.length > 1) {
				opciones = matchingBotOptions;
			}
		}

		const mencionado = duda.mencionado || '';

		const normMencionado = normalizeString(mencionado);
		const userWords = normMencionado.split(/\s+/).filter((w) => w.length > 2);

		if (userWords.length === 0) {
			remaining.push({ ...duda, opciones });
			continue;
		}

		const matchesMap = opciones.map((opcion) => {
			const normOpcion = normalizeString(opcion);
			const matchedWords = userWords.filter((word) => normOpcion.includes(word));
			return { opcion, matchedWords };
		});

		const resolvedOption = matchesMap.find((current, index) => {
			const uniqueMatches = current.matchedWords.filter((word) => {
				return !matchesMap.some((other, otherIdx) => {
					if (index === otherIdx) return false;
					return other.matchedWords.includes(word);
				});
			});

			if (uniqueMatches.length > 0) {
				const othersHaveUnique = matchesMap.some((other, otherIdx) => {
					if (index === otherIdx) return false;
					const otherUnique = other.matchedWords.filter((w) => !current.matchedWords.includes(w));
					return otherUnique.length > 0;
				});
				return !othersHaveUnique;
			}
			return false;
		});

		if (resolvedOption) {
			testLog(`duda resuelta: "${mencionado}" → "${resolvedOption.opcion}"`);
			resolved.push({ name: resolvedOption.opcion, quantity: 1 });
		} else {
			remaining.push({ ...duda, opciones });
		}
	}

	return { resolved, remaining };
}

export function interceptBotOptionsAnswer(messageText, lastBotMessage) {
	if (!lastBotMessage || !messageText) return null;
	const botOfferedOptions = [];
	const lines = String(lastBotMessage).split('\n');
	for (const line of lines) {
		const m = line.match(/^\s*-\s*([A-Za-záéíóúÁÉÍÓÚñÑ0-9°º\s]+)/);
		if (m && m[1]) {
			botOfferedOptions.push(m[1].trim());
		}
	}
	if (botOfferedOptions.length === 0) return null;

	const fakeDuda = { mencionado: messageText, opciones: botOfferedOptions };
	const { resolved } = resolveDoubtsProgrammatically([fakeDuda]);
	if (resolved.length === 1) {
		return { name: resolved[0].name, quantity: 1 };
	}
	return null;
}

function getLevenshteinDistance(a, b) {
	const tmp = [];
	let i;
	let j;
	const alen = a.length;
	const blen = b.length;
	if (alen === 0) return blen;
	if (blen === 0) return alen;
	for (i = 0; i <= alen; i += 1) tmp[i] = [i];
	for (j = 0; j <= blen; j += 1) tmp[0][j] = j;
	for (i = 1; i <= alen; i += 1) {
		for (j = 1; j <= blen; j += 1) {
			tmp[i][j] = Math.min(tmp[i - 1][j] + 1, tmp[i][j - 1] + 1, tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
	}
	return tmp[alen][blen];
}

export function findClosestCatalogMatch(name, catalogNames) {
	if (!name) return null;

	const cleanName = (str) => normalizeString(str)
		.replace(/\b(clasico|clasica|tradicional|original|sabores|sabor)\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();

	const normName = normalizeString(name);
	const cleanedNormName = cleanName(name);

	// 1) Match exacto con o sin palabras descriptivas de relleno
	let bestMatch = catalogNames.find((c) => {
		const normC = normalizeString(c);
		return normC === normName || normC === cleanedNormName;
	});
	if (bestMatch) return bestMatch;

	// 2) Substring / palabra clave principal
	bestMatch = catalogNames.find((c) => {
		const cleanedC = cleanName(c);
		return cleanedNormName && (cleanedC.includes(cleanedNormName) || cleanedNormName.includes(cleanedC));
	});
	if (bestMatch) return bestMatch;

	// 3) Levenshtein sobre la cadena limpia
	let minDistance = Infinity;
	let closest = null;
	const target = cleanedNormName || normName;

	for (const catalogName of catalogNames) {
		const normCatalog = cleanName(catalogName) || normalizeString(catalogName);
		const dist = getLevenshteinDistance(target, normCatalog);

		const threshold = Math.max(2, Math.floor(normCatalog.length * 0.3));
		if (dist <= threshold && dist < minDistance) {
			minDistance = dist;
			closest = catalogName;
		}
	}

	return closest;
}
