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
 * Cubre frases naturales: "mirando", "solo estoy mirando", "gracias, solo miraba", "no gracias".
 * Sirve para cerrar con despedida suave en lugar de mandar al fallback FAQ/IA.
 *
 * @param {string} messageText - Mensaje del cliente
 * @returns {boolean}
 */
export function isOnlyBrowsing(messageText) {
	const trimmed = String(messageText || '').trim();
	if (!trimmed) return false;
	const lower = trimmed.toLowerCase();

	// Respuestas cortas de rechazo ("no", "nop", "nah")
	if (/^(no|nop|nope|nah)$/i.test(trimmed)) return true;

	// Mensaje casi solo "mirando" / "consultando" (con o sin "gracias" / "solo" / "estoy")
	// Ej: "mirando" | "solo mirando" | "gracias, solo estoy mirando"
	if (/^(gracias[,!.]?\s+)?(solo\s+)?(estoy\s+|estaba\s+|estuve\s+)?(mirando|consultando|viendo|miraba)[.!]?$/i.test(trimmed)) {
		return true;
	}

	// Frases de "solo mirar" en cualquier parte del mensaje
	if (/\b(solo\s+(estoy\s+|estaba\s+|estuve\s+)?(mirando|consultando|viendo|miraba)|estoy\s+mirando|estaba\s+mirando|solo\s+mirando|mirando\s+nom[aá]s|solo\s+consultaba|solo\s+viendo|solo\s+ver)\b/i.test(lower)) {
		return true;
	}

	// Rechazo explícito de cotizar / comprar ahora
	if (/\b(no\s+gracias|no\s+quiero(\s+cotiz)?|no\s+deseo|no\s+me\s+interesa|por\s+ahora\s+no|ahora\s+no|despu[eé]s|luego|en\s+otro\s+momento|nada|cancelar)\b/i.test(lower)) {
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
export function findLocationByFuzzyMatch(userLocation) {
	if (!userLocation) return null;

	const normalized = normalizeString(userLocation);
	const comunasRM = preciosData.comunas_rm || {};

	for (const [comunaName, rates] of Object.entries(comunasRM)) {
		if (normalizeString(comunaName) === normalized) {
			return {
				name: comunaName,
				region: 'Región Metropolitana',
				deliveryCost: { desechable: rates.desechable, evento: rates.evento },
				isRM: true
			};
		}
	}

	const regionesChile = preciosData.regiones_chile || {};
	for (const [regionName, comunasList] of Object.entries(regionesChile)) {
		for (const comuna of comunasList) {
			if (normalizeString(comuna) === normalized) {
				return {
					name: comuna,
					region: regionName,
					deliveryCost: null,
					isRM: false
				};
			}
		}
	}

	for (const [comunaName] of Object.entries(comunasRM)) {
		const normComuna = normalizeString(comunaName);
		if (normalized.includes(normComuna) || normComuna.includes(normalized)) {
			return {
				name: comunaName,
				region: 'Región Metropolitana',
				deliveryCost: { desechable: comunasRM[comunaName].desechable, evento: comunasRM[comunaName].evento },
				isRM: true
			};
		}
	}

	for (const [regionName, comunasList] of Object.entries(regionesChile)) {
		for (const comuna of comunasList) {
			const normComuna = normalizeString(comuna);
			if (normComuna.length >= 3 && normalized.includes(normComuna)) {
				return {
					name: comuna,
					region: regionName,
					deliveryCost: null,
					isRM: false
				};
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

export function parseDate(text) {
	if (!text) return null;

	const datePatterns = [
		/((?:el\s+)?\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))/i,
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
	return /\b(me\s+equivoc|equivoc|correg|en\s+vez|en\s+realidad|no\s+son|no\s+es|no\s+era|mejor\s+(pon|deja|cambia)|reemplaz|cambia(r)?\s+(el|la|a)|no\s+\d+\s*x)\b/i.test(
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
	if (!product?.name || !product.quantity) return product;

	const qty = product.quantity;
	const qtyAsLitrage = `${qty}L`;
	// Solo reinterpretamos si la "cantidad" es un tamaño de barril válido
	if (!allowedLitrages.includes(qtyAsLitrage)) return product;
	// Si ya trae un litraje distinto al default, confiamos en el NLU
	if (product.litrage && product.litrage !== defaultLitrage && product.litrage !== qtyAsLitrage) {
		return product;
	}

	const msg = String(userMessage || '');
	// Explicó unidades: "10x", "10 unidades", "10 barriles" → sí es cantidad
	if (new RegExp(`\\b${qty}\\s*x\\b`, 'i').test(msg)) return product;
	if (/\b(unidades?|barriles?)\b/i.test(msg) && new RegExp(`\\b${qty}\\b`).test(msg)) return product;

	// Atajo típico: "10 de mojito", "10 mojito", "10L de mojito"
	const looksLikeLitrage = new RegExp(
		`\\b${qty}\\s*(l\\b|de\\s+)?[a-záéíóúñ]`,
		'i'
	).test(msg);

	if (looksLikeLitrage || product.litrage === defaultLitrage) {
		return { ...product, quantity: 1, litrage: qtyAsLitrage };
	}
	return product;
}

export function resolveDoubtsProgrammatically(dudas) {
	const resolved = [];
	const remaining = [];

	for (const duda of dudas) {
		if (!duda || !duda.opciones || duda.opciones.length <= 1) {
			if (duda && duda.opciones && duda.opciones.length === 1) {
				resolved.push({ name: duda.opciones[0], quantity: 1 });
			}
			continue;
		}

		const mencionado = duda.mencionado || '';
		const opciones = duda.opciones;

		const normMencionado = normalizeString(mencionado);
		const userWords = normMencionado.split(/\s+/).filter((w) => w.length > 2);

		if (userWords.length === 0) {
			remaining.push(duda);
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
			remaining.push(duda);
		}
	}

	return { resolved, remaining };
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
	const normName = normalizeString(name);

	let bestMatch = catalogNames.find((c) => normalizeString(c) === normName);
	if (bestMatch) return bestMatch;

	let minDistance = Infinity;
	let closest = null;

	for (const catalogName of catalogNames) {
		const normCatalog = normalizeString(catalogName);
		const dist = getLevenshteinDistance(normName, normCatalog);

		const threshold = Math.max(2, Math.floor(normCatalog.length * 0.25));
		if (dist <= threshold && dist < minDistance) {
			minDistance = dist;
			closest = catalogName;
		}
	}

	bestMatch = closest;
	return bestMatch;
}
