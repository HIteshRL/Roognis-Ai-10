"use strict";
async function requireDocumentAccess(user, documentId) {
  if (!documentId || typeof documentId !== 'string') { const e=new Error('Choose a published chapter first.');e.status=400;throw e; }
  const query=new URLSearchParams({documentId,studentId:user.userId,schoolId:user.schoolId});
  const response=await fetch(`${process.env.LMS_SERVICE_URL || 'http://lms:3006'}/api/lms/internal/document-access?${query}`,{
    headers:{'X-Internal-Service-Token':process.env.INTERNAL_SERVICE_TOKEN || ''},signal:AbortSignal.timeout(5000)});
  if(!response.ok){const e=new Error(response.status===403?'This chapter is not available to your account.':'Chapter access could not be verified. Try again.');e.status=response.status===403?403:503;throw e;}
  return response.json();
}
async function accessibleDocumentIds(user) {
  const query = new URLSearchParams({studentId:user.userId, schoolId:user.schoolId});
  const response = await fetch(`${process.env.LMS_SERVICE_URL || 'http://lms:3006'}/api/lms/internal/student-documents?${query}`, {
    headers:{'X-Internal-Service-Token':process.env.INTERNAL_SERVICE_TOKEN || ''}, signal:AbortSignal.timeout(5000)});
  if (!response.ok) { const error=new Error('Chapter access could not be verified.'); error.status=503; throw error; }
  const payload=await response.json();
  if (!Array.isArray(payload.documentIds)) { const error=new Error('Invalid chapter access response.'); error.status=503; throw error; }
  return new Set(payload.documentIds);
}
module.exports={requireDocumentAccess, accessibleDocumentIds};
