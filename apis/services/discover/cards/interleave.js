/**
 * Post-ranking insertion pass for the Discover feed.
 *
 * `GET /api/discover/feed` ranks and paginates news articles first
 * (rankArticles / balanceNewsCategories, then `ordered.slice(offset, offset +
 * limit)`); this module never sees that math and never touches it — it only
 * decides where, among an already-final page of articles, a micro-article
 * card gets woven in. Interleaving position is plain code, not a ranking
 * dimension, matching CLAUDE.md's "no LLM in ranking/scoring/routing paths"
 * rule: even though nothing here is an LLM call, keeping this a separate,
 * pure, downstream-of-ranking module is what makes that boundary auditable.
 *
 * Pure by design: no DB access, no Date.now()/new Date(), no side effects —
 * fully unit-testable with plain arrays. `startIndex` is the page's absolute
 * offset in the overall feed, which is what keeps a card's insertion position
 * consistent across pagination instead of restarting the every-Nth counter at
 * 0 on every page.
 */
function interleaveMicroArticles(newsPage, queue, { everyN = 4, startIndex = 0 } = {}) {
  const articles = Array.isArray(newsPage) ? newsPage : [];
  const cards = Array.isArray(queue) ? queue : [];
  const items = [];
  let cardIndex = 0;

  articles.forEach((article, i) => {
    const absoluteIndex = startIndex + i;
    // Never insert before the very first article on the very first page
    // (absoluteIndex === 0) — a card must not be the first thing a student
    // sees before any news has rendered. Running out of cards mid-page is a
    // normal, non-error condition: the remaining slots simply stay plain
    // articles.
    if (absoluteIndex > 0 && absoluteIndex % everyN === 0 && cardIndex < cards.length) {
      items.push({ kind: 'micro_article', card: cards[cardIndex] });
      cardIndex += 1;
    }
    items.push({ kind: 'article', article });
  });

  return items;
}

module.exports = { interleaveMicroArticles };
