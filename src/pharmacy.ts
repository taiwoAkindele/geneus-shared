import { DispensingDetails, type DispensingDetails as Details } from './pharmacyTypes.ts';
import { Charge, StockMovement, BillingAdjustment, findExemption, type EncounterEntry, type StockItem, type FeeItem, type Patient, type VisitType } from './documents.ts';
import type { WardCareEvent } from './wardCare.ts';
import { patientAge } from './patientIdentity.ts';
import { medicationHeads, dischargeHeads } from './wardCare.ts';

export type PharmacyRecords = { entries: readonly EncounterEntry[]; items: readonly StockItem[]; movements: readonly StockMovement[]; fees: readonly FeeItem[]; charges: readonly Charge[]; adjustments: readonly BillingAdjustment[]; patient?: Patient; wardEvents?: readonly WardCareEvent[]; visitType?: VisitType };
export const dispensingDetails = (entry: EncounterEntry): Details | undefined => {
  if (entry.step !== 'dispense' || entry.pharmacyVersion !== 1) return undefined;
  const parsed = DispensingDetails.safeParse(entry.values.supply);
  return parsed.success ? parsed.data : undefined;
};
export type PharmacyPrescription = EncounterEntry | WardCareEvent;
export const prescriptionLines = (entry: PharmacyPrescription) => ((entry.type === 'ward_care_event' ? entry.values.kind === 'discharge' ? entry.values.takeHome : [] : entry.values.prescription ?? []) as { drug: string; dose: string; frequency?: string; duration?: string; route?: string; quantity?: number; unitOfMeasure?: string; lineId?: string }[])
  .map((line, index) => ({ ...line, lineId: line.lineId ?? `${entry.id}:line:${index}` }));
export const supplyEntries = (entries: readonly EncounterEntry[], sourceId: string, lineId: string) => entries.filter((entry) => { const d = dispensingDetails(entry); return d?.prescriptionEntryId === sourceId && d.lineId === lineId; });
export const supplyHeads = (entries: readonly EncounterEntry[]) => {
  const replaced = new Set(entries.map((e) => dispensingDetails(e)?.previousEntryId).filter(Boolean));
  return entries.filter((e) => !replaced.has(e.id));
};
export const supplyState = (source: PharmacyPrescription, lineId: string, entries: readonly EncounterEntry[]) => {
  const events = supplyEntries(entries, source.id, lineId), heads = supplyHeads(events);
  const line = prescriptionLines(source).find((l) => l.lineId === lineId);
  const supplied = events.reduce((total, e) => { const d = dispensingDetails(e)!; return total + (d.action === 'supply' ? d.quantity! : d.action === 'return' ? -d.quantity! : 0); }, 0);
  const legacy = !events.length && entries.some((e) => e.encounterId === source.encounterId && e.step === 'dispense' && !e.pharmacyVersion);
  const complete = heads.length === 1 ? dispensingDetails(heads[0])!.complete : legacy;
  return { events, heads, line, supplied: Math.round(supplied * 1e6) / 1e6, complete, legacy, conflict: heads.length > 1 };
};
export const pharmacyChargeId = (id: string) => `charge:dispense:${id}`;
export const pharmacyMovementId = (id: string) => `stock:dispense:${id}`;
export const pharmacyReturnId = (id: string) => `credit:dispense:${id}`;
export const supplyCharge = (originalId: string, data: PharmacyRecords) => data.charges.find((c) => c.id === pharmacyChargeId(originalId))
  ?? data.charges.find((c) => data.entries.some((e) => e.id === c.dispenseEntryId && dispensingDetails(e)?.priceFor === originalId));
export const unreturnedQuantity = (original: EncounterEntry, entries: readonly EncounterEntry[]) => Math.max(0, (dispensingDetails(original)?.quantity ?? 0) - entries.reduce((n, e) => { const d = dispensingDetails(e); return n + (d?.action === 'return' && d.returnOf === original.id ? d.quantity! : 0); }, 0));
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
export const supplyPrice = (fee: FeeItem, quantity: number, patient: Patient, at: string, visitType?: VisitType) => {
  const total = Math.round(fee.amountMinor * quantity);
  if (!Number.isSafeInteger(total)) throw new Error('The medicine total is too large');
  const exemption = findExemption(fee.exemptions, { ageYears: patientAge(patient, at.slice(0, 10)), sex: patient.sex, visitType });
  return { total, amount: exemption ? 0 : total, exemptionReason: exemption?.reason };
};
export const returnCredit = (original: EncounterEntry, quantity: number, data: PharmacyRecords): number => {
  const source = dispensingDetails(original);
  const charge = supplyCharge(original.id, data);
  if (!source || source.action !== 'supply' || !charge || !source.quantity || !charge.amountMinor) return 0;
  const reduced = data.adjustments.filter((a) => a.chargeId === charge.id).reduce((n, a) => n + a.amountMinor, 0);
  const pricedQuantity = data.entries.find((e) => e.id === charge.dispenseEntryId);
  const billedQuantity = pricedQuantity && dispensingDetails(pricedQuantity)?.quantity || source.quantity;
  return Math.max(0, Math.min(charge.amountMinor - reduced, Math.round(charge.amountMinor * quantity / billedQuantity)));
};
/** A legacy summary remains readable, while the quantity history retains exact source lines. */
export const dispensingSummary = (source: PharmacyPrescription, entries: readonly EncounterEntry[], candidate?: EncounterEntry) => prescriptionLines(source).map((line) => {
  const state = supplyState(source, line.lineId, candidate ? [...entries, candidate] : entries);
  return { drug: line.drug, dispensed: state.complete, ...(state.complete ? {} : { reason: 'Still needed / supply pending' }) };
});

export const pharmacyIssues = (entry: EncounterEntry, data: PharmacyRecords): string[] => {
  const d = dispensingDetails(entry);
  if (!d) return ['Use the quantity-based pharmacy form'];
  const source = data.entries.find((e) => e.id === d.prescriptionEntryId && ['prescription', 'diagnosis'].includes(e.step))
    ?? data.wardEvents?.find((e) => e.id === d.prescriptionEntryId && e.values.kind === 'discharge');
  if (!source || source.facilityId !== entry.facilityId || source.patientId !== entry.patientId || source.encounterId !== entry.encounterId) return ['Choose this patient’s exact signed prescription'];
  const state = supplyState(source, d.lineId, data.entries);
  if (!state.line) return ['The selected prescription line is unavailable'];
  const summary = dispensingSummary(source, data.entries, entry), lines = entry.values.lines as { drug: string; dispensed: boolean; reason?: string }[];
  if (lines.length !== summary.length || lines.some((line, index) => line.drug !== summary[index].drug || line.dispensed !== summary[index].dispensed || line.reason !== summary[index].reason)) return ['The supply summary must match the signed quantity history'];
  if (state.conflict || (state.heads[0]?.id ?? undefined) !== d.previousEntryId) return ['This medicine has another update. Refresh and review the supplied quantity before saving'];
  if (Date.parse(entry.createdOn) < Date.parse(source.createdOn)) return ['A supply cannot precede its signed prescription'];
  if (d.action === 'supply') {
    if (source.type === 'ward_care_event') {
      const current = dischargeHeads((data.wardEvents ?? []).filter((e) => e.admissionId === source.admissionId));
      if (current.length !== 1 || current[0].id !== source.id) return ['The discharge prescription was revised. Review the current signed discharge summary'];
    }
    if (state.complete) return ['This medicine is marked complete. Reopen it with a reason before supplying more'];
    if (data.entries.some((e) => e.amends === source.id && e.values.correctedValues)) return ['The prescription was corrected. Ask the clinician to review it before another supply'];
    const roots = new Set((data.wardEvents ?? []).filter((e) => e.values.kind === 'medication' && e.values.sourceEntryId === source.id && e.values.lineId === d.lineId).flatMap((e) => e.values.kind === 'medication' ? [e.values.orderId] : []));
    const heads = medicationHeads(data.wardEvents ?? []).filter((e) => e.values.kind === 'medication' && roots.has(e.values.orderId));
    if (roots.size && (heads.length !== roots.size || heads.some((e) => e.values.kind === 'medication' && (e.values.action === 'stop' || e.values.sourceEntryId !== source.id || e.values.lineId !== d.lineId)))) return ['This ward medicine order changed or stopped. Review the current prescription'];
    if (state.line.unitOfMeasure && state.line.unitOfMeasure !== d.unit) return ['Use the same quantity unit as the prescription; do not infer a pack conversion'];
    if (state.events.some((e) => { const v = dispensingDetails(e)!; return v.unit && v.unit !== d.unit; })) return ['Keep the same quantity unit for later supplies of this medicine'];
    if (state.line.quantity !== undefined && state.supplied + d.quantity! > state.line.quantity + 1e-6) return ['This exceeds the prescribed quantity still needed'];
    if (state.line.quantity !== undefined && d.complete !== same(state.supplied + d.quantity!, state.line.quantity)) return ['Keep a partial supply pending; a full prescribed quantity completes this medicine'];
    if (d.source === 'stock') {
      const stock = data.items.find((s) => s.id === d.stockItemId && s.facilityId === entry.facilityId);
      if (!stock || stock.unitOfMeasure !== d.unit) return ['Select the stock item and use its recorded quantity unit'];
    }
  }
  if (d.action === 'supply' || d.action === 'price') {
    if (d.billing === 'charge') {
      const fee = data.fees.find((f) => f.id === d.feeItemId && f.facilityId === entry.facilityId && f.active);
      if (!fee || !data.patient || data.patient.patientId !== entry.patientId || data.patient.facilityId !== entry.facilityId) return ['The medicine price or patient record is unavailable'];
      if (fee.amountMinor !== d.unitPriceMinor || fee.currency !== d.currency || supplyPrice(fee, d.quantity!, data.patient, entry.createdOn, data.visitType).amount !== d.chargedMinor) return ['The medicine price changed. Review the current price before saving'];
    }
  }
  if (d.action === 'price') {
    const original = state.events.find((e) => e.id === d.priceFor), supplied = original && dispensingDetails(original);
    if (!original || supplied?.action !== 'supply' || supplied.billing !== 'unpriced' || supplyCharge(original.id, data) || state.events.some((e) => dispensingDetails(e)?.priceFor === original.id)) return ['This supply already has a bill, or is not waiting for a price'];
    if (supplied.unit !== d.unit || !same(unreturnedQuantity(original, state.events), d.quantity!)) return ['The return or quantity changed. Review the quantity that still needs billing'];
    if (d.complete !== state.complete) return ['Adding a price must preserve the current medicine completion decision'];
  }
  if (d.action === 'return') {
    const original = state.events.find((e) => e.id === d.returnOf), supplied = original && dispensingDetails(original);
    if (!original || supplied?.action !== 'supply' || supplied.unit !== d.unit) return ['Choose the original quantity supplied to this patient'];
    const returned = state.events.reduce((n, e) => { const v = dispensingDetails(e)!; return n + (v.action === 'return' && v.returnOf === original.id ? v.quantity! : 0); }, 0);
    if (returned + d.quantity! > supplied.quantity! + 1e-6) return ['The returned quantity exceeds this original supply'];
    if (d.restock && !supplied.stockItemId) return ['An outside supply cannot be added to hospital stock through a return'];
    if (d.creditMinor !== returnCredit(original, d.quantity!, data)) return ['The bill changed. Review the medicine return and credit before saving'];
  }
  return [];
};

/** Deterministic companion records: local transaction and server transaction produce identical records. */
export const pharmacyEffects = (entry: EncounterEntry, data: PharmacyRecords): (StockMovement | Charge | BillingAdjustment)[] => {
  const d = dispensingDetails(entry);
  if (!d) return [];
  const result: (StockMovement | Charge | BillingAdjustment)[] = [];
  const base = { facilityId: entry.facilityId, deviceId: entry.deviceId, schemaVersion: entry.schemaVersion, createdBy: entry.createdBy, createdOn: entry.createdOn, dispenseEntryId: entry.id };
  if (d.action === 'supply' || d.action === 'price') {
    if (d.stockItemId) result.push(StockMovement.parse({ ...base, id: pharmacyMovementId(entry.id), type: 'stock_movement', itemId: d.stockItemId, change: -d.quantity!, reason: 'dispensed', movedOn: entry.createdOn, note: `Medicine supplied to ${entry.patientId}` }));
    if (d.billing === 'charge') {
      const fee = data.fees.find((f) => f.id === d.feeItemId)!;
      const price = supplyPrice(fee, d.quantity!, data.patient!, entry.createdOn, data.visitType);
      result.push(Charge.parse({ ...base, id: pharmacyChargeId(entry.id), type: 'charge', patientId: entry.patientId, encounterId: entry.encounterId, feeItemId: fee.id, description: `${fee.name} · ${d.quantity} ${d.unit}`, category: fee.category, departmentId: fee.departmentId ?? undefined, listPriceMinor: price.total, amountMinor: price.amount, currency: d.currency, exemptionReason: price.exemptionReason }));
    }
  }
  if (d.action === 'return') {
    const original = data.entries.find((e) => e.id === d.returnOf)!, supplied = dispensingDetails(original)!;
    if (d.restock) result.push(StockMovement.parse({ ...base, id: pharmacyMovementId(entry.id), type: 'stock_movement', itemId: supplied.stockItemId, change: d.quantity!, reason: 'adjustment', movedOn: entry.createdOn, note: `Medicine return: ${d.reason}` }));
    if (d.creditMinor! > 0) result.push(BillingAdjustment.parse({ ...base, id: pharmacyReturnId(entry.id), type: 'billing_adjustment', patientId: entry.patientId, chargeId: supplyCharge(original.id, data)!.id, kind: 'discount', amountMinor: d.creditMinor, reason: `Medicine return: ${d.reason}` }));
  }
  return result;
};
