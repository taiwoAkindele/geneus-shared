import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Appointment, AppointmentActivity } from '../src/documents.ts';
import { ROLE_PERMISSIONS } from '../src/permissions.ts';

const createdOn = '2026-10-26T08:00:00.000Z', recordedOn = '2026-10-26T09:00:00.000Z';
const booking = { id: 'booking:one', type: 'appointment', facilityId: 'TEST', deviceId: 'device:one', createdBy: 'staff:one', createdOn, patientId: 'TEST-000001-K2', reason: 'Consultation' };
const arrival = AppointmentActivity.parse({ id: 'action:one', action: 'arrived', fromAttendance: 'booked', toAttendance: 'arrived', recordedBy: 'staff:one', recordedOn });

describe('attributed appointment attendance', () => {
  it('keeps existing bookings valid and grants updates to front desk and clinical roles', () => {
    assert.equal(Appointment.parse(booking).attendance, undefined);
    for (const role of ['records_officer', 'nurse', 'doctor', 'facility_admin'] as const) assert.ok(ROLE_PERMISSIONS[role].includes('appointment:update'));
    assert.ok(!ROLE_PERMISSIONS.cashier.includes('appointment:update'));
  });
  it('requires matching history, distinct actions and reasons for consequential changes', () => {
    assert.ok(Appointment.safeParse({ ...booking, attendance: 'arrived', activity: [arrival] }).success);
    assert.ok(!Appointment.safeParse({ ...booking, attendance: 'arrived' }).success);
    assert.ok(!Appointment.safeParse({ ...booking, attendance: 'booked', activity: [arrival] }).success);
    assert.ok(!Appointment.safeParse({ ...booking, attendance: 'arrived', activity: [arrival, arrival] }).success);
    assert.ok(!Appointment.safeParse({ ...booking, attendance: 'cancelled', activity: [{ ...arrival, action: 'cancelled', toAttendance: 'cancelled' }] }).success);
  });
  it('retains old dates, requires future reschedules and prevents no-show after arrival', () => {
    const event = { ...arrival, action: 'rescheduled', toAttendance: 'booked', toScheduledFor: '2026-10-27T09:00:00.000Z', reason: 'Patient request' };
    assert.ok(Appointment.safeParse({ ...booking, status: 'scheduled', scheduledFor: event.toScheduledFor, attendance: 'booked', activity: [event] }).success);
    assert.ok(!Appointment.safeParse({ ...booking, scheduledFor: createdOn, activity: [{ ...event, toScheduledFor: createdOn }] }).success);
    const missed = { ...arrival, id: 'action:two', action: 'no_show', fromAttendance: 'arrived', toAttendance: 'no_show', reason: 'Incorrect' };
    assert.ok(!Appointment.safeParse({ ...booking, attendance: 'no_show', activity: [arrival, missed] }).success);
  });
});
