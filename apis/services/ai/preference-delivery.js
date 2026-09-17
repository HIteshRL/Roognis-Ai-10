'use strict';
// Stores message references only; assessment endpoints never enqueue here.
async function deliverPreferenceObservations(prisma, { url, token, fetchImpl = fetch }) {
  if (!url || !token) return;
  const jobs = await prisma.preferenceDelivery.findMany({
    where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } }, take: 30, orderBy: { createdAt: 'asc' },
  });
  for (const job of jobs) {
    try {
      const message = await prisma.message.findUnique({ where: { id: job.messageId }, select: { content: true, role: true } });
      if (message?.role === 'user') {
        const response = await fetchImpl(url.replace(/\/+$/, '') + '/api/discover/internal/preference-observations', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': token },
          body: JSON.stringify({ studentId: job.studentId, messageId: job.messageId, text: message.content }),
          signal: AbortSignal.timeout(2500),
        });
        if (!response.ok) throw new Error('Discover HTTP ' + response.status);
      }
      await prisma.preferenceDelivery.update({ where: { messageId: job.messageId }, data: { deliveredAt: new Date(), lastError: null } });
    } catch (error) {
      await prisma.preferenceDelivery.update({ where: { messageId: job.messageId },
        data: { attempts: { increment: 1 }, lastError: String(error.message).slice(0, 240),
          nextAttemptAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 8))) } });
    }
  }
}
function startPreferenceDelivery(prisma, options) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await deliverPreferenceObservations(prisma, options); }
    catch (error) { console.warn('[preference-delivery]', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
module.exports = { deliverPreferenceObservations, startPreferenceDelivery };
