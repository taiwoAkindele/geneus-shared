/** Server-only input boundary: caller supplies ACCEPTED records, excluding local/pending/refused proposals. */
import type { Staff } from './documents.ts';
import type { AuthoritySnapshot, CapabilityDecision, ClinicalAuthorityBootstrap, Credential, ReviewerDelegation } from './facility.ts';
import { currentFacilityRevisions, effectiveFacilityRevisions } from './facilityValidation.ts';
import { credentialSupportsInterval } from './facilityAuthorization.ts';
import { intervalContains } from './facilityTypes.ts';

export const projectClinicalAuthority = (staff: Staff, input: {
  decisions: readonly CapabilityDecision[]; credentials: readonly Credential[];
  delegations: readonly ReviewerDelegation[]; bootstraps: readonly ClinicalAuthorityBootstrap[];
}, now: number): Pick<AuthoritySnapshot, 'grants' | 'reviewScopes' | 'sourceDecisionIds' | 'expiresOn'> => {
  if (!Number.isFinite(now)) throw new Error('Projection requires trusted finite server time');
  const expires = [now + 7 * 24 * 60 * 60 * 1000];
  const grants: AuthoritySnapshot['grants'] = [], reviewScopes: AuthoritySnapshot['reviewScopes'] = [], sourceDecisionIds: string[] = [];
  const decisions = input.decisions.filter((d) => d.staffId === staff.staffId && d.facilityId === staff.facilityId);
  const credentialHeads = currentFacilityRevisions(input.credentials.filter((c) => c.staffId === staff.staffId && c.facilityId === staff.facilityId));
  const delegations = input.delegations.filter((d) => d.staffId === staff.staffId && d.facilityId === staff.facilityId);
  const bootstraps = input.bootstraps.filter((b) => b.staffId === staff.staffId && b.facilityId === staff.facilityId);
  const forked = <T extends CapabilityDecision | ClinicalAuthorityBootstrap | ReviewerDelegation>(rows: readonly T[], key: (r: T) => string) => {
    const counts = new Map<string, number>(); for (const r of currentFacilityRevisions(rows)) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
  };
  const capabilityForks = forked(decisions, (d) => d.capabilityId), reviewerForks = forked(delegations, (d) => d.delegationId);
  const bootstrapForks = forked(bootstraps, (b) => b.bootstrapId);
  const boundedEnd = (end: string | undefined, changes: readonly { startsAt: string }[]) => {
    const next = changes.map((r) => Date.parse(r.startsAt)).filter((at) => at > now);
    const until = Math.min(end ? Date.parse(end) : Infinity, ...next);
    return Number.isFinite(until) ? new Date(until).toISOString() : undefined;
  };
  for (const r of [...decisions, ...delegations, ...bootstraps]) if (Date.parse(r.startsAt) > now) expires.push(Date.parse(r.startsAt));
  if (staff.active && staff.permission === 'read_write') {
    for (const d of effectiveFacilityRevisions(decisions, now)) {
      if (capabilityForks.has(d.capabilityId) || !['approve', 'restrict'].includes(d.decision) || !intervalContains(d, now)) continue;
      const evidence = d.credentialRevisionIds.map((id) => input.credentials.find((c) => c.id === id && c.facilityId === staff.facilityId && c.staffId === staff.staffId));
      if (!evidence.length || evidence.some((c) => !c || !credentialSupportsInterval(c, d)
        || credentialHeads.filter((r) => r.credentialId === c.credentialId).length !== 1 || !credentialHeads.some((r) => r.id === c.id))) continue;
      grants.push({ capabilityId: d.capabilityId, decisionId: d.id, scope: d.scope, startsAt: d.startsAt,
        endsAt: boundedEnd(d.endsAt, decisions.filter((r) => r.capabilityId === d.capabilityId)), supervisorId: d.supervisorId, independentCheck: d.independentCheck });
      sourceDecisionIds.push(d.id); if (d.endsAt) expires.push(Date.parse(d.endsAt));
    }
    for (const d of effectiveFacilityRevisions(delegations, now)) {
      if (reviewerForks.has(d.delegationId) || d.decision !== 'approve' || !intervalContains(d, now)) continue;
      for (const scope of d.scopes) reviewScopes.push({ decisionId: d.id, scope, startsAt: d.startsAt, endsAt: boundedEnd(d.endsAt, delegations.filter((r) => r.delegationId === d.delegationId)) });
      sourceDecisionIds.push(d.id); if (d.endsAt) expires.push(Date.parse(d.endsAt));
    }
    for (const b of effectiveFacilityRevisions(bootstraps, now).filter((b) => !bootstrapForks.has(b.bootstrapId) && b.decision === 'approve' && intervalContains(b, now))) {
      for (const scope of b.scopes) reviewScopes.push({ decisionId: b.id, scope, startsAt: b.startsAt, endsAt: boundedEnd(b.endsAt, bootstraps.filter((r) => r.bootstrapId === b.bootstrapId)) });
      sourceDecisionIds.push(b.id); if (b.endsAt) expires.push(Date.parse(b.endsAt));
    }
  }
  return { grants, reviewScopes, sourceDecisionIds: [...new Set(sourceDecisionIds)].sort(), expiresOn: new Date(Math.min(...expires)).toISOString() };
};
