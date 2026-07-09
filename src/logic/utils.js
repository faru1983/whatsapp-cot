// ==============================================================================
// OBJETIVO: Caja de Herramientas y Seguridad (Helpers).
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ==============================================================================
// BASE DE DATOS GENERAL (datos.json)
// ==============================================================================
const preciosPath = path.join(process.cwd(), 'db', 'datos.json');
export let preciosData = {};

try {
	if (fs.existsSync(preciosPath)) {
		preciosData = JSON.parse(fs.readFileSync(preciosPath, 'utf8'));
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

export function getCartaCocteles(format = 'desechable') {
	const cats = getCoctelesByCategoria();

	const formatItem = (c) => {
		if (format === 'desechable') {
			const price = c.desechable?.['5L'] || 0;
			return `- ${c.name}: ${formatPrice(price)}`;
		}

		const formatPrices = c[format];
		if (!formatPrices || Object.keys(formatPrices).length === 0) {
			return null;
		}

		const priceStrings = Object.entries(formatPrices)
			.map(([litraje, price]) => `${litraje} (${formatPrice(price)})`)
			.join(' / ');

		return `- ${c.name}: ${priceStrings}`;
	};

	const clasicosStr = cats['CLÁSICOS'].map(formatItem).filter(Boolean).join('\n');
	const combinadosStr = cats.COMBINADOS.map(formatItem).filter(Boolean).join('\n');
	const mocktailsStr = cats.MOCKTAILS.map(formatItem).filter(Boolean).join('\n');

	let text = `🍸 *CLÁSICOS*\n${clasicosStr}`;
	text += `\n\n🥃 *COMBINADOS*\n${combinadosStr}`;
	text += `\n\n🍹 *MOCKTAILS (Sin Alcohol)*\n${mocktailsStr}`;

	if (format === 'desechable') {
		text += '\n\n¿Cuál o cuáles de la lista quieres agregar a tu cotización? (ej: "2 mojitos y 1 aperol")';
	} else {
		text += '\n\n¿Ahora índicame cuáles te gustarían, por ej. 5L Mojito, 10L Aperol Spritz?';
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
 * parseEventElimination: Igual que parseElimination, pero para el carrito de eventos
 * donde cada ítem es { "Mojito::10L": { name, quantity, litrage } }.
 * Si el cliente dice "quita el mojito" y hay varios litrajes, elimina el primero que coincida.
 *
 * @param {string} text - Mensaje del cliente
 * @param {object} currentItems - Carrito de eventos con claves name::litrage
 * @returns {{ key: string, name: string, litrage: string, newQty: number }|null}
 */
export function parseEventElimination(text, currentItems) {
	const eliminationWords = text.match(/\b(elimina|borra|quita|saca|quiero quitar|quiero sacar)\b/gi);
	if (!eliminationWords || Object.keys(currentItems).length === 0) return null;

	const eliminationPattern = /\b(elimina|borra|quita|saca)\s+(\d+)?\s*(?:el\s+|los\s+|las\s+)?([A-Za-záéíóúÁÉÍÓÚñÑ0-9\s]+)/i;
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
			console.log(`[DEBUG-DOUBT] Resolviendo duda "${mencionado}" programáticamente a: "${resolvedOption.opcion}"`);
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
