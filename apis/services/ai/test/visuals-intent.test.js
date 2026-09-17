const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { routeVisualIntent, extractTopicText } = require('../visuals/intent');
const { VISUAL_KINDS } = require('../visuals/kinds');

describe('visual intent routing', () => {
  it('lets an explicit kind win over anything in the text', () => {
    const routed = routeVisualIntent('explain photosynthesis to me', { explicitKind: 'concept_map' });
    assert.equal(routed.kind, VISUAL_KINDS.CONCEPT_MAP);
    assert.equal(routed.source, 'explicit');
  });

  it('rejects an explicit kind nothing can render', () => {
    // A kind the router accepted but no renderer handles would 500 downstream.
    const routed = routeVisualIntent('anything', { explicitKind: 'hologram' });
    assert.equal(routed.kind, null);
    assert.equal(routed.source, null);
  });

  it('routes a request verb paired with a visual noun', () => {
    for (const message of [
      'draw a concept map of photosynthesis',
      'show me a mind map for cell structure',
      'can you make a diagram of the water cycle',
      'generate a chart of the digestive system',
    ]) {
      assert.equal(routeVisualIntent(message).kind, VISUAL_KINDS.CONCEPT_MAP, message);
    }
  });

  it('routes a terse noun-led request', () => {
    assert.equal(routeVisualIntent('concept map photosynthesis').kind, VISUAL_KINDS.CONCEPT_MAP);
    assert.equal(routeVisualIntent('mind map of cells').kind, VISUAL_KINDS.CONCEPT_MAP);
  });

  it('routes an explicit visualise request', () => {
    assert.equal(routeVisualIntent('visualise how friction works').kind, VISUAL_KINDS.CONCEPT_MAP);
    assert.equal(routeVisualIntent('visualize the water cycle').kind, VISUAL_KINDS.CONCEPT_MAP);
  });

  it('does not hijack a tutor question that merely mentions a visual', () => {
    // The defect isVideoRequest was written to fix, with a different noun. A
    // passing mention must still reach the tutor.
    for (const message of [
      'the chapter has a flowchart on page 4, can you explain it?',
      'I saw a concept map in class',
      'there is a diagram in the book, what does it mean',
      'I read a chart about rainfall, explain it',
    ]) {
      assert.equal(routeVisualIntent(message).kind, null, message);
    }
  });

  it('does not treat an ordinary relationship question as a visual request', () => {
    // These are the tempting patterns. A student asking how two ideas relate
    // wants an explanation, not a diagram — routing them into a generator is
    // the same over-trigger in a new costume.
    for (const message of [
      'what is the relationship between force and friction',
      'how do these ideas relate?',
      'how does photosynthesis connect to respiration',
      'explain the connection between mass and weight',
    ]) {
      assert.equal(routeVisualIntent(message).kind, null, message);
    }
  });

  it('routes an unambiguous interactive explainer request', () => {
    for (const message of [
      'make me an interactive explainer for pressure',
      'build a simulation of a lever',
      'create a demo of how friction changes with surface',
      'show me an animation of the water cycle',
    ]) {
      assert.equal(routeVisualIntent(message).kind, VISUAL_KINDS.EXPLAINER, message);
    }
  });

  it('routes a terse explainer request', () => {
    assert.equal(routeVisualIntent('interactive simulation of friction').kind, VISUAL_KINDS.EXPLAINER);
    assert.equal(routeVisualIntent('simulation of levers').kind, VISUAL_KINDS.EXPLAINER);
  });

  it('routes wanting to manipulate something to the explainer', () => {
    assert.equal(routeVisualIntent('let me play with the pressure values').kind, VISUAL_KINDS.EXPLAINER);
    assert.equal(routeVisualIntent('i want to try changing the angle').kind, VISUAL_KINDS.EXPLAINER);
  });

  // Both pattern sets match "interactive diagram". The more specific reading is
  // the right one, and order is the entire disambiguation strategy — there is
  // no scoring between kinds and there should not be.
  it('prefers the explainer when a request satisfies both kinds', () => {
    assert.equal(routeVisualIntent('show me an interactive diagram of levers').kind, VISUAL_KINDS.EXPLAINER);
    assert.equal(routeVisualIntent('make an interactive concept map').kind, VISUAL_KINDS.EXPLAINER);
  });

  it('does not treat the word interactive as a request on its own', () => {
    // "Interactive" is an ordinary word in a science chapter. A student asking
    // about interaction wants the tutor, exactly as with the visual nouns.
    for (const message of [
      'is friction interactive with surface area',
      'what does interactive mean in this chapter',
      'how do these two forces interact',
    ]) {
      assert.equal(routeVisualIntent(message).kind, null, message);
    }
  });

  it('still lets a mention veto an explainer request', () => {
    // MENTION_NOT_REQUEST is a global veto and must stay ahead of every kind.
    for (const message of [
      'I saw a simulation of this in class',
      'there is an animation in the book, explain it',
      'we watched a demo of levers yesterday',
    ]) {
      assert.equal(routeVisualIntent(message).kind, null, message);
    }
  });

  it('strips explainer request words out of the topic', () => {
    // Otherwise "simulation of friction" and "friction" key two different cache
    // entries for the same thing.
    assert.equal(extractTopicText('build an interactive simulation of friction'), 'friction');
    assert.equal(extractTopicText('make a demo of levers'), 'levers');
  });

  it('returns no kind for an empty or non-string message', () => {
    assert.equal(routeVisualIntent('').kind, null);
    assert.equal(routeVisualIntent(null).kind, null);
    assert.equal(routeVisualIntent(undefined).kind, null);
  });

  it('strips request scaffolding down to the topic', () => {
    assert.equal(extractTopicText('draw a concept map of photosynthesis'), 'photosynthesis');
    assert.equal(extractTopicText('show me a mind map for cell structure'), 'cell structure');
  });

  it('keeps a topic when stripping would empty it', () => {
    // "concept map" with no topic is still a legitimate request — it grounds on
    // the chapter as a whole rather than returning nothing.
    assert.ok(extractTopicText('concept map').length > 0);
  });
});
