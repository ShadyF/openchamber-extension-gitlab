import type { GitLabMergeRequest } from './gitlab.js';

export type RelatedMergeRequestDiscoveryResult =
  | { kind: 'related'; mergeRequest: GitLabMergeRequest }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'outside-project' }
  | { kind: 'incomplete' }
  | { kind: 'cancelled' };

export type DiscoverRelatedMergeRequestOptions = {
  issueProjectId: number;
  issueIid: number;
  targetProjectId: number;
  listPage: (issueProjectId: number, issueIid: number, page: number) => Promise<GitLabMergeRequest[]>;
  getDetail: (projectId: number, iid: number) => Promise<GitLabMergeRequest>;
  isCurrent: () => boolean;
};

const maxPages = 10;
const maxRowsPerPage = 50;

// Accept only complete, safe merge request rows from the injected adapter boundary.
function isMergeRequest(value: unknown): value is GitLabMergeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const row = value as Partial<GitLabMergeRequest>;
  let webUrl: URL;
  // Reject malformed links before the row can participate in an association.
  try {
    webUrl = new URL(row.webUrl ?? '');
  } catch {
    return false;
  }

  return Number.isSafeInteger(row.id) && (row.id ?? 0) > 0
    && Number.isSafeInteger(row.iid) && (row.iid ?? 0) > 0
    && Number.isSafeInteger(row.projectId) && (row.projectId ?? 0) > 0
    && row.targetProjectId === row.projectId
    && (row.sourceProjectId === null || (typeof row.sourceProjectId === 'number' && Number.isSafeInteger(row.sourceProjectId) && row.sourceProjectId > 0))
    && typeof row.title === 'string' && Boolean(row.title.trim())
    && typeof row.description === 'string'
    && (row.state === 'opened' || row.state === 'closed' || row.state === 'merged' || row.state === 'locked')
    && webUrl.protocol === 'https:' && !webUrl.username && !webUrl.password
    && typeof row.updatedAt === 'string' && Boolean(row.updatedAt.trim())
    && (row.sourceBranch === null || (typeof row.sourceBranch === 'string' && Boolean(row.sourceBranch.trim())))
    && (row.targetBranch === null || (typeof row.targetBranch === 'string' && Boolean(row.targetBranch.trim())));
}

// Compare provider identity and association fields that must stay stable across pages.
function sameAssociation(left: GitLabMergeRequest, right: GitLabMergeRequest): boolean {
  return left.id === right.id
    && left.iid === right.iid
    && left.projectId === right.projectId
    && left.targetProjectId === right.targetProjectId
    && left.webUrl === right.webUrl
    && left.state === right.state;
}

// Discover an issue association only after every bounded page proves a unique opened candidate.
export async function discoverRelatedMergeRequest(
  options: DiscoverRelatedMergeRequestOptions,
): Promise<RelatedMergeRequestDiscoveryResult> {
  const { issueProjectId, issueIid, targetProjectId, listPage, getDetail, isCurrent } = options;
  // Refuse invalid numeric identities before calling the injected adapter functions.
  if (!Number.isSafeInteger(issueProjectId) || issueProjectId <= 0
    || !Number.isSafeInteger(issueIid) || issueIid <= 0
    || !Number.isSafeInteger(targetProjectId) || targetProjectId <= 0) {
    return { kind: 'incomplete' };
  }

  const byId = new Map<number, GitLabMergeRequest>();
  const byProjectIid = new Map<string, GitLabMergeRequest>();

  // Read pages in order and require an empty page to prove that discovery is complete.
  for (let page = 1; page <= maxPages; page += 1) {
    if (!isCurrent()) return { kind: 'cancelled' };

    let rows: GitLabMergeRequest[];
    try {
      rows = await listPage(issueProjectId, issueIid, page);
    } catch (error) {
      if (!isCurrent()) return { kind: 'cancelled' };
      throw error;
    }
    if (!isCurrent()) return { kind: 'cancelled' };

    // Reject malformed pages as a whole so a partial result cannot appear unique.
    if (!Array.isArray(rows) || rows.length > maxRowsPerPage || !rows.every(isMergeRequest)) {
      return { kind: 'incomplete' };
    }
    if (rows.length === 0) {
      const opened = [...byId.values()].filter((row) => row.state === 'opened');
      if (opened.length === 0) return { kind: 'none' };
      if (opened.length > 1) return { kind: 'ambiguous' };
      const candidate = opened[0];
      if (candidate.projectId !== targetProjectId) return { kind: 'outside-project' };

      // Refresh the sole candidate and verify it still matches the discovered association.
      if (!isCurrent()) return { kind: 'cancelled' };
      let detail: GitLabMergeRequest;
      try {
        detail = await getDetail(candidate.projectId, candidate.iid);
      } catch (error) {
        if (!isCurrent()) return { kind: 'cancelled' };
        throw error;
      }
      if (!isCurrent()) return { kind: 'cancelled' };
      if (!isMergeRequest(detail) || !sameAssociation(candidate, detail) || detail.state !== 'opened') {
        return { kind: 'incomplete' };
      }

      return { kind: 'related', mergeRequest: detail };
    }

    // Coalesce exact repeated identities while rejecting conflicting provider records.
    for (const row of rows) {
      const identity = `${row.projectId}:${row.iid}`;
      const existingById = byId.get(row.id);
      const existingByProjectIid = byProjectIid.get(identity);
      if ((existingById && !sameAssociation(existingById, row))
        || (existingByProjectIid && !sameAssociation(existingByProjectIid, row))) {
        return { kind: 'ambiguous' };
      }
      byId.set(row.id, row);
      byProjectIid.set(identity, row);
    }
  }

  return { kind: 'incomplete' };
}
