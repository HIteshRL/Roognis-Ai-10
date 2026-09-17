const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProviderBudget } = require('../provider-budget');
function response() {
 const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;
 res.status=n=>(res.statusCode=n,res);res.json=body=>(res.body=body,res);return res;
}
const req={user:{userId:'student-1',schoolId:'school-1'}};
test('unavailable budget fails closed without invoking generation',async()=>{
 const res=response();let called=false;
 await createProviderBudget({url:'',createClient:()=>{throw Error('unexpected')}})(req,res,()=>called=true);
 assert.equal(res.statusCode,503);assert.equal(called,false);
});
test('exhausted shared quota returns a retry interval',async()=>{
 const res=response();let called=false;
 await createProviderBudget({url:'redis://test',createClient:()=>({isOpen:true,on(){},eval:async()=>0})})(req,res,()=>called=true);
 assert.equal(res.statusCode,429);assert.equal(res.headers['Retry-After'],'60');assert.equal(called,false);
});
test('stream completion and close release its lease only once',async()=>{
 const res=response();let called=false;const removals=[];
 await createProviderBudget({url:'redis://test',createClient:()=>({isOpen:true,on(){},eval:async()=>1,zRem:async(...args)=>removals.push(args)})})(req,res,()=>called=true);
 assert.equal(called,true);res.emit('finish');res.emit('close');await Promise.resolve();assert.equal(removals.length,1);
});
test('reader-style budget degradation invokes a fallback instead of failing the page',async()=>{
 const fallbackReq={user:{userId:'student-1',schoolId:'school-1'}};
 const res=response();let called=false;
 await createProviderBudget({url:'',degradeToFallback:true,createClient:()=>{throw Error('unexpected')}})(fallbackReq,res,()=>called=true);
 assert.equal(called,true);assert.equal(fallbackReq.providerBudgetFallback,true);assert.equal(res.statusCode,undefined);
});
