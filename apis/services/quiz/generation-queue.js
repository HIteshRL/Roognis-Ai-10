'use strict';
// Service-owned PostgreSQL queue. The enqueue call MUST share the domain transaction.
const { randomUUID } = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function createQueue(prisma, schema) {
  if (!/^[a-z_]+$/.test(schema)) throw new Error('Invalid queue schema');
  const table = `"${schema}"."generation_tasks"`;
  let stopping = false;
  async function enqueue(tx, id, payload) {
    return tx.generationTask.upsert({ where: { id }, create: { id, payload }, update: {} });
  }
  async function claim() {
    const token = randomUUID();
    const rows = await prisma.$queryRawUnsafe(`UPDATE ${table} SET status='running', attempts=attempts+1, lease_token=$1,
      leased_until=now()+interval '120 seconds', updated_at=now()
      WHERE id=(SELECT id FROM ${table} WHERE (status='queued' AND available_at<=now())
        OR (status='running' AND leased_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, payload, attempts`, token);
    return rows[0] ? { ...rows[0], token } : null;
  }
  async function execute(job, handler) {
    const heartbeat = setInterval(() => prisma.$executeRawUnsafe(`UPDATE ${table} SET leased_until=now()+interval '120 seconds'
      WHERE id=$1::uuid AND lease_token=$2 AND status='running'`,job.id,job.token).catch(e=>console.error('[queue] heartbeat failed:', e.message)), 30000);
    try {
      if (job.attempts > 3) throw new Error('Maximum attempts exceeded');
      await handler(job.payload, job.id);
      await prisma.$executeRawUnsafe(`UPDATE ${table} SET status='succeeded', leased_until=NULL, lease_token=NULL, updated_at=now()
        WHERE id=$1::uuid AND lease_token=$2`,job.id,job.token);
    } catch(error) {
      await prisma.$executeRawUnsafe(`UPDATE ${table} SET status=$3, available_at=now()+interval '30 seconds',
        leased_until=NULL, lease_token=NULL, last_error=$4, updated_at=now() WHERE id=$1::uuid AND lease_token=$2`,
        job.id,job.token,job.attempts>=3?'failed':'queued',String(error.message).slice(0,500));
    } finally { clearInterval(heartbeat); }
  }
  async function start(handler, { concurrency = Number(process.env.GENERATION_CONCURRENCY || 2) } = {}) {
    concurrency = Math.max(1, Math.min(8, concurrency));
    return Promise.all(Array.from({length:concurrency},async()=>{
      while(!stopping){try{const job=await claim();if(job)await execute(job,handler);else await sleep(1000)}catch(e){console.error('[queue]',e.message);await sleep(3000)}}
    }));
  }
  return { enqueue, claim, execute, start, stop:()=>{stopping=true} };
}
module.exports = { createQueue };
