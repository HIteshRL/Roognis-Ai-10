const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const interval = Math.max(1000, Number(process.env.WORKER_POLL_INTERVAL_MS || 5000));
const deliveryUrl = process.env.OUTBOX_DELIVERY_URL || '';

async function dispatch() {
  if (!deliveryUrl) return;
  const events = await prisma.outboxEvent.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 20 });
  for (const event of events) {
    const claimed = await prisma.outboxEvent.updateMany({ where: { id: event.id, status: 'PENDING' }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      const response = await fetch(deliveryUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-token': process.env.INTERNAL_SERVICE_TOKEN || '' }, body: JSON.stringify({ eventId: event.id, eventType: event.eventType, schemaVersion: event.schemaVersion, schoolId: event.schoolId, correlationId: event.correlationId, causationId: event.causationId, subject: { type: event.subjectType, id: event.subjectId }, data: event.payload }) });
      if (!response.ok) throw new Error(`delivery returned ${response.status}`);
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'DISPATCHED', dispatchedAt: new Date(), lastError: null } });
    } catch (error) {
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'PENDING', lastError: String(error.message).slice(0, 1000) } });
    }
  }
}

async function tick() { try { await dispatch(); } catch (error) { console.error('[school-ops-worker] tick failed:', error); } }
tick();
setInterval(tick, interval);
process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });
