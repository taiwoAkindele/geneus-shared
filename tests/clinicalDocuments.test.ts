import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { LibraryDocument,VisitDocument,DocumentFile,documentContentType,documentHeads,libraryDocumentIssues,visitDocumentIssues,usableDocumentVersions,clinicalDocumentAccess,SignatureReview } from '../src/clinicalDocuments.ts';
import { InpatientEvent } from '../src/inpatient.ts';
import { Encounter } from '../src/documents.ts';
const base={facilityId:'TEST',schemaVersion:5,createdBy:'staff:doctor',deviceId:'device:one',createdOn:'2026-10-31T09:00:00Z',actorRole:'doctor' as const};
const file=(id='file:one')=>DocumentFile.parse({id,fileName:'Form.pdf',mimeType:'application/pdf',byteSize:100,sha256:'a'.repeat(64)});
const library=()=>LibraryDocument.parse({...base,id:'library:one',type:'library_document',documentId:'library:one',version:1,title:'Hospital consent',file:file(),action:'upload',archived:false});
const encounter=Encounter.parse({...base,id:'visit:one',type:'encounter',patientId:'TEST-000001-K2',openedOn:base.createdOn});
const admission=InpatientEvent.parse({...base,id:'admission:one',type:'inpatient_event',admissionId:'admission:one',patientId:encounter.patientId,encounterId:encounter.id,requestEntryId:'request:one',action:'confirm',receivingUnitId:'unit:ward'});
const attachment=()=>VisitDocument.parse({...base,id:'visit-document:one',type:'visit_document',documentId:'visit-document:one',version:1,title:'Consent',file:file(),patientId:encounter.patientId,encounterId:encounter.id,admissionId:admission.id,admissionEventId:admission.id,templateVersionId:library().id,action:'attach',signatureStatus:'unsigned'});
const data=()=>({documents:[] as VisitDocument[],library:[library()],admissions:[admission],encounter});
describe('hospital documents contract',()=>{
  it('limits files to bounded PDFs and common image formats, with actual content inspection',()=>{
    assert.equal(DocumentFile.safeParse({...file(),mimeType:'text/html'}).success,false);
    assert.equal(DocumentFile.safeParse({...file(),fileName:'../patient.pdf'}).success,false);
    assert.equal(DocumentFile.safeParse({...file(),byteSize:10*1024*1024+1}).success,false);
    assert.equal(documentContentType(new TextEncoder().encode('%PDF-1.4')),'application/pdf');
    assert.equal(documentContentType(new TextEncoder().encode('<svg>')),undefined);
    assert.equal(documentContentType(new Uint8Array([137,80,78,71,13,10,26,10])),'image/png');
  });
  it('retains issued files when the library publishes a replacement',()=>{
    const original=library(),copy=attachment(),replacement=LibraryDocument.parse({...original,id:'library:two',previousId:original.id,version:2,action:'replace',file:file('file:two')});
    assert.deepEqual(libraryDocumentIssues(replacement,[original]),[]);
    assert.equal(documentHeads([original,replacement])[0].id,replacement.id);
    assert.equal(copy.templateVersionId,original.id);assert.equal(copy.file.id,'file:one');
    assert.deepEqual(visitDocumentIssues(copy,{...data(),library:[original,replacement]}),[]);
  });
  it('requires an exact predecessor and preserves file bytes on rename/archive',()=>{
    const original=library(),renamed=LibraryDocument.parse({...original,id:'library:rename',previousId:original.id,version:2,action:'rename',title:'Renamed form'});
    assert.deepEqual(libraryDocumentIssues(renamed,[original]),[]);
    assert.ok(libraryDocumentIssues({...renamed,file:file('other')},[original]).length);
    assert.ok(libraryDocumentIssues({...renamed,id:'library:stale'},[original,renamed]).length);
  });
  it('archives future use while retaining every previous visit copy',()=>{
    const original=library(),archived=LibraryDocument.parse({...original,id:'library:archive',previousId:original.id,version:2,action:'archive',archived:true});
    assert.deepEqual(libraryDocumentIssues(archived,[original]),[]);
    assert.match(visitDocumentIssues(attachment(),{...data(),library:[original,archived]})[0],/archived/);
    assert.equal(documentHeads([attachment()]).length,1);
  });
  it('requires an active inpatient stay and the exact patient visit',()=>{
    const copy=attachment();assert.deepEqual(visitDocumentIssues(copy,data()),[]);
    assert.ok(visitDocumentIssues({...copy,encounterId:'other'},data()).length);
    assert.ok(visitDocumentIssues(copy,{...data(),admissions:[]}).length);
    const cancelled=InpatientEvent.parse({...admission,id:'admission:cancel',previousId:admission.id,action:'cancel',note:'Withdrawn'});
    assert.ok(visitDocumentIssues(copy,{...data(),admissions:[admission,cancelled]}).length);
  });
  it('does not equate an uploaded file or a reusable original with a patient signature',()=>{
    assert.equal(VisitDocument.safeParse({...attachment(),signatureStatus:'signed'}).success,false);
    const review={signerName:'Synthetic Patient',signerKind:'patient' as const};
    const signed=VisitDocument.parse({...attachment(),signatureStatus:'signed',signatureReview:review});
    assert.match(visitDocumentIssues(signed,data())[0],/library original/);
    const uploaded=VisitDocument.parse({...signed,templateVersionId:undefined,file:file('file:patient-scan')});
    assert.deepEqual(visitDocumentIssues(uploaded,data()),[]);
  });
  it('records guardian authority and keeps previous signed copies when correcting a scan',()=>{
    assert.equal(SignatureReview.safeParse({signerName:'Guardian',signerKind:'representative'}).success,false);
    const review=SignatureReview.parse({signerName:'Guardian',signerKind:'representative',relationship:'Parent',authorityBasis:'Hospital representative checks completed'});
    const original=VisitDocument.parse({...attachment(),file:file('file:signed'),signatureStatus:'signed',signatureReview:review});
    const correction=VisitDocument.parse({...original,id:'visit-document:corrected',previousId:original.id,version:2,action:'signed_copy',file:file('file:corrected')});
    assert.match(visitDocumentIssues(correction,{...data(),documents:[original]})[0],/Explain the correction/);
    assert.deepEqual(visitDocumentIssues({...correction,changeReason:'Replace unreadable scan'},{...data(),documents:[original]}),[]);
    assert.equal(original.file.id,'file:signed');
  });
  it('never reassigns a patient document or silently selects a competing version',()=>{
    const original=attachment(),next=VisitDocument.parse({...original,id:'visit-document:next',previousId:original.id,version:2,action:'status',signatureStatus:'awaiting_signed_copy'});
    assert.deepEqual(visitDocumentIssues(next,{...data(),documents:[original]}),[]);
    assert.ok(visitDocumentIssues({...next,admissionId:'other'},{...data(),documents:[original]}).length);
    assert.deepEqual(usableDocumentVersions([original,next],new Set([original.id])),[]);
  });
  it('uses existing Clinical Services access, including read-only clinical roles, without new document grants',()=>{
    assert.equal(clinicalDocumentAccess({role:'nurse',permissions:[]}),true);
    assert.equal(clinicalDocumentAccess({role:'cashier',permissions:[]}),false);
    assert.equal(clinicalDocumentAccess({role:'records_officer',permissions:['admission:manage']}),true);
  });
});
