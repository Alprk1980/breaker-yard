// Module hooks so plain Node can load the game's TypeScript sources, which are written
// for a bundler: extensionless relative imports get `.ts`, and JSON imports (no import
// attribute) are served as ES modules. Registered by tools/register-ts.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw e;
  }
}

export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    const json = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${json};`, shortCircuit: true };
  }
  return next(url, context);
}
