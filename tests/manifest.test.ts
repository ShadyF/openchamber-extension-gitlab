import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { parseManifest } from '@openchamber/sdk/schemas';
import { isSafeBareHttpsOrigin, requiresUnverifiedOpenChamberTwo } from '../scripts/validate-package.js';
import { GITLAB_VARIANT_ID } from '../src/gitlab.js';

// Keep package validity tied to the official SDK parser and the integration security contract.
describe('OpenChamber package manifest', () => {
  // Require a unique panel ID, protected bearer token, and non-runnable HTTPS placeholder.
  it('uses a unique panel identity, protected bearer token, and safe HTTPS placeholder', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      openchamber: {
        apiVersion: 1;
        engines?: { openchamber?: string };
        contributes: {
          panel: { id: string; name: string; icon: string; entry: string };
          capabilities: string[];
          integration: {
            name: string;
            description: string;
            token: { apiOrigin: string; scheme: string; account: { path: string; name: string } };
          };
        };
      };
    };
    const manifest = parseManifest(packageJson as Parameters<typeof parseManifest>[0]);

    expect(manifest.ok).toBe(true);
    expect(packageJson.openchamber.apiVersion).toBe(1);
    expect(packageJson.openchamber.contributes.panel.id).toBe(GITLAB_VARIANT_ID);
    expect(packageJson.openchamber.contributes.panel.id).toBe('gitlab-self-managed');
    expect(packageJson.openchamber.contributes.panel.name).toBe('Self-Managed GitLab');
    expect(packageJson.openchamber.contributes.panel.entry).toBe('panel/index.html');
    expect(packageJson.openchamber.contributes.capabilities).toEqual(['sessions']);
    expect(packageJson.openchamber.contributes.integration.name).toBe('Self-Managed GitLab');
    expect(packageJson.openchamber.contributes.integration.description).toContain('self-managed GitLab instance');
    expect(packageJson.openchamber.contributes.integration.token).toEqual({
      apiOrigin: 'https://gitlab.invalid',
      scheme: 'bearer',
      account: { path: '/api/v4/user', name: 'username' },
    });
    expect(packageJson.openchamber.engines).toBeUndefined();
  });

  // Ensure the extension delegates authorization to the host instead of reading a token or calling fetch.
  it('uses only the host request bridge for GitLab API calls', async () => {
    const source = await readFile(new URL('../src/gitlab.ts', import.meta.url), 'utf8');

    expect(source).toContain('host.request(request)');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/settings\.token|connection\.token/);
  });

  // Permit actual bare HTTPS hosts while refusing credentials, paths, queries, fragments, and API mounts.
  it('validates bare HTTPS GitLab origins and keeps the placeholder valid', () => {
    expect(isSafeBareHttpsOrigin('https://gitlab.invalid')).toBe(true);
    expect(isSafeBareHttpsOrigin('https://gitlab.example.net:8443')).toBe(true);
    expect(isSafeBareHttpsOrigin('https://gitlab.example.net/')).toBe(true);

    for (const origin of [
      'http://gitlab.example.net',
      'https://user:password@gitlab.example.net',
      'https://gitlab.example.net/group',
      'https://gitlab.example.net/api/v4',
      'https://gitlab.example.net?token=secret',
      'https://gitlab.example.net#fragment',
      'https://gitlab.example.net:70000',
      'https://gitlab.example.net\\',
      'https://gitlab.example.net%2Fgroup',
    ]) {
      expect(isSafeBareHttpsOrigin(origin)).toBe(false);
    }
  });

  // Keep package metadata from claiming unverified OpenChamber 2.0 support.
  it('rejects only engine floors at or above unverified OpenChamber 2.0', () => {
    expect(requiresUnverifiedOpenChamberTwo(undefined)).toBe(false);
    expect(requiresUnverifiedOpenChamberTwo('>=1.24.0')).toBe(false);
    expect(requiresUnverifiedOpenChamberTwo('2.0.0')).toBe(true);
    expect(requiresUnverifiedOpenChamberTwo('>=2.0.0')).toBe(true);
  });
});
