/**
 * Care services: the broad kinds of care a hospital provides (outpatient
 * consultation, antenatal care, inpatient care). They are ordinary
 * service_offering records; lab tests are offerings too (for ordering and
 * pricing) but are never care services. One place decides which is which, so
 * booking, registration, worklists, reports and the server agree.
 */
import type { ServiceDefinition, ServiceOffering } from './facility.ts';
import type { VisitType } from './facilityTypes.ts';

type Definitions = readonly Pick<ServiceDefinition, 'id' | 'investigation'>[];
type Offering = Pick<ServiceOffering, 'id' | 'serviceDefinitionId' | 'configuration'> &
  Partial<Pick<ServiceOffering, 'visitTypes' | 'intakePolicy'>>;

/** A lab catalogue test: its definition carries investigation details. */
export const isLabTestOffering = (
  offering: Pick<ServiceOffering, 'serviceDefinitionId'>,
  definitions: Definitions = [],
) => Boolean(definitions.find((d) => d.id === offering.serviceDefinitionId)?.investigation);

/** Current care services (not lab tests, not retired). */
export const careServiceOfferings = <
  O extends Pick<ServiceOffering, 'serviceDefinitionId' | 'configuration'>,
>(
  offerings: readonly O[],
  definitions: Definitions = [],
) => offerings.filter((o) => o.configuration !== 'retired' && !isLabTestOffering(o, definitions));

/**
 * Active care services a patient can be booked or registered for: those that
 * record visits and accept this kind of arrival. Inpatient care (admission)
 * and other non-visit care never appear here.
 */
export const visitCareServices = <O extends Offering>(
  offerings: readonly O[],
  definitions: Definitions,
  arrival?: 'scheduled' | 'walk_in',
) =>
  careServiceOfferings(offerings, definitions).filter(
    (o) =>
      o.configuration === 'active' &&
      (o.visitTypes?.length ?? 0) > 0 &&
      (!arrival || !o.intakePolicy || o.intakePolicy === 'both' || o.intakePolicy === arrival),
  );

/** The visit kind a booking takes when none is chosen: the service's usual one. */
export const defaultVisitType = (
  offering: Pick<ServiceOffering, 'visitTypes'> | undefined,
): VisitType | undefined => offering?.visitTypes[0];

/**
 * Checks a booking's or visit's care service when it is created; the service
 * cannot be changed afterwards. On a device choosing now, the service must be
 * active. The server checks with `recorded: true`: care recorded offline is
 * never refused because the service was retired in the meantime.
 */
export const careServiceVisitIssues = (
  record: { facilityId: string; offeringId?: string; visitType?: VisitType },
  data: {
    offerings: readonly (Offering & { facilityId: string; name: string })[];
    definitions: Definitions;
  },
  options: { recorded?: boolean } = {},
): string[] => {
  if (!record.offeringId) {
    return [];
  }

  const offering = data.offerings.find(
    (o) => o.id === record.offeringId && o.facilityId === record.facilityId,
  );

  if (!offering || isLabTestOffering(offering, data.definitions)) {
    return ['Choose a care service of this hospital'];
  }

  if (!options.recorded && offering.configuration !== 'active') {
    return [`${offering.name} is not an active care service`];
  }

  const kinds = offering.visitTypes ?? [];

  if (!kinds.length) {
    return [`${offering.name} does not take booked or registered visits`];
  }

  if (record.visitType && !kinds.includes(record.visitType)) {
    return [`${offering.name} does not record this kind of visit`];
  }

  return [];
};
