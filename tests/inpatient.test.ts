import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InpatientEvent, BedReadyEvent, inpatientIssues, inpatientHeads, activeAdmission, inpatientBedState, bedReadyIssues, usableInpatientEvents, wardForBed, type InpatientRecords } from '../src/inpatient.ts';
import { Encounter, EncounterEntry, Unit } from '../src/documents.ts';
import { Location } from '../src/facility.ts';
import { staffPermissions } from '../src/permissions.ts';
const base = { facilityId: 'TEST', schemaVersion: 5, createdBy: 'staff:doctor', deviceId: 'device:one', createdOn: '2026-10-31T09:00:00Z' };
const patientId = 'TEST-000001-K2';
const unit = Unit.parse({ ...base, id: 'unit:ward', type: 'unit', unitId: 'WARD', name: 'Ward team', active: true });
const location = (id: string, kind: 'ward' | 'room' | 'bed', parentId?: string) => Location.parse({ ...base, id, type: 'location', name: id, kind, parentId });
const ward = location('ward:a','ward'), room = location('room:a','room',ward.id), bed = location('bed:1','bed',room.id), bed2 = location('bed:2','bed',ward.id);
const encounter = Encounter.parse({ ...base, id: 'encounter:one', type: 'encounter', patientId, openedOn: base.createdOn });
const request = EncounterEntry.parse({ ...base, id: 'request:one', type: 'encounter_entry', patientId, encounterId: encounter.id, step: 'admission', actorRole: 'doctor', values: { ward: 'Ward A' } });
const initial = () => InpatientEvent.parse({ ...base, id: 'stay:one', type: 'inpatient_event', admissionId: 'stay:one', patientId, encounterId: encounter.id, requestEntryId: request.id, action: 'confirm', receivingUnitId: unit.id, actorRole: 'doctor' });
const next = (previous: InpatientEvent, action: InpatientEvent['action'], extra: Partial<InpatientEvent> = {}) => InpatientEvent.parse({ ...previous, id: `event:${action}:${Math.random()}`, previousId: previous.id, action, ...extra });
const records = (events: InpatientEvent[] = []): InpatientRecords => ({ events, ready: [], locations: [ward,room,bed,bed2], units: [unit], encounters: [encounter], entries: [request] });

describe('admission and ward contract', () => {
  it('confirms admission while awaiting a bed, independently of consultation completion', () => {
    const confirm = initial(); assert.deepEqual(inpatientIssues(confirm, records()), []);
    assert.equal(activeAdmission(confirm), true); assert.equal(inpatientBedState(bed.id, [confirm], []).status, 'Available');
  });
  it('separates bed reservation from physical arrival, including rooms within wards', () => {
    const confirm = initial(), reserve = next(confirm,'reserve',{ wardId: ward.id, bedId: bed.id });
    assert.equal(wardForBed(bed, records().locations)?.id,ward.id);
    assert.deepEqual(inpatientIssues(reserve, records([confirm])), []);
    assert.equal(inpatientBedState(bed.id,[confirm,reserve],[]).status,'Reserved');
    const arrive = next(reserve,'arrive'); assert.deepEqual(inpatientIssues(arrive,records([confirm,reserve])),[]);
    assert.equal(inpatientBedState(bed.id,[confirm,reserve,arrive],[]).status,'Occupied');
  });
  it('rejects double admission and stale/competing successors', () => {
    const confirm = initial();
    assert.match(inpatientIssues({ ...confirm,id:'other',admissionId:'other' },records([confirm]))[0],/handled/);
    const reserve = next(confirm,'reserve',{ wardId: ward.id,bedId:bed.id });
    assert.match(inpatientIssues(next(confirm,'cancel',{note:'Withdrawn'}),records([confirm,reserve]))[0],/changed/);
  });
  it('refuses arrival without reservation and bed/visit substitution', () => {
    const confirm = initial();
    assert.ok(inpatientIssues({ ...confirm,id:'arrival',previousId:confirm.id,action:'arrive',wardId:ward.id,bedId:bed.id },records([confirm])).length);
    const reserve = next(confirm,'reserve',{wardId:ward.id,bedId:bed.id});
    assert.ok(inpatientIssues(next(reserve,'arrive',{bedId:bed2.id}),records([confirm,reserve])).length);
    assert.ok(inpatientIssues(next(reserve,'arrive',{patientId:'TEST-000002-K2'}),records([confirm,reserve])).length);
  });
  it('keeps discharge-ready patients admitted and occupies their bed until departure', () => {
    const confirm=initial(), reserve=next(confirm,'reserve',{wardId:ward.id,bedId:bed.id}), arrive=next(reserve,'arrive'), ready=next(arrive,'ready_for_discharge');
    const events=[confirm,reserve,arrive,ready];
    assert.equal(activeAdmission(ready),true); assert.equal(inpatientBedState(bed.id,events,[]).status,'Occupied');
    const departure=next(ready,'discharge'); assert.deepEqual(inpatientIssues(departure,records(events)),[]);
    assert.equal(activeAdmission(departure),false); assert.equal(inpatientBedState(bed.id,[...events,departure],[]).status,'Cleaning');
    const cleaned=BedReadyEvent.parse({...base,id:'clean:1',type:'bed_ready_event',bedId:bed.id,releaseEventId:departure.id,actorRole:'nurse'});
    assert.deepEqual(bedReadyIssues(cleaned,records([...events,departure])),[]);
    assert.equal(inpatientBedState(bed.id,[...events,departure],[cleaned]).status,'Available');
    assert.ok(bedReadyIssues(cleaned,{...records([...events,departure]),ready:[cleaned]}).length);
  });
  it('transfers to a different available bed and leaves the old bed awaiting cleaning', () => {
    const confirm=initial(),reserve=next(confirm,'reserve',{wardId:ward.id,bedId:bed.id}),arrive=next(reserve,'arrive');
    const transfer=next(arrive,'transfer',{bedId:bed2.id,note:'Move completed'}), events=[confirm,reserve,arrive,transfer];
    assert.deepEqual(inpatientIssues(transfer,records(events.slice(0,-1))),[]);
    assert.equal(inpatientBedState(bed.id,events,[]).status,'Cleaning'); assert.equal(inpatientBedState(bed2.id,events,[]).status,'Occupied');
    assert.ok(bedReadyIssues({...base,id:'bad-clean',type:'bed_ready_event',bedId:bed2.id,releaseEventId:transfer.id,actorRole:'nurse'},records(events)).length);
  });
  it('cancels pre-arrival reservations without manufacturing a cleaning task', () => {
    const confirm=initial(),reserve=next(confirm,'reserve',{wardId:ward.id,bedId:bed.id}),cancel=next(reserve,'cancel',{note:'Admission withdrawn before arrival'});
    assert.deepEqual(inpatientIssues(cancel,records([confirm,reserve])),[]);
    assert.equal(inpatientBedState(bed.id,[confirm,reserve,cancel],[]).status,'Available');
  });
  it('retains competing heads and removes rejected branches and their descendants', () => {
    const confirm=initial(),reserve=next(confirm,'reserve',{wardId:ward.id,bedId:bed.id}),arrive=next(reserve,'arrive');
    assert.equal(inpatientHeads([confirm,reserve,arrive]).length,1);
    assert.deepEqual(usableInpatientEvents([confirm,reserve,arrive],new Set([reserve.id])),[confirm]);
  });
  it('grants admission work explicitly to hospital clinical roles, never cashiers or laboratory roles by default', () => {
    for (const role of ['nurse','doctor','supervisor','facility_admin'] as const) assert.ok(staffPermissions({role,permission:'read_write'}).includes('admission:manage'));
    for (const role of ['cashier','laboratory_staff','pharmacy_staff','records_officer','chew'] as const) assert.equal(staffPermissions({role,permission:'read_write'}).includes('admission:manage'),false);
    assert.equal(staffPermissions({role:'nurse',permission:'read_only'}).includes('admission:manage'),false);
  });
});
