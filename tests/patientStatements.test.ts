import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {Charge,Payment,Refund,BillingAdjustment,CoverageAllocation,CoverageFinancialSummary,patientStatement,claimSettlement,sumStatementLines,type CoverageEstimate} from '../src/index.ts';
const base={facilityId:'TEST-HOSPITAL',deviceId:'device:test',createdBy:'staff:test',createdOn:'2026-11-18T09:00:00.000Z',schemaVersion:7},patientId='TEST-HOSPITAL-000001-K2';
const charge=Charge.parse({...base,id:'charge:lab',type:'charge',patientId,feeItemId:'fee:lab',description:'Full Blood Count',category:'laboratory',listPriceMinor:10000,amountMinor:10000,currency:'NGN'});
const allocation=CoverageAllocation.parse({...base,id:'allocation:lab',type:'coverage_allocation',patientId,chargeId:charge.id,state:'finalised',payerId:'payer:one',arrangement:'per_service',patientShareMinor:1000,currency:'NGN',basis:'visit'});
const summary=(adjustment=1000)=>CoverageFinancialSummary.parse({...base,id:'summary:lab',type:'coverage_financial_summary',allocationId:allocation.id,patientId,chargeId:charge.id,currency:'NGN',listPriceMinor:10000,patientShareMinor:1000,payerShareMinor:9000-adjustment,contractAdjustmentMinor:adjustment,capitationCoveredMinor:0});
const payment=Payment.parse({...base,id:'payment:one',type:'payment',patientId,receiptNumber:'TEST-HOSPITAL-R-000001-K2',method:'cash',amountMinor:600,currency:'NGN',allocations:[{chargeId:charge.id,amountMinor:600}]});
const input={patientId,patientName:'Synthetic patient',facilityName:'Synthetic hospital',currency:'NGN',cutoff:'2026-11-18T12:00:00.000Z',generatedOn:'2026-11-18T12:00:01.000Z',charges:[charge],payments:[payment],adjustments:[],refunds:[],allocations:[allocation],summaries:[summary()],estimates:new Map<string,CoverageEstimate>([[charge.id,{state:'finalised',allocation}]]),claims:[{id:'claim:one',claimNumber:'CLM-000001',payerName:'Synthetic HMO',chargeIds:[charge.id],settlement:claimSettlement({submitted:true,expectedMinor:8000,paidMinor:3000,writtenOffMinor:0,openDisputeMinor:0,today:'2026-11-18'})}]};
describe('one authoritative patient statement projection',()=>{
 it('reconciles original, signed adjustment, patient and insurer responsibilities and actual claim payments',()=>{
  const s=patientStatement(input);assert.equal(s.totals.originalMinor,10000);assert.equal(s.totals.netMinor,9000);assert.equal(s.totals.patientOutstandingMinor,400);assert.equal(s.totals.payerOutstandingMinor,5000);assert.equal(s.totals.payerReceivedMinor,3000);assert.equal(s.totals.patientMinor+s.totals.payerMinor+s.totals.capitationMinor+s.totals.pendingMinor-s.totals.reductionsMinor,s.totals.netMinor);
  assert.equal('payerReceivedMinor' in s.lines[0],false,'claim-level money is never invented on a charge line');
 });
 it('subtracts negative signed contractual adjustments so the net charge increases',()=>{
  const s=patientStatement({...input,summaries:[summary(-1000)],claims:[]});assert.equal(s.totals.netMinor,11000);assert.equal(s.totals.payerMinor,10000);assert.equal(s.totals.patientMinor,1000);assert.equal(s.totals.payerUnclaimedMinor,10000);
 });
 it('category summary and itemized lines reconcile to identical totals in the same currency and cutoff',()=>{
  const pharmacy=Charge.parse({...charge,id:'charge:pharmacy',category:'pharmacy',description:'Medicine',createdOn:'2026-11-18T10:00:00.000Z'});
  const s=patientStatement({...input,charges:[charge,pharmacy],estimates:new Map([...input.estimates,[pharmacy.id,{state:'self_pay'} as CoverageEstimate]])});
  assert.deepEqual(sumStatementLines(s.lines),Object.fromEntries(Object.keys(s.categories[0].totals).map(key=>[key,s.categories.reduce((n,g)=>n+g.totals[key as keyof typeof g.totals],0)])));assert.equal(s.categories.length,2);
 });
 it('keeps pending insurance separate and never turns a denied claim into patient debt',()=>{
  const pending=patientStatement({...input,allocations:[],summaries:[],payments:[],claims:[],estimates:new Map([[charge.id,{state:'undetermined',reason:'check_pending'} as CoverageEstimate]])});assert.equal(pending.totals.pendingMinor,10000);assert.equal(pending.totals.patientOutstandingMinor,0);
  const denied=patientStatement({...input,claims:[{...input.claims[0],settlement:claimSettlement({submitted:true,expectedMinor:8000,decision:{decision:'denied',approvedMinor:0},paidMinor:0,writtenOffMinor:0,openDisputeMinor:0,today:'2026-11-18'})}]});assert.equal(denied.totals.patientOutstandingMinor,400);assert.equal(denied.totals.payerOutstandingMinor,8000);
 });
 it('shows reductions, patient credits, refunds and reversals separately without counting a waiver as money',()=>{
  const reduction=BillingAdjustment.parse({...base,id:'credit:return',type:'billing_adjustment',patientId,chargeId:charge.id,kind:'discount',amountMinor:500,reason:'Documented return'});
  const credit=patientStatement({...input,adjustments:[reduction]});assert.equal(credit.totals.patientCreditMinor,100);assert.equal(credit.totals.netMinor,8500);
  const refund=Refund.parse({...base,id:'refund:one',type:'refund',patientId,refundNumber:'TEST-HOSPITAL-F-000001',method:'cash',currency:'NGN',amountMinor:100,allocations:[{chargeId:charge.id,amountMinor:100}],reason:'Return actual credit'});
  const settled=patientStatement({...input,adjustments:[reduction],refunds:[refund]});assert.equal(settled.totals.patientCreditMinor,0);assert.equal(settled.totals.patientRefundedMinor,100);assert.equal(settled.totals.patientReceivedMinor,600);
  const reverse=Payment.parse({...payment,id:'payment:reverse',receiptNumber:'TEST-HOSPITAL-R-000002-K2',reverses:payment.id,reason:'Reverse a synthetic mistaken payment'});const reversed=patientStatement({...input,payments:[payment,reverse]});assert.equal(reversed.totals.patientReceivedMinor,0);assert.equal(reversed.totals.patientOutstandingMinor,1000);
 });
 it('excludes other patients, other currencies and activity after the common cutoff',()=>{
  const later=Payment.parse({...payment,id:'payment:later',receiptNumber:'TEST-HOSPITAL-R-000003-K2',createdOn:'2026-11-18T13:00:00.000Z'});
  const s=patientStatement({...input,charges:[charge,{...charge,id:'charge:usd',currency:'USD'},{...charge,id:'charge:other',patientId:'TEST-HOSPITAL-000002-K2'}],payments:[payment,later]});assert.equal(s.lines.length,1);assert.equal(s.transactions.length,2);assert.equal(s.totals.patientReceivedMinor,600);
 });
 it('holds payments against pending insurance without calling them patient debt or a finalized refundable credit',()=>{
  const s=patientStatement({...input,allocations:[],summaries:[],claims:[],estimates:new Map([[charge.id,{state:'undetermined',reason:'check_pending'} as CoverageEstimate]])});assert.equal(s.totals.patientOutstandingMinor,0);assert.equal(s.totals.patientCreditMinor,0);assert.equal(s.totals.heldPatientPaymentsMinor,600);assert.equal(s.totals.patientReceivedMinor,600);
 });
 it('uses current confirmed responsibility for the account and flags a stale claim revision without moving it to the patient',()=>{
  const s=patientStatement({...input,summaries:[summary(4000)]});assert.equal(s.totals.payerMinor,5000);assert.equal(s.totals.payerOutstandingMinor,2000);assert.equal(s.claims[0].settlement.outstandingMinor,5000);assert.equal(s.totals.patientOutstandingMinor,400);assert.ok(s.limitations.some(l=>l.includes('claim snapshot differs')));
 });
 it('keeps an overpayment on one claim separate from another claim outstanding, without reallocating money',()=>{
  const another={...charge,id:'charge:another'},anotherAllocation={...allocation,id:'allocation:another',chargeId:another.id},anotherSummary={...summary(),id:'summary:another',allocationId:anotherAllocation.id,chargeId:another.id};
  const s=patientStatement({...input,charges:[charge,another],allocations:[allocation,anotherAllocation],summaries:[summary(),anotherSummary],claims:[{...input.claims[0],settlement:claimSettlement({submitted:true,expectedMinor:8000,paidMinor:10000,writtenOffMinor:0,openDisputeMinor:0,today:'2026-11-18'})},{...input.claims[0],id:'claim:another',claimNumber:'CLM-000002',chargeIds:[another.id],settlement:claimSettlement({submitted:true,expectedMinor:8000,paidMinor:0,writtenOffMinor:0,openDisputeMinor:0,today:'2026-11-18'})}]});
  assert.equal(s.totals.payerReceivedMinor,10000);assert.equal(s.totals.payerOutstandingMinor,8000);assert.equal(s.totals.payerCreditMinor,2000);
 });
});
