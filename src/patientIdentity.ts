/** Calendar arithmetic is shared by registration validation, matching and billing. */
export const validCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const yearsBetween = (birth: string, on: string): number => {
  const [year, month, day] = birth.slice(0, 10).split('-').map(Number);
  const [endYear, endMonth, endDay] = on.slice(0, 10).split('-').map(Number);
  return endYear - year - Number(endMonth < month || (endMonth === month && endDay < day));
};

export const patientAge = (patient: { dateOfBirth?: string; ageYears?: number; ageObservedOn?: string; createdOn: string }, on = new Date().toISOString().slice(0, 10)): number | undefined => {
  if (patient.dateOfBirth) return Math.max(0, yearsBetween(patient.dateOfBirth, on));
  if (patient.ageYears === undefined) return undefined;
  return patient.ageYears + Math.max(0, yearsBetween(patient.ageObservedOn ?? patient.createdOn, on));
};

export type IdentityEvent = {
  id: string; patientId: string; otherPatientId?: string; revision?: number;
  outcome: 'existing_selected' | 'registration_distinct' | 'review_requested' | 'linked' | 'distinct' | 'unlinked';
};

/** Only server-confirmed events affect identity. Original records are never rewritten. */
export const activeIdentityLinks = (events: readonly IdentityEvent[]): Map<string, IdentityEvent> => {
  const links = new Map<string, IdentityEvent>();
  for (const event of [...events].filter((e) => e.revision !== undefined).sort((a, b) => a.revision! - b.revision!)) {
    if (!event.otherPatientId) continue;
    if (event.outcome === 'linked') links.set(event.otherPatientId, event);
    if (event.outcome === 'unlinked') links.delete(event.otherPatientId);
  }
  return links;
};

export const canonicalPatientId = (id: string, events: readonly IdentityEvent[]): string => {
  if (events.length === 0) return id;
  const links = activeIdentityLinks(events);
  const seen = new Set<string>();
  let current = id;
  while (links.has(current)) {
    if (seen.has(current)) throw new Error('Patient identity links contain a cycle; ask a records officer to review');
    seen.add(current);
    current = links.get(current)!.patientId;
  }
  return current;
};

export const linkedPatientIds = (id: string, events: readonly IdentityEvent[]): string[] => {
  const root = canonicalPatientId(id, events);
  const ids = new Set([root, id]);
  for (const alias of activeIdentityLinks(events).keys()) {
    if (canonicalPatientId(alias, events) === root) ids.add(alias);
  }
  return [...ids];
};
