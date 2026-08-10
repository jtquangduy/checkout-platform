import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildOpenApiDocument } from '../interface/http/openapi-document.js';

// Resolved relative to THIS file's own location (dist/scripts/ or src/
// under vitest), never process.cwd() — main.ts is sometimes launched from
// the repo root, sometimes from the service directory, and this must
// resolve to the same file either way.
const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, '../../openapi.generated.json');

writeFileSync(outputPath, JSON.stringify(buildOpenApiDocument(), null, 2));
console.log(`Wrote ${outputPath}`);
