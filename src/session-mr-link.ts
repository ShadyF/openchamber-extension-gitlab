import type { JsonValue } from '@openchamber/sdk';
import { GITLAB_VARIANT_ID } from './gitlab.js';

export type SessionMergeRequestIdentity = {
  v: 1;
  variant: string;
  accountId: number;
  projectId: number;
  iid: number;
  mergeRequestId: number;
  webUrl: string;
};

export type SessionMergeRequestItem = {
  id: string;
  data: JsonValue;
};

export type SessionMergeRequestClassification =
  | { kind: 'unrelated' }
  | { kind: 'blocked' }
  | { kind: 'valid'; identity: SessionMergeRequestIdentity };

export type SessionMergeRequestExpectation = {
  accountId: number;
  variant: string;
  projectId: number;
};

const ITEM_PREFIX = `${GITLAB_VARIANT_ID}:merge_request`;

// Accept only positive safe integers for stable GitLab identities.
function isStableId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Reject credentials and non-HTTPS values, then keep the canonical URL for exact API comparison.
function canonicalWebUrl(value: unknown, expectedIid: unknown): string | null {
  // Require a stable merge-request number before inspecting the URL.
  if (typeof value !== 'string' || !isStableId(expectedIid)) return null;

  // Keep only HTTPS URLs with no embedded credentials and a matching MR route.
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname
      || !parsed.pathname.endsWith(`/-/merge_requests/${expectedIid}`)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// Format one validated identity using the extension-owned, versioned item convention.
export function formatSessionMergeRequestItem(identity: SessionMergeRequestIdentity): SessionMergeRequestItem {
  const webUrl = canonicalWebUrl(identity.webUrl, identity.iid);
  // Refuse unsupported or incomplete identities before creating a durable snapshot item.
  if (identity.v !== 1 || identity.variant !== GITLAB_VARIANT_ID
    || !isStableId(identity.accountId) || !isStableId(identity.projectId)
    || !isStableId(identity.iid) || !isStableId(identity.mergeRequestId) || !webUrl) {
    throw new TypeError('Invalid session merge-request identity.');
  }

  // Emit only the versioned fields owned by this extension.
  return {
    id: `${GITLAB_VARIANT_ID}:merge_request:${identity.accountId}:${identity.projectId}:${identity.iid}`,
    data: {
      v: 1,
      variant: GITLAB_VARIANT_ID,
      accountId: identity.accountId,
      projectId: identity.projectId,
      iid: identity.iid,
      mergeRequestId: identity.mergeRequestId,
      webUrl,
    },
  };
}

// Parse only exact extension IDs and metadata that agree with the active GitLab scope.
export function classifySessionMergeRequestItem(
  item: { id: string; data?: JsonValue },
  expected: SessionMergeRequestExpectation,
): SessionMergeRequestClassification {
  // Leave other providers' session items for their own extension handlers.
  if (!item.id.startsWith(ITEM_PREFIX)) return { kind: 'unrelated' };

  // Require the exact ID structure and a JSON object before reading identity fields.
  const idMatch = /^gitlab-self-managed:merge_request:(\d+):(\d+):(\d+)$/.exec(item.id);
  const data = item.data;
  if (!idMatch || typeof data !== 'object' || data === null || Array.isArray(data)) return { kind: 'blocked' };

  const fields = data as Record<string, JsonValue>;
  const accountId = Number(idMatch[1]);
  const projectId = Number(idMatch[2]);
  const iid = Number(idMatch[3]);
  const webUrl = canonicalWebUrl(fields.webUrl, fields.iid);
  // Block any version, scope, URL, or stable identity disagreement.
  if (fields.v !== 1 || fields.variant !== expected.variant
    || expected.variant !== GITLAB_VARIANT_ID
    || !isStableId(expected.accountId) || !isStableId(expected.projectId)
    || !isStableId(accountId) || !isStableId(projectId) || !isStableId(iid)
    || String(accountId) !== idMatch[1] || String(projectId) !== idMatch[2] || String(iid) !== idMatch[3]
    || !isStableId(fields.accountId) || !isStableId(fields.projectId)
    || !isStableId(fields.iid) || !isStableId(fields.mergeRequestId)
    || accountId !== expected.accountId || projectId !== expected.projectId
    || fields.accountId !== accountId || fields.projectId !== projectId || fields.iid !== iid || !webUrl) {
    return { kind: 'blocked' };
  }

  // Return only verified identity data, never untrusted display text.
  return {
    kind: 'valid',
    identity: {
      v: 1,
      variant: GITLAB_VARIANT_ID,
      accountId,
      projectId,
      iid,
      mergeRequestId: fields.mergeRequestId,
      webUrl,
    },
  };
}
