// ==============================================================================
// OBJETIVO: Caja de Herramientas y Seguridad (Helpers).
// ==============================================================================
import fs from 'node:fs';
import { DATOS_JSON_PATH } from '../core/paths.js';
import { testLog } from '../core/debug-log.js';
import { enrichLocationFromCatalog, getCachedComunas } from './cot-catalog.js';

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

	// Si el modelo filtró razonamiento interno, no enviamos nada (el engine usará plantilla o NO_FAQ)
	if (/\bno puedo determinar\b|\bel cliente est[aá] (preguntando|cotizando)\b|\bproporcionar m[aá]s contexto\b|\bpreguntar si el cliente\b|\bdebes preguntar\b|\bno est[aá] claro si\b/i.test(out)) {
		return '';
	}

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
	lines.push('- Despacho: tarifas vivas del catálogo web (GET /api/v1/catalog). No uses montos viejos de esta tabla.');
	lines.push('- Barriles RM provincia Santiago: traslado propio. Resto RM: Blue Express misma zona (paquetes M/L).');
	lines.push('- Barriles otras regiones: Blue Express centro u extremo. Eventos fuera de RM: tarifa propia si existe, si no por confirmar.');
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

	// --- Despachos: resumen (montos exactos salen del catálogo API al cotizar) ---
	lines.push('DESPACHOS (resumen; el bot cotiza con el catálogo vivo, no inventes montos):');
	lines.push('- Eventos RM: traslado propio por comuna; Evento Gratis según umbral de litros.');
	lines.push('- Barriles RM Santiago: propio. Barriles resto RM: Blue Express misma zona.');
	lines.push('- Barriles regiones: Blue Express (centro / extremo). Comuna desconocida → pendiente.');

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
export function getProductFamilyBase(name) {
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

/**
 * getCoctelesNamesCatalog: Carta solo con nombres (sin precios), agrupada por categoría.
 * Sirve para "¿cuáles tienes?" sin depender del FAQ/LLM ni cortar el mensaje.
 *
 * @returns {string}
 */
export function getCoctelesNamesCatalog() {
	// Misma vista compacta en todo Eventos (más legible en WhatsApp)
	return getCoctelesNamesCatalogCompact();
}

/**
 * getCoctelesNamesCatalogCompact: Lista corta por categoría (agrupa familias / Spritz / Piscolas).
 * Pensada para releer sabores después del catálogo con precios.
 *
 * @returns {string}
 */
export function getCoctelesNamesCatalogCompact() {
	const catalog = preciosData.cocteles || {};
	const has = (name) => Boolean(catalog[name]);

	/** @type {Set<string>} */
	const used = new Set();
	const take = (name) => {
		if (!has(name)) return false;
		used.add(name);
		return true;
	};

	// ------------------------------------------------------------------
	// CLÁSICOS
	// ------------------------------------------------------------------
	const clasicos = [];
	const mojitoVars = [];
	if (take('Mojito')) mojitoVars.push('Tradicional');
	if (take('Mojito Frambuesa')) mojitoVars.push('Frambuesa');
	if (take('Mojito Mango')) mojitoVars.push('Mango');
	if (take('Mojito Maracuyá')) mojitoVars.push('Maracuyá');
	if (mojitoVars.length) clasicos.push(`Mojito: ${mojitoVars.join(' / ')}`);

	const classicsRow = ['Sangría', 'Caipiriña', 'Pisco Sour'].filter((n) => take(n));
	if (classicsRow.length) clasicos.push(classicsRow.join(' / '));

	const spritz = [];
	if (take('Aperol Spritz')) spritz.push('Aperol');
	if (take('Ramazzotti Spritz')) spritz.push('Ramazzotti');
	if (spritz.length) clasicos.push(`Spritz: ${spritz.join(' / ')}`);

	const gins = ['Tropical Gin', 'Gin & Tonic'].filter((n) => take(n));
	if (gins.length) clasicos.push(gins.join(', '));

	const muleRow = ['Tequila Margarita', 'Moscow Mule'].filter((n) => take(n));
	if (muleRow.length) clasicos.push(muleRow.join(' / '));

	// Nuevos clásicos del catálogo que no estén en el layout editorial
	const leftoverClasicos = Object.keys(catalog)
		.filter((n) => catalog[n]?.categoria === 'CLÁSICOS' && !used.has(n))
		.sort((a, b) => a.localeCompare(b, 'es'));
	if (leftoverClasicos.length) {
		leftoverClasicos.forEach((n) => used.add(n));
		clasicos.push(leftoverClasicos.join(' / '));
	}

	// ------------------------------------------------------------------
	// COMBINADOS
	// ------------------------------------------------------------------
	const combinados = [];
	const piscolaLabels = [
		['Piscola Mistral 35°', 'Mistral 35'],
		['Piscola Alto 35°', 'Alto 35'],
		['Piscola Alto Transparente 40°', 'Alto 40°'],
		['Piscola 3R Transparente 40°', '3R 40°']
	];
	const piscolas = piscolaLabels
		.filter(([name]) => take(name))
		.map(([, label]) => label);
	if (piscolas.length) combinados.push(`Piscolas: ${piscolas.join(', ')}`);
	if (take('Whiskcola J.W. Black')) combinados.push('Whiskcola J.W. Black');

	const leftoverComb = Object.keys(catalog)
		.filter((n) => catalog[n]?.categoria === 'COMBINADOS' && !used.has(n))
		.sort((a, b) => a.localeCompare(b, 'es'));
	if (leftoverComb.length) {
		leftoverComb.forEach((n) => used.add(n));
		combinados.push(leftoverComb.join(' / '));
	}

	// ------------------------------------------------------------------
	// MOCKTAILS (mostramos “Sin Alcohol” al cliente)
	// ------------------------------------------------------------------
	const mocktails = [];
	const mojitoNa = [];
	if (take('Mojito Mocktail')) mojitoNa.push('Tradicional');
	if (take('Mojito Frambuesa Mocktail')) mojitoNa.push('Frambuesa');
	if (take('Mojito Mango Mocktail')) mojitoNa.push('Mango');
	if (take('Mojito Maracuyá Mocktail')) mojitoNa.push('Maracuyá');
	if (mojitoNa.length) mocktails.push(`Mojito Sin Alcohol: ${mojitoNa.join(' / ')}`);

	const otherNa = [];
	if (take('Sangría Mocktail')) otherNa.push('Sangría Sin Alcohol');
	if (take('Maracuyá Spritz Mocktail')) otherNa.push('Maracuyá Spritz Sin Alcohol');
	if (otherNa.length) mocktails.push(otherNa.join(' / '));

	const leftoverMock = Object.keys(catalog)
		.filter((n) => catalog[n]?.categoria === 'MOCKTAILS' && !used.has(n))
		.sort((a, b) => a.localeCompare(b, 'es'))
		.map((n) => n.replace(/\s*Mocktail\s*$/i, ' Sin Alcohol'));
	if (leftoverMock.length) mocktails.push(leftoverMock.join(' / '));

	let text = '';
	if (clasicos.length) text += `🍸 *CLÁSICOS*\n${clasicos.join('\n')}`;
	if (combinados.length) text += `${text ? '\n\n' : ''}🥃 *COMBINADOS*\n${combinados.join('\n')}`;
	if (mocktails.length) text += `${text ? '\n\n' : ''}🍹 *MOCKTAILS*\n${mocktails.join('\n')}`;
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

	// Solo palabras de cóctel / litraje. Un número suelto (ej. "5 de agosto")
	// NO cuenta: si no, fechas y comunas disparan el NLU de productos.
	return dynamicDrinkKeywords.test(normalizedText);
}

/**
 * hasProductOrderSignal: ¿Hay indicios de pedido de cócteles/barriles?
 * Si es false, NO conviene llamar al NLU de productos (evita inventar Mojito
 * desde el ejemplo del bot ante "Gracias por la información").
 *
 * @param {string} text - Mensaje del cliente
 * @returns {boolean}
 */
export function hasProductOrderSignal(text) {
	const raw = String(text || '').trim();
	if (!raw) return false;
	if (hasDrinkSelection(raw)) return true;
	// Cantidad explícita de barriles/unidades sin nombre aún ("2 barriles")
	if (/\b\d+\s*(barriles?|unidades?|envases?)\b/i.test(raw)) return true;
	return false;
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

	// Rechazo explícito / no lo tomará (sin "después" suelto en frases de cotización)
	if (/\b(no\s+gracias|gracias\s+no|no\s+quiero(\s+cotiz)?|no\s+deseo|no\s+me\s+interesa|no\s+lo\s+tomar[eé]|por\s+ahora\s+no|ahora\s+no|nada|cancelar)\b/i.test(lower)) {
		return true;
	}

	// "Después" / "luego" solo como palabra suelta = mirón (no en "después te confirmo la comuna")
	if (/^(despu[eé]s|luego|en\s+otro\s+momento)(\s+gracias)?[.!]?$/i.test(trimmed)) {
		return true;
	}
	if (/\bdespu[eé]s\b/i.test(lower)) {
		if (/\b(confirmo|confirmar|te\s+(digo|aviso|paso)|comuna|fecha|datos|cotiz|quiero|necesito)\b/i.test(lower)) {
			return false;
		}
	}

	// "Lo tendré presente", "lo tengo presente", "para más adelante"
	if (/\b(lo\s+tendr[eé]\s+presente|lo\s+tengo\s+presente|tendr[eé]\s+presente|m[aá]s\s+adelante|en\s+el\s+futuro)\b/i.test(lower)) {
		return true;
	}
	// Mes futuro solo con señal de mirón (ej. "lo tendré presente para agosto")
	if (/\b(para|en)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(lower)) {
		if (/\b(lo\s+tendr[eé]\s+presente|lo\s+tengo\s+presente|solo\s+mir|mirando|quiz[aá]s|tal\s+vez)\b/i.test(lower)) {
			return true;
		}
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
	return /\b(instagram|insta|\big\b|redes?|segu(ir|irme|irnos)|historia|historias)\b/i.test(
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

/** Palabras que invalidan una captura "en …" que no es comuna (ej. "en lo que pueda ayudarte"). */
const LOCATION_CAPTURE_REJECT_RE = /\b(que|cual|cuales|donde|cuando|como|pueda|puedo|podemos|ayudarte|ayudar|ayudarle|algo|mas|este|esta|ese|esa|nada|todo|todos|hoy|aqui|ahi|ese|hablar|podria|puede|tienen|tienes|hay)\b/i;

/**
 * Tokens de fecha/tiempo que NUNCA son comuna tras "en …".
 * Cubre la familia del bug "50 invitados en diciembre" → comuna diciembre,
 * y hermanos: "en lunes", "en marzo", "en la tarde", etc.
 */
const LOCATION_DATE_TIME_TOKENS = new Set([
	// Meses
	'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
	'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
	// Días de la semana
	'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'jeuves',
	'viernes', 'sabado', 'sábado', 'domingo',
	// Relativos / momento del día / estaciones
	'hoy', 'manana', 'mañana', 'ayer', 'tarde', 'noche', 'madrugada',
	'semana', 'mes', 'ano', 'año', 'finde', 'weekend',
	'proxima', 'próxima', 'proximo', 'próximo', 'pasado',
	'verano', 'invierno', 'primavera', 'otono', 'otoño'
]);

/**
 * looksLikeDateOrTimeToken: ¿La palabra (o la primera tras artículo) es fecha/tiempo?
 *
 * @param {string} normWord - Token ya normalizado (minúsculas, sin acento opcional)
 * @returns {boolean}
 */
function looksLikeDateOrTimeToken(normWord) {
	const w = String(normWord || '').trim().toLowerCase();
	if (!w) return false;
	if (LOCATION_DATE_TIME_TOKENS.has(w)) return true;
	// Sin acentos (normalizeLocationText puede haber quitado ñ/acentos)
	const folded = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	return LOCATION_DATE_TIME_TOKENS.has(folded);
}

/**
 * isValidFreeformLocationCapture: ¿El texto capturado tras "en …" puede ser una comuna/ciudad?
 * Solo aceptamos catálogo oficial o 1–3 palabras sin verbos/pronombres/fecha-tiempo.
 *
 * @param {string} captured - Fragmento capturado por regex
 * @returns {boolean}
 */
export function isValidFreeformLocationCapture(captured) {
	const t = String(captured || '').trim();
	if (t.length < 3) return false;

	const norm = normalizeLocationText(t);
	if (!norm || LOCATION_STOPWORDS.has(norm)) return false;
	if (/^(lo\s+)?que\b/.test(norm)) return false;
	if (LOCATION_CAPTURE_REJECT_RE.test(norm)) return false;

	const words = norm.split(/\s+/).filter(Boolean);
	// "diciembre", "el viernes", "la tarde", "marzo 2027"
	if (words.some((w) => looksLikeDateOrTimeToken(w))) return false;
	if (words.length === 2 && /^\d{4}$/.test(words[1]) && looksLikeDateOrTimeToken(words[0])) {
		return false;
	}

	if (findLocationByFuzzyMatch(t)) return true;

	if (words.length > 3) return false;
	if (words.some((w) => LOCATION_CAPTURE_REJECT_RE.test(w) || LOCATION_STOPWORDS.has(w))) {
		return false;
	}

	return words.length >= 1 && words.length <= 3;
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
		// Recorta si pegó palabras de fecha/tiempo al final del hint
		hint = hint
			.replace(
				/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|hoy|manana|tarde|noche)\b.*$/i,
				''
			)
			.trim();
		if (hint.length >= 3 && !LOCATION_STOPWORDS.has(hint) && isValidFreeformLocationCapture(hint)) {
			hints.add(hint);
		}
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
	const catalogComunas = getCachedComunas().filter(
		(c) => c?.name && normalizeLocationText(c.name) !== 'otra'
	);

	/**
	 * tryReturn: Resuelve nombre oficial → registro, o null si no existe.
	 * @param {string} officialName
	 */
	const tryReturn = (officialName) => {
		const base = resolveComunaRecord(officialName, comunasRM, regionesChile);
		if (base) return enrichLocationFromCatalog(base);
		const catalogHit = getCachedComunas().find(
			(c) => c?.name && normalizeLocationText(c.name) === normalizeLocationText(officialName)
		);
		if (!catalogHit) return null;
		return enrichLocationFromCatalog({
			name: catalogHit.name,
			region: catalogHit.regionShortName || '',
			deliveryCost: null,
			isRM: catalogHit.regionCode === 'RM'
		});
	};

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
	for (const c of catalogComunas) {
		if (normalizeLocationText(c.name) === normalized) {
			return tryReturn(c.name);
		}
	}
	for (const [regionName, comunasList] of Object.entries(regionesChile)) {
		for (const comuna of comunasList) {
			if (normalizeLocationText(comuna) === normalized) {
				return enrichLocationFromCatalog({
					name: comuna,
					region: regionName,
					deliveryCost: null,
					isRM: false
				});
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
	for (const c of catalogComunas) {
		const keys = buildLocationSearchKeys(c.name);
		for (const key of keys) {
			const inMessage = textContainsLocationPhrase(normalized, key);
			const inHint = hints.some(
				(h) => h === key || stripLeadingArticle(h) === stripLeadingArticle(key)
			);
			if ((inMessage || inHint) && key.length > bestKeyLen) {
				best = c.name;
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
					return enrichLocationFromCatalog({
						name: comuna,
						region: regionName,
						deliveryCost: null,
						isRM: false
					});
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

	// Palabras que NUNCA son nombre (días, meses, cortesía, productos, etc.)
	const commonWords = [
		'hola', 'buenas', 'buen', 'buenos', 'dias', 'días', 'tardes', 'noches',
		'estimado', 'estimada', 'si', 'sí', 'no', 'para', 'en', 'el', 'la', 'lo',
		'este', 'esta', 'hoy', 'mañana', 'manana', 'ayer', 'luego', 'despues', 'después',
		'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'jeuves', 'viernes',
		'sabado', 'sábado', 'domingo',
		'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
		'septiembre', 'octubre', 'noviembre', 'diciembre',
		'quiero', 'quisiera', 'necesito', 'gracias', 'ok', 'okay', 'dale', 'perfecto',
		'barril', 'barriles', 'servicio', 'evento', 'eventos', 'cotizar', 'cotizacion',
		'cotización', 'mojito', 'sangria', 'sangría', 'aperol', 'pisco', 'dispensador', 'muro',
		'providencia', 'condes', 'nunoa', 'ñuñoa', 'santiago', 'comuna', 'fecha'
	];

	const beforeComma = text.match(/^([A-Za-záéíóúÁÉÍÓÚñÑ\s]+),/);
	if (beforeComma && beforeComma[1]) {
		const candidate = beforeComma[1].trim();
		const words = candidate.split(/\s+/);
		const hasCommon = words.some((w) => commonWords.includes(w.toLowerCase()));

		// Exigimos al menos 2 palabras (nombre + apellido) en el patrón "X Y, resto"
		if (!hasCommon && candidate.length > 2 && words.length >= 2) {
			return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
		}
	}

	const tokens = text.trim().split(/[\s,]+/);

	// Token capitalizado suelto: solo si el mensaje es corto (1–2 tokens) y no es commonWord
	if (tokens.length <= 2) {
		for (const token of tokens) {
			if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(token) && !commonWords.includes(token.toLowerCase())) {
				return token;
			}
		}
	}

	const simplifiedText = text.trim().toLowerCase();
	const words = simplifiedText.split(/[\s,]+/).filter((w) => w.length > 2);
	const nonNameWords = [...commonWords, 'nada', 'ninguno'];

	// Una sola palabra: solo si parece nombre propio (no commonWord)
	if (words.length === 1 && !nonNameWords.includes(words[0])) {
		return text.trim().charAt(0).toUpperCase() + text.trim().slice(1).toLowerCase();
	}

	return null;
}

/**
 * parseDate: Extrae una fecha del mensaje del cliente (texto libre).
 * Acepta día+mes con o sin "de" ("15 de mayo", "15 diciembre"),
 * solo mes ("para diciembre"), números, días de la semana y relativas.
 *
 * Importante: día+mes va ANTES que solo-mes. Si no, "15 diciembre"
 * matchearía solo "diciembre" y perderíamos el día.
 *
 * @param {string} text - Mensaje del cliente
 * @returns {string|null} Fragmento de fecha encontrado, o null
 */
export function parseDate(text) {
	if (!text) return null;

	const months =
		'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

	const datePatterns = [
		// Día + mes (+ año opcional): "15 de mayo", "15 diciembre", "el 3 dic… 2027"
		// \b evita falsos positivos (ej. "enero" dentro de "género")
		new RegExp(
			`\\b((?:el\\s+)?\\d{1,2}\\s+(?:de\\s+)?(?:${months})(?:\\s+(?:de\\s+)?\\d{4})?)\\b`,
			'i'
		),
		// Solo mes (con o sin preposición/año): "diciembre", "para diciembre", "en marzo 2027"
		new RegExp(
			`\\b((?:(?:para|en|durante|este|el)\\s+)?(?:${months})(?:\\s+(?:de\\s+)?\\d{4})?)\\b`,
			'i'
		),
		/(\d{1,2}\s*[-/]\s*\d{1,2}(?:\s*[-/]\s*\d{2,4})?)/,
		/((?:el\s+)?(?:lunes|martes|mi[eé]rcoles|jueves|jeuves|viernes|s[aá]bado|domingo)(?:\s+\d{1,2})?)/i,
		/(hoy|ma[ñn]ana|mañana|pasado ma[ñn]ana|este (?:lunes|martes|mi[eé]rcoles|jueves|jeuves|viernes|s[aá]bado|domingo)|proxima (?:semana|semana)|próxima semana)/i,
		// Año relativo (sin día concreto): "próximo año", "el año que viene"
		/\b((?:el\s+)?pr[oó]ximo\s+a[nñ]o|(?:el\s+)?a[nñ]o\s+que\s+viene)\b/i,
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
 * pickSpecificCartNameMatches: Resuelve a qué producto(s) del carrito se refiere
 * el cliente cuando hay familias con nombre compartido (Mojito / Mojito Frambuesa).
 *
 * Regla: si el nombre COMPLETO de un candidato aparece en lo que pidió el cliente,
 * ese candidato es "match completo". Entre los matches completos, gana el más
 * específico (más palabras) — así "mojito frambuesa" NUNCA selecciona también
 * "Mojito", y "mojito" solo NUNCA selecciona "Mojito Frambuesa".
 * Si ningún candidato tiene match completo (ej. "aperol" ↔ "Aperol Spritz",
 * el cliente omitió una palabra), cae a solapamiento simple como antes.
 *
 * @param {string} rawName - Texto tras el verbo/frase de eliminar (sin litraje)
 * @param {string[]} candidateNames - Nombres de catálogo presentes en el carrito
 * @returns {string[]} Nombres seleccionados, priorizados por especificidad
 */
export function pickSpecificCartNameMatches(rawName, candidateNames) {
	const nameOnly = normalizeString(rawName).trim();
	if (!nameOnly || !Array.isArray(candidateNames) || candidateNames.length === 0) return [];

	const requestTokens = nameOnly.split(/\s+/).filter((w) => w.length > 2);
	const tokenOverlaps = (word) =>
		requestTokens.some((t) => t === word || t.startsWith(word) || word.startsWith(t));

	const scored = [];
	for (const itemName of candidateNames) {
		const normItem = normalizeString(itemName);
		const entryWords = normItem.split(/\s+/).filter((w) => w.length > 2);
		if (entryWords.length === 0) continue;

		const overlaps = entryWords.some(tokenOverlaps)
			|| nameOnly.includes(normItem)
			|| normItem.includes(nameOnly);
		if (!overlaps) continue;

		const fullyMatched = entryWords.every(tokenOverlaps);
		scored.push({ name: itemName, specificity: entryWords.length, fullyMatched });
	}

	if (scored.length === 0) return [];

	const fullMatches = scored.filter((s) => s.fullyMatched);
	if (fullMatches.length > 0) {
		const maxSpecificity = Math.max(...fullMatches.map((s) => s.specificity));
		return fullMatches.filter((s) => s.specificity === maxSpecificity).map((s) => s.name);
	}

	// Sin match completo (ej. "aperol" ↔ "Aperol Spritz"): mantenemos el solapamiento simple
	return scored.map((s) => s.name);
}

/**
 * parseElimination: Detecta rechazo de un cóctel en el carrito de barriles
 * (products = { "Mojito": 2 }). Misma familia de frases que eventos:
 * "quita 1 mojito", "no quiero el aperol", "sin sangría".
 * Usa pickSpecificCartNameMatches para no confundir "Mojito" con "Mojito Frambuesa".
 *
 * @param {string} text - Mensaje del cliente
 * @param {object} currentItems - Carrito actual { nombre: cantidad }
 * @param {string[]} allAvailableItemNames - Nombres del catálogo
 * @returns {{ name: string, newQty: number }|null}
 */
export function parseElimination(text, currentItems, allAvailableItemNames) {
	if (!text || !currentItems || Object.keys(currentItems).length === 0) return null;
	if (!hasEventEliminationIntent(text)) return null;

	const target = extractEliminationTarget(text);
	if (!target) return null;

	const inCartNames = (allAvailableItemNames || []).filter((n) => currentItems[n]);
	const matchedNames = pickSpecificCartNameMatches(target.rawName, inCartNames);
	if (matchedNames.length === 0) return null;

	const itemName = matchedNames[0];
	const currentQty = currentItems[itemName];
	const { quantityToRemove } = target;
	if (quantityToRemove && quantityToRemove > 0 && quantityToRemove < currentQty) {
		return { name: itemName, newQty: currentQty - quantityToRemove };
	}
	return { name: itemName, newQty: 0 };
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
 * ELIMINATION_STOP_TAILS: Colas que NO son nombre de cóctel tras "sin/no quiero".
 * Evita falsos positivos: "sin problema", "no quiero eso", "sin más".
 */
const ELIMINATION_STOP_TAILS = new Set([
	'problema', 'problemas', 'duda', 'dudas', 'mas', 'más', 'eso', 'esto', 'nada',
	'alcohol', 'gracias', 'preocupes', 'preocupado', 'preocupada', 'apuro', 'prisa',
	'avanzar', 'seguir', 'continuar', 'ok', 'okay', 'todo', 'ambos', 'ninguno'
]);

/**
 * hasEventEliminationIntent: ¿Quiere sacar algo del pedido?
 * Cubre verbos (quita/elimina) y rechazo natural (no quiero X, sin X, no me gusta X).
 * "sin problema" / "no quiero eso" no cuentan (sin cola de cóctel usable).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasEventEliminationIntent(text) {
	const t = String(text || '');
	if (!t.trim()) return false;
	// Verbos explícitos de quitar
	if (/\b(elimina(?:r)?|borra(?:r)?|quita(?:r)?|saca(?:r)?|quiero\s+quitar|quiero\s+sacar)\b/i.test(t)) {
		return true;
	}
	// Rechazo natural: solo si hay un objetivo parseable, o "no quiero" suelto
	if (/\bno\s+(?:me\s+)?(?:quiero|gusta)\b/i.test(t)) {
		if (extractEliminationTarget(t)) return true;
		return /^(no\s+(?:me\s+)?(?:quiero|gusta))[.!?\s]*$/i.test(t.trim());
	}
	if (/\b(?:mejor\s+)?sin\b/i.test(t) || /\bnada\s+de\b/i.test(t) || /\bfuera\b/i.test(t)) {
		return Boolean(extractEliminationTarget(t));
	}
	return false;
}

/**
 * extractEliminationTarget: Saca cantidad opcional + nombre tras la frase de rechazo.
 * Patrones hermanos: "quita el X", "no quiero la X", "sin X", "no me gusta X", "nada de X".
 *
 * @param {string} text
 * @returns {{ quantityToRemove: number|null, rawName: string }|null}
 */
export function extractEliminationTarget(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed) return null;

	const patterns = [
		// quita / elimina / saca / borra [N] [el|la] NOMBRE
		/\b(?:quiero\s+)?(?:elimina(?:r)?|borra(?:r)?|quita(?:r)?|saca(?:r)?)\s+(\d+)?\s*(?:el|la|los|las)?\s*(.+)$/i,
		// no quiero [más] [el|la] NOMBRE | no me gusta [el|la] NOMBRE
		/\bno\s+(?:me\s+)?(?:quiero|gusta)\s+(?:m[aá]s\s+)?(?:el|la|los|las)?\s*(.+)$/i,
		// (mejor) sin [el|la] NOMBRE
		/\b(?:mejor\s+)?sin\s+(?:el|la|los|las)?\s*(.+)$/i,
		// nada de NOMBRE
		/\bnada\s+de\s+(?:el|la|los|las)?\s*(.+)$/i,
		// fuera [el|la] NOMBRE
		/\bfuera\s+(?:el|la|los|las)?\s*(.+)$/i
	];

	for (const re of patterns) {
		const match = trimmed.match(re);
		if (!match) continue;

		let quantityToRemove = null;
		let rawName = '';
		if (match.length >= 3 && match[1] != null && /^\d+$/.test(String(match[1]).trim())) {
			quantityToRemove = parseInt(match[1], 10);
			rawName = String(match[2] || '');
		} else {
			rawName = String(match[match.length - 1] || '');
		}

		rawName = rawName
			.replace(/[.!?,;]+$/g, '')
			.replace(/^(el|la|los|las|lo)\s+/i, '')
			.trim();
		if (!rawName) continue;

		const normTail = normalizeString(rawName).split(/\s+/).filter(Boolean);
		// "sin problema" / "no quiero eso" → no es cóctel
		if (normTail.length === 1 && ELIMINATION_STOP_TAILS.has(normTail[0])) continue;
		if (normTail.every((w) => ELIMINATION_STOP_TAILS.has(w))) continue;

		return { quantityToRemove, rawName };
	}

	return null;
}

/**
 * isBareEventEliminationRequest: Solo dijo "quitar"/"no quiero"/etc. sin nombrar cóctel.
 * Hay que preguntar qué sacar; no avanzar ni llamar NLU a ciegas.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isBareEventEliminationRequest(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed) return false;
	if (extractEliminationTarget(trimmed)) return false;
	return /^(quiero\s+)?(eliminar|elimina|borra(r)?|quita(r)?|saca(r)?)(\s+(algo|uno|una|alguno|alguna|eso|esto|todo))?[.!?\s]*$/i.test(trimmed)
		|| /^(no\s+(?:me\s+)?(?:quiero|gusta)|sin\s+eso|sin\s+nada|nada\s+de\s+eso)[.!?\s]*$/i.test(trimmed);
}

/**
 * hasExplicitEventAddIntent: El cliente pidió sumar, no reemplazar totales.
 * Ej.: "agrega 10L mojito", "también 5L sangría", "otro aperol".
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasExplicitEventAddIntent(text) {
	return /\b(agrega(r)?|suma(r)?|a[nñ]ade(r)?|tambi[eé]n|adem[aá]s|otro|otra|m[aá]s\s+\d)\b/i.test(
		String(text || '')
	);
}

/**
 * hasEventCartPreserveIntent: Quiere sumar o aclarar sin borrar lo que ya lleva en el carrito.
 * Ej.: "quería pisco sour", "mantén los anteriores", "me faltó el mojito".
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasEventCartPreserveIntent(text) {
	return /\b(quer[ií]a|falt[oó]|me\s+falt|tambi[eé]n|adem[aá]s|mant[ée]n|conserva|deja\s+(lo|los|las)|anteriores|lo\s+anterior|sin\s+quitar)\b/i.test(
		String(text || '')
	);
}

/**
 * parseEventElimination: Detecta rechazo de un cóctel en el carrito de eventos
 * ({ "Mojito::10L": { name, quantity, litrage } }).
 * - Match: elimina todas las líneas de ese cóctel (salvo litraje/cantidad explícitos).
 * - Nombró uno que NO está: { notInCart: true } (el caller NO debe agregarlo).
 *
 * @param {string} text - Mensaje del cliente
 * @param {object} currentItems - Carrito de eventos con claves name::litrage
 * @returns {{ key: string, keys: string[], name: string, litrage: string, newQty: number, notInCart?: boolean, requestedName?: string }|null}
 */
export function parseEventElimination(text, currentItems) {
	if (!text || Object.keys(currentItems || {}).length === 0) return null;
	if (!hasEventEliminationIntent(text)) return null;

	const target = extractEliminationTarget(text);
	if (!target) return null;

	const { quantityToRemove, rawName } = target;
	const itemNamePattern = normalizeString(rawName);
	const litrageInText = itemNamePattern.match(/\b(\d+)\s*l\b/);
	const wantedLitrage = litrageInText ? `${litrageInText[1]}L` : null;
	const nameOnly = itemNamePattern
		.replace(/\b\d+\s*l\b/g, '')
		.replace(/^(el|la|los|las|lo)\s+/, '')
		.trim();
	if (!nameOnly) return null;

	// Nombres distintos presentes en el carrito (sin duplicar por litraje)
	const candidateNames = [...new Set(
		Object.values(currentItems).map((e) => e?.name).filter(Boolean)
	)];
	const matchedNames = pickSpecificCartNameMatches(nameOnly, candidateNames);

	if (matchedNames.length === 0) {
		return {
			key: '',
			keys: [],
			name: rawName,
			litrage: wantedLitrage || '',
			newQty: 0,
			notInCart: true,
			requestedName: rawName
		};
	}

	// pickSpecificCartNameMatches ya resolvió la ambigüedad de familia (Mojito vs Mojito Frambuesa)
	const targetName = matchedNames[0];
	const matches = [];
	for (const [key, entry] of Object.entries(currentItems)) {
		if (entry?.name !== targetName) continue;
		if (wantedLitrage && entry.litrage !== wantedLitrage) continue;
		matches.push({ key, entry });
	}

	if (matches.length === 0) {
		return {
			key: '',
			keys: [],
			name: rawName,
			litrage: wantedLitrage || '',
			newQty: 0,
			notInCart: true,
			requestedName: rawName
		};
	}

	if (quantityToRemove && matches.length === 1) {
		const { key, entry } = matches[0];
		const currentQty = entry.quantity || 0;
		if (quantityToRemove > 0 && quantityToRemove < currentQty) {
			return {
				key,
				keys: [key],
				name: entry.name,
				litrage: entry.litrage,
				newQty: currentQty - quantityToRemove
			};
		}
	}

	return {
		key: matches[0].key,
		keys: matches.map((m) => m.key),
		name: matches[0].entry.name,
		litrage: wantedLitrage || matches.map((m) => m.entry.litrage).join('+'),
		newQty: 0
	};
}

/**
 * partitionLitersIntoBarrels: Parte un total de litros en barriles del formato.
 * Ej.: 15L con [10L, 5L] → [{ size: 10, count: 1 }, { size: 5, count: 1 }]
 * Si no se puede cubrir exacto, retorna null.
 *
 * @param {number} totalLiters
 * @param {string[]} allowedLitrages
 * @returns {Array<{ size: number, count: number }>|null}
 */
export function partitionLitersIntoBarrels(totalLiters, allowedLitrages) {
	const total = Number(totalLiters);
	if (!Number.isFinite(total) || total <= 0) return null;

	const numericAllowed = allowedLitrages
		.map((l) => parseInt(l, 10))
		.filter((n) => !isNaN(n) && n > 0)
		.sort((a, b) => b - a);

	let rem = total;
	const parts = [];
	for (const size of numericAllowed) {
		if (rem >= size) {
			const count = Math.floor(rem / size);
			parts.push({ size, count });
			rem %= size;
		}
	}
	if (rem !== 0 || parts.length === 0) return null;
	return parts;
}

/**
 * formatBarrelPartsLabel: Texto corto de cómo se arma el total en barriles.
 * Ej.: 2×10L → "2×10L"; 1×10L + 1×5L → "10L + 5L"; 2×10L + 1×5L → "2×10L + 5L".
 *
 * @param {Array<{ size: number, count: number }>} parts - Barriles por tamaño (mayor→menor)
 * @returns {string}
 */
export function formatBarrelPartsLabel(parts) {
	if (!Array.isArray(parts) || parts.length === 0) return '';
	return parts
		.filter((p) => p && p.count > 0 && p.size > 0)
		.map((p) => (p.count === 1 ? `${p.size}L` : `${p.count}×${p.size}L`))
		.join(' + ');
}

/**
 * groupCocktailLinesByName: Agrupa líneas del carrito/cotización por nombre de cóctel.
 * El cliente piensa en litros totales; internamente seguimos con barriles por litraje.
 *
 * @param {Array<{ name: string, quantity: number, litrage: string, price?: number, lineTotal?: number }>} lines
 * @returns {Array<{ name: string, totalLiters: number, lineTotal: number, parts: Array<{ size: number, count: number }>, unitPriceHint?: string }>}
 */
export function groupCocktailLinesByName(lines) {
	const byName = new Map();

	for (const line of lines || []) {
		if (!line?.name || line.isExtra) continue;
		const qty = Number(line.quantity) || 0;
		const size = parseInt(String(line.litrage || '').replace(/\D/g, ''), 10) || 0;
		if (qty <= 0 || size <= 0) continue;

		if (!byName.has(line.name)) {
			byName.set(line.name, {
				name: line.name,
				totalLiters: 0,
				lineTotal: 0,
				partsMap: new Map(),
				priceBits: []
			});
		}
		const g = byName.get(line.name);
		g.totalLiters += size * qty;
		g.lineTotal += Number(line.lineTotal != null
			? line.lineTotal
			: (Number(line.price) || 0) * qty);
		g.partsMap.set(size, (g.partsMap.get(size) || 0) + qty);
		if (line.price != null && qty > 0) {
			g.priceBits.push({ size, qty, price: line.price });
		}
	}

	return [...byName.values()].map((g) => {
		const parts = [...g.partsMap.entries()]
			.sort((a, b) => b[0] - a[0])
			.map(([size, count]) => ({ size, count }));
		return {
			name: g.name,
			totalLiters: g.totalLiters,
			lineTotal: g.lineTotal,
			parts,
			priceBits: g.priceBits
		};
	});
}

/**
 * formatEventCocktailLitersLine: Una línea legible en litros + desglose de barriles.
 * Ej.: "20L Mojito (2×10L): $219.980" o "15L Aperol Spritz (10L + 5L): $249.980".
 * Un solo barril: "10L Mojito: $109.990" (sin paréntesis redundante).
 *
 * @param {{ name: string, totalLiters: number, lineTotal: number, parts: Array<{ size: number, count: number }> }} group
 * @param {{ prefix?: string, showUnitMath?: boolean }} [opts]
 * @returns {string}
 */
export function formatEventCocktailLitersLine(group, opts = {}) {
	if (!group?.name || !(group.totalLiters > 0)) return '';
	const prefix = opts.prefix != null ? opts.prefix : '-';
	const head = prefix === '' ? '' : `${prefix} `;
	const parts = group.parts || [];
	const breakdown = formatBarrelPartsLabel(parts);
	const onlyOneBarrel = parts.length === 1 && parts[0].count === 1;
	const namePart = onlyOneBarrel
		? `${group.totalLiters}L ${group.name}`
		: `${group.totalLiters}L ${group.name} (${breakdown})`;

	// Cotización formal: opcional mostrar precio unitario cuando hay un solo tamaño
	if (opts.showUnitMath && parts.length === 1 && group.priceBits?.length === 1) {
		const bit = group.priceBits[0];
		if (bit.qty > 1) {
			return `${head}${namePart}: ${formatPrice(bit.price)} x ${bit.qty} = ${formatPrice(group.lineTotal)}`;
		}
	}

	return `${head}${namePart}: ${formatPrice(group.lineTotal)}`;
}

/**
 * fixEventLitrageShorthand: Corrige el error típico del NLU:
 * "10 de mojito" → quantity=10 litrage=5L  ❌  →  quantity=1 litrage=10L  ✅
 * También parte litrajes no estándar: "15L Sangria" → 1×10L + 1×5L.
 * Solo actúa si la "cantidad" es un litraje válido (5/10/20/30) y no dijo "x"/"unidades".
 *
 * @param {string} userMessage - Mensaje original del cliente
 * @param {{ name: string, quantity: number, litrage: string }} product - Producto del NLU
 * @param {string[]} allowedLitrages - Litrajes del formato (ej. ['5L','10L'])
 * @param {string} defaultLitrage - Litraje por defecto del formato
 * @returns {Array<{ name: string, quantity: number, litrage: string }>}
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

	// 2) Partición óptima de la "cantidad" como litros (ej. 35 → 3×10L + 1×5L)
	const qtyParts = partitionLitersIntoBarrels(qty, allowedLitrages);
	if (qtyParts) {
		return qtyParts.map(({ size, count }) => ({
			...product,
			quantity: count,
			litrage: `${size}L`
		}));
	}

	// 3) Litraje explícito no estándar (ej. "15L Sangria" con allowed 5L/10L)
	const litNum = parseInt(String(product.litrage || ''), 10);
	if (
		product.litrage
		&& !allowedLitrages.includes(product.litrage)
		&& Number.isFinite(litNum)
		&& litNum > 0
	) {
		const litParts = partitionLitersIntoBarrels(litNum, allowedLitrages);
		if (litParts) {
			return litParts.map(({ size, count }) => ({
				...product,
				quantity: count * qty,
				litrage: `${size}L`
			}));
		}
	}

	// 4) Cantidad 1 sin litraje en el mensaje: conservar litrage ya asignado (ej. default 10L en Muro)
	if (qty === 1 && product.litrage && allowedLitrages.includes(product.litrage)) {
		return [product];
	}

	// 5) Cantidad > 1 sin partición exacta → probar qty como litraje (validación posterior)
	if (product.litrage && product.litrage !== defaultLitrage && product.litrage !== qtyAsLitrage) {
		return [product];
	}

	return [{ ...product, quantity: 1, litrage: qtyAsLitrage }];
}

/**
 * isBotCartOrPriceLine: ¿La línea del historial es un ítem de carrito/precio?
 * No debe usarse como "opción de menú" para resolver dudas
 * (ej. "- 25L Mojito Frambuesa (...): $314.970").
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isBotCartOrPriceLine(line) {
	const t = String(line || '');
	if (/\$\s*\d/.test(t)) return true;
	if (/^\s*[-•]\s*\d+\s*[x×]/i.test(t)) return true;
	if (/^\s*[-•]\s*\d+\s*l\b/i.test(t)) return true;
	if (/\b\d+\s*l\b/i.test(t) && /\(/i.test(t)) return true;
	if (/subtotal|litros:|c[oó]cteles/i.test(t)) return true;
	return false;
}

/**
 * asksCocktailFlavorList: ¿Pregunta qué sabores/variedades hay?
 * Ej.: "qué mojito sabor tienes?", "sabores de mojito", "qué piscolas hay?"
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksCocktailFlavorList(messageText) {
	const raw = String(messageText || '').trim();
	if (!raw) return false;
	const norm = normalizeString(raw);
	const hasFlavorWord = /\b(sabor|sabores|variedad|variedades)\b/.test(norm);
	const hasAskCue = /\b(que|cual|cuales|tienen|tienes|hay|ofrec|disponible|mostrar|lista)\b/.test(norm)
		|| /\?/.test(raw);
	if (hasFlavorWord && hasAskCue) return true;
	if (/\b(mojito|piscola|sangria)\s+sabores?\b/.test(norm)) return true;
	if (/\bsabores?\s+(de\s+)?(mojito|piscola|sangria)\b/.test(norm)) return true;
	return false;
}

/**
 * asksAvailableCocktailsList: ¿Pregunta qué cócteles hay en general?
 * Ej.: "¿cuáles tienes?", "¿qué cócteles hay?", "¿qué sabores tienen?"
 * No aplica si ya nombra un cóctel concreto en el pedido (hasDrinkSelection).
 *
 * @param {string} messageText
 * @returns {boolean}
 */
export function asksAvailableCocktailsList(messageText) {
	const raw = String(messageText || '').trim();
	if (!raw) return false;
	const norm = normalizeString(raw);

	// Pregunta por sabores de una familia concreta → la maneja detectFlavorListRequest
	if (asksCocktailFlavorList(messageText)) {
		const catalogNames = Object.keys(preciosData.cocteles || {});
		for (const name of catalogNames) {
			const base = getProductFamilyBase(name);
			if (!base) continue;
			if (norm.includes(normalizeString(base)) && /\b(sabor|sabores|variedad|variedades)\b/.test(norm)) {
				return false;
			}
		}
	}

	const hasCatalogCue = /\b(coctel|cocteles|bebida|bebidas|tragos?|opciones|sabores?|variedades?|lista|catalogo|menu|disponibles?)\b/.test(norm);
	const hasAskCue = /\b(que|cual|cuales|cuantos|cuantas|tienen|tienes|hay|ofrecen|sirven|venden|disponible|disponibles|manejan|mostrar|muestrame|pasame|dame)\b/.test(norm)
		|| /\?/.test(raw);

	if (hasCatalogCue && hasAskCue) return true;

	// Corto y directo: "cuales tienes", "que hay", "cuales son", "lista", "disponibles"
	if (/^(cu[aá]les?|qu[eé])\s+(tienen|tienes|hay|ofrecen|sirven|venden|disponible|disponibles)\b/.test(norm)) return true;
	if (/^(cu[aá]les?|qu[eé])\s+(son\s+)?(los|las)\b/.test(norm)
		&& !/\b(personas|invitados|formatos?|servicios?|precios?|fechas?|horas?|dias?|d[ií]as)\b/.test(norm)) {
		return true;
	}
	if (/^(la\s+)?lista\b/.test(norm) || /^disponibles?\b/.test(norm)) return true;
	if (/\bcual\s+es\s+la\s+lista\b/.test(norm)) return true;

	return false;
}

/**
 * getCatalogFamilyFlavorOptions: Variantes de una familia en el catálogo.
 * Incluye el clásico ("Mojito") y sabores ("Mojito Maracuyá", …).
 *
 * @param {string} familyBase - Ej. "Mojito"
 * @param {string[]} catalogNames
 * @returns {string[]}
 */
export function getCatalogFamilyFlavorOptions(familyBase, catalogNames) {
	const fb = normalizeString(familyBase);
	if (!fb) return [];
	return (catalogNames || []).filter((name) => {
		const nn = normalizeString(name);
		if (nn === fb) return true;
		if (!nn.startsWith(`${fb} `)) return false;
		// En carta de eventos/barriles con alcohol no listamos mocktails salvo que pregunten eso
		if (/\bmocktail\b/i.test(name)) return false;
		return true;
	});
}

// ==============================================================================
// SIN ALCOHOL (MOCKTAILS): detección de intención + mapeo a la carta sin alcohol
// ==============================================================================

/**
 * isMocktailName: ¿Este nombre del catálogo es una versión Mocktail (sin alcohol)?
 * Todas las versiones sin alcohol de datos.json llevan la palabra "Mocktail" en el nombre
 * (categoría MOCKTAILS). Lo usan los estados de productos para no ofrecer por error la
 * versión con alcohol cuando el cliente pidió "sin alcohol".
 *
 * @param {string} name - Nombre del catálogo
 * @returns {boolean}
 */
export function isMocktailName(name) {
	return /\bmocktail\b/i.test(String(name || ''));
}

/**
 * wantsNonAlcoholicOption: ¿El cliente pide una opción SIN ALCOHOL (Mocktail)?
 * Cubre variantes del mismo patrón (no un string puntual): "sin alcohol", "no alcohólico",
 * "cero alcohol", "0% alcohol", "libre de alcohol", "no tiene/lleva/quiero alcohol", o
 * directamente "mocktail(s)". Exige la palabra "alcohol"/"alcohólico" (o "mocktail")
 * explícita: así "sin problema" o "sin duda" nunca activan esta rama.
 *
 * @param {string} text - Mensaje del cliente
 * @returns {boolean}
 */
export function wantsNonAlcoholicOption(text) {
	const norm = normalizeString(text);
	if (!norm) return false;
	if (/\bmocktail(s)?\b/.test(norm)) return true;
	if (!/\balcoholic[oa]s?\b|\balcohol\b/.test(norm)) return false;
	return /\b(sin|cero|libre\s+de|no|0)\b/.test(norm);
}

/**
 * getMocktailFamilyOptions: Versiones sin alcohol (Mocktail) relacionadas a un cóctel dado.
 * Ej. "Mojito" → [Mojito Mocktail, Mojito Maracuyá Mocktail, Mojito Frambuesa Mocktail, ...].
 * Si el cóctel no tiene familia conocida (Aperol Spritz, Piscola, etc.) intenta una
 * coincidencia directa "<nombre> Mocktail" antes de rendirse (deja la puerta abierta a
 * futuros sabores sin tener que tocar esta función).
 *
 * @param {string} cocktailName - Nombre del catálogo (con o sin alcohol)
 * @param {string[]} [catalogNames] - Por defecto, todo el catálogo de datos.json
 * @returns {string[]} Nombres exactos del catálogo (Mocktail), puede ser []
 */
export function getMocktailFamilyOptions(cocktailName, catalogNames) {
	const names = catalogNames || Object.keys(preciosData.cocteles || {});
	const family = getProductFamilyBase(cocktailName);
	if (family) {
		const fb = normalizeString(family);
		return names.filter((n) => {
			if (!isMocktailName(n)) return false;
			const nn = normalizeString(n);
			return nn === fb || nn.startsWith(`${fb} `);
		});
	}
	const direct = `${normalizeString(cocktailName)} mocktail`;
	const hit = names.find((n) => normalizeString(n) === direct);
	return hit ? [hit] : [];
}

/**
 * getAllMocktailNames: Todos los cócteles Mocktail (sin alcohol) del catálogo.
 * Sirve como catálogo general cuando el cliente pide "sin alcohol" sin relacionarse
 * a ningún sabor concreto (carrito vacío / sin sabor mencionado en el mismo mensaje).
 *
 * @param {string[]} [catalogNames] - Por defecto, todo el catálogo de datos.json
 * @returns {string[]}
 */
export function getAllMocktailNames(catalogNames) {
	const names = catalogNames || Object.keys(preciosData.cocteles || {});
	return names.filter((n) => isMocktailName(n));
}

/**
 * detectFlavorListRequest: Si el cliente pregunta por sabores de una familia, arma la lista.
 *
 * @param {string} messageText
 * @param {string[]} catalogNames
 * @returns {{ family: string, opciones: string[] }|null}
 */
export function detectFlavorListRequest(messageText, catalogNames) {
	if (!asksCocktailFlavorList(messageText)) return null;
	const norm = normalizeString(messageText);
	const names = catalogNames || Object.keys(preciosData.cocteles || {});

	/** @type {Map<string, string>} normFamily → label canónico */
	const families = new Map();
	for (const name of names) {
		const base = getProductFamilyBase(name);
		if (!base) continue;
		families.set(normalizeString(base), base);
	}

	for (const [normFamily, label] of families.entries()) {
		if (!norm.includes(normFamily)) continue;
		const opciones = getCatalogFamilyFlavorOptions(label, names);
		if (opciones.length >= 2) return { family: label, opciones };
	}

	return null;
}

export function resolveDoubtsProgrammatically(dudas, lastBotMessage = '') {
	const resolved = [];
	const remaining = [];

	// Opciones que el bot listó como *elección* (no líneas del carrito con precio/litros)
	const botOfferedOptions = [];
	if (lastBotMessage) {
		const lines = String(lastBotMessage).split('\n');
		for (const line of lines) {
			if (isBotCartOrPriceLine(line)) continue;
			const m = line.match(/^\s*[-•]\s*([A-Za-záéíóúÁÉÍÓÚñÑ0-9°º\s]+)/);
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
		// Las líneas del carrito / precios no son un menú de elección
		if (isBotCartOrPriceLine(line)) continue;
		const m = line.match(/^\s*[-•]\s*([A-Za-záéíóúÁÉÍÓÚñÑ0-9°º\s]+)/);
		if (m && m[1]) {
			botOfferedOptions.push(m[1].trim());
		}
	}
	// Con menos de dos alternativas no hay elección real que interceptar.
	if (botOfferedOptions.length < 2) return null;

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

/**
 * Tokens genéricos de categoría: NO son un cóctel concreto.
 * Si el cliente dice solo "mocktails" / "spritz", no debemos mapear al primer
 * "Mojito Mocktail" o "Aperol Spritz" del catálogo (rompe la carta de Mocktails).
 */
const GENERIC_CATALOG_QUERY_TOKENS = new Set(['mocktail', 'mocktails', 'spritz', 'sour']);

/**
 * findClosestCatalogMatch: Mapea un nombre (a menudo mal escrito) al catálogo oficial.
 * Cubre typos e incompletos: "ramazzoti"/"ramazoti" → Ramazzotti Spritz,
 * "margarita" → Tequila Margarita, "monito" → Mojito.
 *
 * @param {string} name - Texto que escribió el cliente (o name de la IA)
 * @param {string[]} catalogNames - Nombres oficiales
 * @returns {string|null} Nombre exacto del catálogo o null
 */
export function findClosestCatalogMatch(name, catalogNames) {
	if (!name) return null;

	const cleanName = (str) => normalizeString(str)
		.replace(/[¿?¡!.,;:…'"()]+/g, ' ')
		.replace(/\b(clasico|clasica|tradicional|original|sabores|sabor)\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();

	const normName = cleanName(name) || normalizeString(name).replace(/[¿?¡!.,;:…'"()]+/g, '').trim();
	const cleanedNormName = cleanName(name);

	// "sour" suelto → Pisco Sour (único con sour en catálogo)
	if (cleanedNormName === 'sour' || normName === 'sour') {
		const sourHits = catalogNames.filter((c) => /\bsour\b/i.test(c));
		if (sourHits.length === 1) return sourHits[0];
	}

	// Categoría suelta ("mocktails", "spritz") ≠ un ítem del catálogo
	if (GENERIC_CATALOG_QUERY_TOKENS.has(cleanedNormName) || GENERIC_CATALOG_QUERY_TOKENS.has(normName)) {
		return null;
	}

	// 1) Match exacto con o sin palabras descriptivas de relleno
	let bestMatch = catalogNames.find((c) => {
		const normC = normalizeString(c);
		return normC === normName || normC === cleanedNormName;
	});
	if (bestMatch) return bestMatch;

	// 2) Palabra clave: "aperol" → Aperol Spritz, "margarita" → Tequila Margarita.
	// NO substring dentro de otra palabra ("pero" ≠ Aperol).
	bestMatch = catalogNames.find((c) => {
		if (!cleanedNormName) return false;
		const cleanedC = cleanName(c);
		const cWords = cleanedC.split(/\s+/).filter(Boolean);
		const nWords = cleanedNormName.split(/\s+/).filter(Boolean);
		if (nWords.length === 1) {
			const t = nWords[0];
			return cWords.some((w) => w === t
				|| (t.length >= 4 && w.startsWith(t))
				|| (w.length >= 4 && t.startsWith(w)));
		}
		return cleanedC.includes(cleanedNormName) || cleanedNormName.includes(cleanedC);
	});
	if (bestMatch) return bestMatch;

	// 3) Levenshtein: nombre completo Y tokens distintivos (≥4 letras).
	// Sin tokens, "ramazzoti" no alcanza a "ramazzotti spritz" (demasiado largo).
	let minDistance = Infinity;
	let closest = null;
	const target = cleanedNormName || normName;
	if (!target || target.length < 3) return null;

	for (const catalogName of catalogNames) {
		const normCatalog = cleanName(catalogName) || normalizeString(catalogName);
		const candidates = [
			normCatalog,
			...normCatalog.split(/\s+/).filter((w) => w.length >= 4)
		];

		for (const candidate of candidates) {
			const dist = getLevenshteinDistance(target, candidate);
			// Palabras cortas: "pero" vs "aperol" dist=2 no debe colar
			const threshold = target.length <= 4
				? 1
				: Math.max(2, Math.floor(candidate.length * 0.35));
			if (dist <= threshold && dist < minDistance) {
				minDistance = dist;
				closest = catalogName;
			}
		}
	}

	return closest;
}
