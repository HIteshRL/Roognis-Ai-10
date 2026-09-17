/**
 * Post-ranking insertion pass for videos in the Discover feed — a structural
 * mirror of cards/interleave.js's interleaveMicroArticles, not a density
 * heuristic. A video is only ever inserted before an 'article'-kind entry,
 * counting only articles toward the cadence (micro-article cards already
 * threaded into `items` by interleaveMicroArticles are skipped, not counted),
 * and never before the very first article — so a video is always genuinely
 * sandwiched BETWEEN articles, never leading the feed or adjacent to another
 * video with nothing article-shaped between them.
 *
 * Pure by design: no DB access, no Date.now()/new Date(), fully unit-testable
 * with plain arrays. `startIndex` is the page's absolute article offset,
 * consistent with interleaveMicroArticles's own absolute-position stability
 * across pagination.
 */
function interleaveVideos(items, videoQueue, { everyN = 8, startIndex = 0 } = {}) {
  const input = Array.isArray(items) ? items : [];
  const videos = Array.isArray(videoQueue) ? videoQueue : [];
  const out = [];
  let videoIndex = 0;
  let articleCount = 0;

  input.forEach(entry => {
    if (entry?.kind === 'article') {
      const absoluteIndex = startIndex + articleCount;
      if (absoluteIndex > 0 && absoluteIndex % everyN === 0 && videoIndex < videos.length) {
        out.push({ kind: 'video', video: videos[videoIndex] });
        videoIndex += 1;
      }
      articleCount += 1;
    }
    out.push(entry);
  });

  return out;
}

module.exports = { interleaveVideos };
