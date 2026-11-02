import { z } from 'zod';
import { baseEnvelope, isoDate } from './common.ts';
import { validCalendarDate } from './patientIdentity.ts';
import { staffPermissions, rolesFor, type StaffAccess } from './permissions.ts';
import type { AuthorizationContext } from './permissions.ts';
import { activeAdmission, inpatientHeads, type InpatientEvent } from './inpatient.ts';
import { Role, type Encounter } from './documents.ts';
import { DocumentFile, sameDocumentFile } from './documentFiles.ts';
export * from './documentFiles.ts';

const text = z.string().trim().min(1);
const versionFields = { documentId:text,previousId:text.optional(),version:z.number().int().positive(),title:text.max(160),file:DocumentFile,actorRole:Role };
export const LibraryDocument = baseEnvelope.extend({
  type:z.literal('library_document'),schemaVersion:z.literal(5).default(5),...versionFields,
  action:z.enum(['upload','replace','rename','archive','restore']),archived:z.boolean(),
}).superRefine((record,ctx)=>{
  if ((record.version===1)!==!record.previousId || record.previousId===record.id || (!record.previousId && (record.id!==record.documentId || record.action!=='upload' || record.archived)))
    ctx.addIssue({code:'custom',message:'A library document starts at version one; later versions name their predecessor'});
});
export type LibraryDocument = z.infer<typeof LibraryDocument>;
export const DocumentSignatureStatus = z.enum(['unsigned','awaiting_signed_copy','signed','not_required']);
export type DocumentSignatureStatus = z.infer<typeof DocumentSignatureStatus>;
export const DOCUMENT_SIGNATURE_LABELS = {unsigned:'Unsigned',awaiting_signed_copy:'Awaiting signed copy',signed:'Signed — staff reviewed',not_required:'Signature not required'} as const;
export const SignatureReview = z.strictObject({
  signerName:text.max(160),signerKind:z.enum(['patient','representative','staff']),
  relationship:text.max(160).optional(),authorityBasis:text.max(1000).optional(),
  signedOn:isoDate.refine(validCalendarDate,'Use the date recorded on the form').optional(),note:text.max(2000).optional(),
}).superRefine((review,ctx)=>{
  if(review.signerKind==='representative' && (!review.relationship || !review.authorityBasis))ctx.addIssue({code:'custom',message:'Record the representative’s relationship and the authority checked'});
});
export type SignatureReview = z.infer<typeof SignatureReview>;
export const VisitDocument = baseEnvelope.extend({
  type:z.literal('visit_document'),schemaVersion:z.literal(5).default(5),...versionFields,patientId:text,encounterId:text,admissionId:text,admissionEventId:text,
  templateVersionId:text.optional(),action:z.enum(['attach','signed_copy','status']),
  signatureStatus:DocumentSignatureStatus,signatureReview:SignatureReview.optional(),changeReason:text.max(2000).optional(),
}).superRefine((record,ctx)=>{
  if((record.version===1)!==!record.previousId || record.previousId===record.id || (!record.previousId && (record.id!==record.documentId || record.action!=='attach')) || (record.previousId && record.action==='attach'))
    ctx.addIssue({code:'custom',message:'A visit document starts with attachment; changes retain its exact predecessor'});
  if((record.signatureStatus==='signed')!==Boolean(record.signatureReview))ctx.addIssue({code:'custom',message:'Signed status requires an explicit staff review of the signature evidence'});
  if(record.action==='signed_copy' && record.signatureStatus!=='signed')ctx.addIssue({code:'custom',message:'A signed-copy upload needs signature review'});
});
export type VisitDocument = z.infer<typeof VisitDocument>;
export type ClinicalDocument = LibraryDocument | VisitDocument;
export const documentHeads = <T extends {id:string;previousId?:string}>(records:readonly T[]):T[] => {
  const replaced=new Set(records.map((record)=>record.previousId));return records.filter((record)=>!replaced.has(record.id));
};
/** Matches existing Clinical Services duties; no document-specific permission settings. */
export const clinicalDocumentAccess = (context:Pick<AuthorizationContext,'role'|'roles'|'permissions'>):boolean => context.permissions.includes('patient_chart:read');
export const staffDocumentAccess = (staff:StaffAccess) => clinicalDocumentAccess({role:staff.role,roles:rolesFor(staff),permissions:staffPermissions(staff)});
export const libraryDocumentIssues = (record:LibraryDocument,records:readonly LibraryDocument[]):string[] => {
  const existing=records.filter((item)=>item.documentId===record.documentId && item.facilityId===record.facilityId);
  if(!record.previousId)return existing.length?['This library document already exists']:[];
  const heads=documentHeads(existing);
  const previous=heads.length===1?heads.find((item)=>item.id===record.previousId):undefined;
  if(!previous || record.version!==previous.version+1)return ['This library document changed. Review its current version before saving'];
  if(record.action==='upload')return ['Upload starts a new document; use a versioned change for this document'];
  if(record.action!=='replace' && !sameDocumentFile(record.file,previous.file))return ['This change cannot replace the document file'];
  if(!['replace','rename'].includes(record.action) && record.title!==previous.title)return ['Rename the document in a separate attributed change'];
  if(record.action==='replace' && (previous.archived || record.file.id===previous.file.id))return ['Choose a new file for an active library document'];
  const archived=record.action==='archive'?true:record.action==='restore'?false:previous.archived;
  if(record.archived!==archived || (record.action==='archive'&&previous.archived)||(record.action==='restore'&&!previous.archived))return ['Use the current archive state when changing this document'];
  return [];
};
export const visitDocumentIssues = (record:VisitDocument,data:{documents:readonly VisitDocument[];library:readonly LibraryDocument[];admissions:readonly InpatientEvent[];encounter?:Encounter}):string[] => {
  const visit=data.encounter;
  if(!visit || visit.id!==record.encounterId || visit.patientId!==record.patientId || visit.facilityId!==record.facilityId)return ['The document must link to this patient’s visit in this hospital'];
  const admission=inpatientHeads(data.admissions).find((event)=>event.admissionId===record.admissionId && event.encounterId===record.encounterId && event.patientId===record.patientId && event.facilityId===record.facilityId && activeAdmission(event));
  const captured=data.admissions.find((event)=>event.id===record.admissionEventId && event.admissionId===record.admissionId && event.encounterId===record.encounterId && event.patientId===record.patientId && event.facilityId===record.facilityId && activeAdmission(event));
  if(!admission || !captured)return ['Documents can be added or updated only for an active inpatient visit'];
  if(record.templateVersionId){
    const template=data.library.find((item)=>item.id===record.templateVersionId && item.facilityId===record.facilityId && !item.archived);
    if(!template)return ['Choose an available library document version'];
    const current=documentHeads(data.library.filter((item)=>item.documentId===template.documentId));
    if(!record.previousId&&current.length!==1)return ['Review the competing library versions before issuing a new copy'];
    if(!record.previousId && current.some((item)=>item.archived))return ['This library document is archived. Choose an active document'];
    if(!record.previousId && !sameDocumentFile(record.file,template.file))return ['A library copy must retain the exact selected version'];
    if(record.signatureStatus==='signed' && record.file.id===template.file.id)return ['Upload the patient’s signed copy; a library original is not patient signature evidence'];
  }
  const existing=data.documents.filter((item)=>item.documentId===record.documentId && item.facilityId===record.facilityId);
  if(!record.previousId)return existing.length?['This visit document already exists']:[];
  const heads=documentHeads(existing);
  const previous=heads.length===1?heads.find((item)=>item.id===record.previousId):undefined;
  if(!previous || record.version!==previous.version+1)return ['This visit document changed. Review its latest version before saving'];
  if(['patientId','encounterId','admissionId','templateVersionId','title'].some((key)=>record[key as keyof VisitDocument]!==previous[key as keyof VisitDocument]))return ['A document cannot be reassigned to a different patient, visit or library source'];
  if(record.action==='status' && !sameDocumentFile(record.file,previous.file))return ['A status review cannot replace the attached file'];
  if(record.action==='signed_copy' && record.file.id===previous.file.id)return ['Choose the new signed-copy file'];
  if(previous.signatureStatus==='signed' && !record.changeReason)return ['Explain the correction; the earlier signed version will be retained'];
  return [];
};
export const usableDocumentVersions = <T extends {id:string;previousId?:string}>(records:readonly T[],rejected:ReadonlySet<string>):T[] => {
  const blocked=new Set(rejected),children=new Map<string,string[]>();
  for(const record of records)if(record.previousId){const ids=children.get(record.previousId)??[];ids.push(record.id);children.set(record.previousId,ids);}
  const queue=[...blocked];for(let n=0;n<queue.length;n++)for(const id of children.get(queue[n])??[])if(!blocked.has(id)){blocked.add(id);queue.push(id);}
  return records.filter((record)=>!blocked.has(record.id));
};
