import { readFile } from 'node:fs/promises';
import { compareOpenChamberVersions, openChamberEngineMinimum } from '@openchamber/sdk';
import { parseManifest } from '@openchamber/sdk/schemas';

// Accept only HTTPS origins with an optional port and no user info, path, query, or fragment.
export function isSafeBareHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value)) return false;

  const match = /^https:\/\/(?:\[[0-9a-f:.]+\]|[^:/?#@\\%]+)(?::([0-9]{1,5}))?\/?$/i.exec(value);
  if (!match || (match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65535))) return false;

  try {
    const origin = new URL(value);
    return origin.protocol === 'https:'
      && Boolean(origin.hostname)
      && !origin.username
      && !origin.password
      && origin.pathname === '/'
      && !origin.search
      && !origin.hash;
  } catch {
    return false;
  }
}

// Reject engine floors that would claim unverified OpenChamber 2.0 web and desktop support.
export function requiresUnverifiedOpenChamberTwo(engine: string | undefined): boolean {
  if (!engine) return false;
  const minimum = openChamberEngineMinimum(engine);
  return minimum === null || compareOpenChamberVersions(minimum, '2.0.0') >= 0;
}

// Validate the manifest and files OpenChamber loads before the package is shipped.
export async function validatePackage(): Promise<void> {
  const packageText = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const packageDocument: unknown = JSON.parse(packageText);
  const result = parseManifest(packageDocument as Parameters<typeof parseManifest>[0]);
  if (!result.ok) throw new Error(`Invalid OpenChamber manifest: ${result.code}`);
  if (!result.version) throw new Error('OpenChamber packages must declare a valid semver version.');

  // Check the visible entry and its local assets before accepting the built package.
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  if (!html.includes('<script src="./main.js"></script>')) throw new Error('Panel entry must load the built classic ./main.js script.');
  if (!html.includes('<link rel="stylesheet" href="./styles.css" />')) throw new Error('Panel entry must load its local stylesheet.');
  await readFile(new URL('../panel/styles.css', import.meta.url), 'utf8');
  const bundle = await readFile(new URL('../panel/main.js', import.meta.url), 'utf8');
  if (!/^\s*\(\s*\(\s*\)\s*=>\s*\{/.test(bundle) || /^\s*(?:import|export)\s/m.test(bundle)) {
    throw new Error('Panel bundle must be a classic IIFE without module imports or exports.');
  }

  // Allow the safe placeholder or an actual bare HTTPS origin, but reject unsafe host paths and engine claims.
  const openChamber = (packageDocument as {
    openchamber?: {
      contributes?: { integration?: { token?: { apiOrigin?: string; scheme?: string } } };
      engines?: { openchamber?: string };
    };
  }).openchamber;
  const token = openChamber?.contributes?.integration?.token;
  if (!isSafeBareHttpsOrigin(token?.apiOrigin) || token.scheme !== 'bearer') {
    throw new Error('The GitLab integration must use a bare HTTPS origin and bearer token scheme.');
  }
  if (requiresUnverifiedOpenChamberTwo(openChamber?.engines?.openchamber)) {
    throw new Error('Do not require OpenChamber 2.0.0 or newer until web and desktop support are verified.');
  }

  console.log('OpenChamber manifest and panel package files are valid.');
}

// Run validation only when the file is executed as the package-check command.
if (import.meta.main) await validatePackage();
