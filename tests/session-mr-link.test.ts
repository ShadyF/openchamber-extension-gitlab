import { describe, expect, it } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';
import { classifySessionMergeRequestItem, formatSessionMergeRequestItem, type SessionMergeRequestIdentity } from '../src/session-mr-link.js';
import { GITLAB_VARIANT_ID } from '../src/gitlab.js';

const identity: SessionMergeRequestIdentity = {
  v: 1,
  variant: GITLAB_VARIANT_ID,
  accountId: 73,
  projectId: 812,
  iid: 39,
  mergeRequestId: 1901,
  webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39',
};

const expected = { accountId: 73, variant: GITLAB_VARIANT_ID, projectId: 812 };

// Keep arbitrary snapshot data behind the public JSON value shape used by the host SDK.
function withData(overrides: Record<string, unknown>): JsonValue {
  return { ...identity, ...overrides } as JsonValue;
}

// Build a snapshot item while allowing independent ID and metadata mismatch cases.
function item(id = 'gitlab-self-managed:merge_request:73:812:39', data: JsonValue = { ...identity }): { id: string; data: JsonValue } {
  return { id, data };
}

describe('session merge-request link convention', () => {
  // Ensure future producers and verifiers agree on the stable versioned shape.
  it('formats and classifies a matching identity', () => {
    const formatted = formatSessionMergeRequestItem(identity);

    expect(formatted).toEqual({
      id: 'gitlab-self-managed:merge_request:73:812:39',
      data: identity,
    });
    expect(classifySessionMergeRequestItem(formatted, expected)).toEqual({ kind: 'valid', identity });
  });

  // Block any relevant item whose declared scope or fresh-detail identity may conflict.
  it('blocks wrong scope, item identity, stable ID, and URL values', () => {
    const mismatches = [
      { data: withData({ accountId: 74 }) },
      { data: withData({ variant: 'gitlab-other' }) },
      { data: withData({ projectId: 813 }) },
      { data: withData({ iid: 40 }) },
      { id: 'gitlab-self-managed:merge_request:73:812:40' },
      { data: withData({ mergeRequestId: 0 }) },
      { data: withData({ accountId: Number.MAX_SAFE_INTEGER + 1 }) },
      { data: withData({ webUrl: 'http://gitlab.example.com/mr/39' }) },
      { data: withData({ webUrl: 'https://maya:secret@gitlab.example.com/mr/39' }) },
      { data: withData({ webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/40' }) },
    ];

    for (const mismatch of mismatches) {
      const candidate = item(mismatch.id, mismatch.data ?? { ...identity });
      expect(classifySessionMergeRequestItem(candidate, expected).kind).toBe('blocked');
    }
  });

  // Keep unsupported versions and malformed extension IDs relevant so they suppress inference.
  it('blocks malformed or unsupported relevant items without exposing provider data', () => {
    const secretProviderValue = 'https://maya:do-not-render@gitlab.example.com/private/mr';
    const malformedItems = [
      item('gitlab-self-managed:merge_request'),
      item('gitlab-self-managed:merge_request:not-an-id:812:39'),
      item('gitlab-self-managed:merge_request:073:812:39'),
      item('gitlab-self-managed:merge_request:73:812:39', withData({ v: 2 })),
      item('gitlab-self-managed:merge_request:73:812:39', withData({ webUrl: secretProviderValue })),
      { id: 'gitlab-self-managed:merge_request:73:812:39' },
    ];

    for (const candidate of malformedItems) {
      const classification = classifySessionMergeRequestItem(candidate, expected);
      expect(classification.kind).toBe('blocked');
      expect(JSON.stringify(classification)).not.toContain(secretProviderValue);
    }
  });

  // Leave other providers' items untouched and let the session coordinator handle duplicate links.
  it('keeps other-provider items unrelated and classifies duplicates independently', () => {
    const unrelated = classifySessionMergeRequestItem({
      id: 'github:pull_request:73:812:39',
      data: { url: 'https://github.example.test/pull/39' },
    }, expected);
    const first = classifySessionMergeRequestItem(item(), expected);
    const second = classifySessionMergeRequestItem(item(), expected);

    expect(unrelated).toEqual({ kind: 'unrelated' });
    expect(first.kind).toBe('valid');
    expect(second.kind).toBe('valid');
  });
});
