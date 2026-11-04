import type { RegisterDefinition, RegisterEntry, VisitFact } from './documents.ts';

/** Facts that are lists, so a field can keep only the items mentioning chosen words. */
export const LIST_VISIT_FACTS: readonly VisitFact[] = ['complaints', 'diagnoses', 'tests', 'results', 'medicines_prescribed', 'medicines_dispensed'];

/** Definition invariants used before local persistence and at the upload boundary. */
export const registerDefinitionIssues = (definition: Pick<RegisterDefinition, 'name' | 'category' | 'fields' | 'status'> & Partial<Pick<RegisterDefinition, 'visitLink'>>, previous: readonly RegisterDefinition[] = []): string[] => {
  const issues: string[] = [];
  if (!definition.name.trim()) issues.push('Give this register a name.');
  if (!definition.category.trim()) issues.push('Choose a register category.');
  const link = definition.visitLink;
  if (link?.visits === 'matching' && !link.words.length && !link.codes.length) issues.push('Add the words or diagnosis codes that choose which visits fill this register.');
  const ids = new Set<string>();
  const published = previous.filter((version) => version.status === 'published');
  const latest = [...published].sort((a, b) => b.version - a.version)[0];
  for (const [index, field] of definition.fields.entries()) {
    if (!field.label.trim()) issues.push(`Give field ${index + 1} a label.`);
    if (ids.has(field.id)) issues.push('Each field needs a distinct identity.');
    ids.add(field.id);
    const earlier = previous.flatMap((version) => version.fields).find((candidate) => candidate.id === field.id);
    if (earlier && earlier.type !== field.type) issues.push(`"${field.label}" changed type. Add a new field instead of reusing its identity.`);
    if (published.some((version) => version.fields.some((candidate) => candidate.id === field.id)) && latest && !latest.fields.some((candidate) => candidate.id === field.id)) issues.push(`"${field.label}" reuses a removed field identity. Add a new field instead.`);
    if (field.fromVisit) {
      if (!link) issues.push(`"${field.label}" is filled from the visit. Choose which visits fill this register.`);
      if (field.type !== 'text' || field.required || field.options?.length) issues.push(`"${field.label}" is filled from the visit, so it is a short text field that staff are not asked for.`);
      if (field.fromVisit.words?.length && !LIST_VISIT_FACTS.includes(field.fromVisit.fact)) issues.push(`"${field.label}" can only narrow complaints, diagnoses, tests, results or medicines by words.`);
    }
    if (definition.status === 'published' && ['select', 'multiselect'].includes(field.type)) {
      const choices = field.options ?? [];
      if (!choices.length || choices.some((choice) => !choice.trim())) issues.push(`Add non-empty choices for "${field.label}".`);
      if (new Set(choices.map((choice) => choice.trim().toLowerCase())).size !== choices.length) issues.push(`Remove duplicate choices from "${field.label}".`);
    }
  }
  if (definition.status === 'published' && !definition.fields.some((field) => field.type !== 'section')) issues.push('Add at least one question before publishing.');
  return issues;
};

/**
 * An entry in a visit-linked register completes one visit's row with the fields
 * staff record; the visit supplies the rest. Other registers take no visit.
 */
export const registerEntryLinkIssues = (definition: Pick<RegisterDefinition, 'fields' | 'visitLink'>, entry: Pick<RegisterEntry, 'encounterId' | 'patientId' | 'values'>): string[] => {
  if (!definition.visitLink) return entry.encounterId ? ['This register is not filled from visits, so its entries do not name a visit.'] : [];
  const issues: string[] = [];
  if (!entry.encounterId || !entry.patientId) issues.push('This register fills from visits. Complete a visit\'s row from the register instead of adding a separate entry.');
  const fromVisit = new Set(definition.fields.filter((field) => field.fromVisit).map((field) => field.id));
  if (Object.keys(entry.values).some((id) => fromVisit.has(id))) issues.push('Fields filled from the visit are not recorded by staff.');
  return issues;
};
