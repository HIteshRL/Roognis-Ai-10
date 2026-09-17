const test=require('node:test');const assert=require('node:assert/strict');
const {accessibleDocumentIds}=require('../document-access');
test('revoked enrollment supplies an empty allowed document set',async()=>{
 const original=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({documentIds:[]})});
 try {assert.equal((await accessibleDocumentIds({userId:'student',schoolId:'school'})).size,0);} finally {global.fetch=original;}
});
test('malformed access response cannot expose due cards',async()=>{
 const original=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({})});
 try {await assert.rejects(accessibleDocumentIds({userId:'student',schoolId:'school'}),{status:503});} finally {global.fetch=original;}
});
