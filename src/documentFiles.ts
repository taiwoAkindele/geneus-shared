import { z } from 'zod';

/** File identity shared by clinical documents and lab result images; it imports nothing else from the contract. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DocumentMime = z.enum(['application/pdf','image/jpeg','image/png','image/webp']);
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp';
const text = z.string().trim().min(1);
export const DocumentFile = z.strictObject({
  id: text.max(200), fileName: text.max(255).refine((name) => !/[\\/\u0000-\u001f]/.test(name), 'Use a filename without paths or control characters'),
  mimeType: DocumentMime, byteSize: z.number().int().positive().max(DOCUMENT_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DocumentFile = z.infer<typeof DocumentFile>;
/** Inspect bytes as well as the supplied MIME; SVG/HTML are deliberately not document images. */
export const documentContentType = (bytes: Uint8Array): DocumentFile['mimeType'] | undefined => {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0,5)) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  return undefined;
};
export const sameDocumentFile = (a: DocumentFile,b: DocumentFile) => a.id === b.id && a.sha256 === b.sha256 && a.byteSize === b.byteSize && a.mimeType === b.mimeType && a.fileName === b.fileName;
