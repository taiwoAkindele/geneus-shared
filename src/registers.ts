import type { RegisterDefinition } from './documents.ts';

/** Definition invariants used before local persistence and at the upload boundary. */
export const registerDefinitionIssues = (definition: Pick<RegisterDefinition, 'name' | 'category' | 'fields' | 'status'>, previous: readonly RegisterDefinition[] = []): string[] => {
  const issues: string[] = [];
  if (!definition.name.trim()) issues.push('Give this register a name.');
  if (!definition.category.trim()) issues.push('Choose a register category.');
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
    if (definition.status === 'published' && ['select', 'multiselect'].includes(field.type)) {
      const choices = field.options ?? [];
      if (!choices.length || choices.some((choice) => !choice.trim())) issues.push(`Add non-empty choices for "${field.label}".`);
      if (new Set(choices.map((choice) => choice.trim().toLowerCase())).size !== choices.length) issues.push(`Remove duplicate choices from "${field.label}".`);
    }
  }
  if (definition.status === 'published' && !definition.fields.some((field) => field.type !== 'section')) issues.push('Add at least one question before publishing.');
  return issues;
};
