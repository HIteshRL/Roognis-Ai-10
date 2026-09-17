'use strict';

// Enqueue in the same database transaction as the assessment result.
// Delivery is at least once: PSV deduplicates stable event IDs.
async function enqueueEvidence(tx, events) {
  for (const event of events) {
    await tx.evidenceOutbox.upsert({
      where: { id: event.eventId }, create: { id: event.eventId, payload: event }, update: {},
    });
  }
}

async function drainEvidence(prisma, { url, token, fetchImpl = fetch, pendingRows = null }) {
  if (!url || !token) return 0;
  const rows = pendingRows || await prisma.evidenceOutbox.findMany({
    where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  if (!rows.length) return 0;
  try {
    const response = await fetchImpl(url.replace(/\/+$/, '') + '/api/psv/internal/events/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': token },
      body: JSON.stringify({ events: rows.map(row => row.payload) }), signal: AbortSignal.timeout(10000),
    });
    // Isolate a malformed/conflicting outcome instead of blocking valid rows
    // behind it. Failed single rows remain auditable and retryable.
    if ([400, 409, 422].includes(response.status) && rows.length > 1) {
      const middle = Math.ceil(rows.length / 2);
      const first = await drainEvidence(prisma, { url, token, fetchImpl, pendingRows: rows.slice(0, middle) });
      const second = await drainEvidence(prisma, { url, token, fetchImpl, pendingRows: rows.slice(middle) });
      return first + second;
    }
    if (!response.ok) throw new Error('PSV HTTP ' + response.status);
    const result = await response.json();
    const acknowledged = new Set(result.acceptedEventIds || []);
    const ids = rows.filter(row => acknowledged.has(row.id)).map(row => row.id);
    if (ids.length) await prisma.evidenceOutbox.updateMany({
      where: { id: { in: ids }, deliveredAt: null }, data: { deliveredAt: new Date(), lastError: null },
    });
    if (ids.length !== rows.length) throw new Error('Incomplete PSV acknowledgement');
    return ids.length;
  } catch (error) {
    for (const row of rows) {
      await prisma.evidenceOutbox.updateMany({
        where: { id: row.id, deliveredAt: null },
        data: { attempts: { increment: 1 }, lastError: String(error.message).slice(0, 240),
          nextAttemptAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8))) },
      });
    }
    return 0;
  }
}

function startEvidenceWorker(prisma, options) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await drainEvidence(prisma, options); }
    catch (error) { console.error('[evidence-outbox]', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
module.exports = { enqueueEvidence, drainEvidence, startEvidenceWorker };
