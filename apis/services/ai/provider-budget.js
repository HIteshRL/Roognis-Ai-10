'use strict';
const { randomUUID, createHash }=require('node:crypto');
// Shared Redis admission control. Browser retries cannot exceed the global stream cap.
function createProviderBudget({ createClient, url=process.env.REDIS_URL, maxConcurrent=Number(process.env.AI_MAX_CONCURRENT || 80), perMinute=Number(process.env.AI_USER_REQUESTS_PER_MINUTE || 12), schoolPerHour=Number(process.env.AI_SCHOOL_REQUESTS_PER_HOUR || 10000), degradeToFallback=false }={}) {
 let client, connecting;
 async function redis(){
  if(!url)throw new Error('AI admission control is not configured');
  if(!client){client=createClient({url,socket:{connectTimeout:2000,reconnectStrategy:false}});client.on('error',()=>{});}
  if(!client.isOpen){connecting ||= client.connect().finally(()=>{connecting=null});await connecting;}
  return client;
 }
 return async function budget(req,res,next){
  const token=randomUUID(),now=Date.now();
  const user=createHash('sha256').update(`${req.user.schoolId}:${req.user.userId}`).digest('hex');
  const school=createHash('sha256').update(req.user.schoolId).digest('hex');
  const globalKey='roognis:ai:active',userKey='roognis:ai:user:'+user,schoolKey='roognis:ai:school:'+school+':'+Math.floor(now/3600000);
  let db;
  try{
   db=await redis();
   const accepted=await db.eval(`
    redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1])
    redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[2])
    if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) or redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[5]) or tonumber(redis.call('GET',KEYS[3]) or '0')>=tonumber(ARGV[6]) then return 0 end
    redis.call('ZADD',KEYS[1],ARGV[3],ARGV[7]);redis.call('EXPIRE',KEYS[1],180)
    redis.call('ZADD',KEYS[2],ARGV[8],ARGV[7]);redis.call('EXPIRE',KEYS[2],120)
    redis.call('INCR',KEYS[3]);redis.call('EXPIRE',KEYS[3],7200)
    return 1`,{keys:[globalKey,userKey,schoolKey],arguments:[String(now),String(now-60000),String(now+120000),String(maxConcurrent),String(perMinute),String(schoolPerHour),token,String(now)]});
   if(!accepted){
    if(degradeToFallback){req.providerBudgetFallback=true;return next();}
    res.setHeader('Retry-After','60');return res.status(429).json({error:'The tutor is busy or your learning allowance has been reached. Please try again shortly.'});
   }
  }catch(error){
   if(degradeToFallback){req.providerBudgetFallback=true;return next();}
   return res.status(503).json({error:'The AI service is temporarily unavailable. Your coursework is still available.'});
  }
  let released=false;
  const heartbeat=setInterval(()=>db.zAdd(globalKey,[{score:Date.now()+120000,value:token}],{XX:true}).catch(()=>{}),30000);
  function release(){if(released)return;released=true;clearInterval(heartbeat);db.zRem(globalKey,token).catch(()=>{});}
  res.once('close',release);res.once('finish',release);next();
 };
}
module.exports={createProviderBudget};
