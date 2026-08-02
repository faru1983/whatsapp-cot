// ==============================================================================
// OBJETIVO: Revisar sintaxis de todo el código fuente del bot (`node --check`).
// Antes esto vivía como un script gigante en package.json; Cursor/VS Code fallaba
// al detectar tareas npm por esa línea enorme. Uso: npm run check
// ==============================================================================
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/**
 * listSourceFiles: Recorre carpetas y junta todos los .js / .mjs.
 * Así no hay que editar package.json cada vez que agregamos un estado.
 *
 * @param {string} dir - Carpeta absoluta a inspeccionar
 * @param {string[]} out - Lista acumulada de rutas absolutas
 * @returns {string[]}
 */
function listSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Ignoramos dependencias y artefactos; solo queremos nuestro código
    if (name === 'node_modules' || name === 'auth' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * checkFile: Ejecuta `node --check` sobre un archivo.
 * Si Node encuentra un error de sintaxis, imprime el detalle y devolvemos false.
 *
 * @param {string} absolutePath
 * @returns {boolean} true si el archivo está bien
 */
function checkFile(absolutePath) {
  const result = spawnSync(process.execPath, ['--check', absolutePath], {
    encoding: 'utf8'
  });
  if (result.status === 0) return true;

  const rel = relative(ROOT, absolutePath);
  console.error(`FAIL: ${rel}`);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  return false;
}

const dirs = [join(ROOT, 'src'), join(ROOT, 'scripts')];
const files = dirs.flatMap((dir) => listSourceFiles(dir)).sort();

let failed = 0;
for (const file of files) {
  if (!checkFile(file)) failed += 1;
}

if (failed > 0) {
  console.error(`\nSyntax check: ${failed} archivo(s) con error de ${files.length}.`);
  process.exit(1);
}

console.log(`Syntax check OK (${files.length} archivos).`);
