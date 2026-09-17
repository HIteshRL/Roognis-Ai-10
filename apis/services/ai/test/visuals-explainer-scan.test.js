/**
 * The static scan over model-authored explainer source.
 *
 * These tests pin the scan's behaviour, not the security of the feature — the
 * security is the opaque-origin sandbox and the CSP, and it is tested in
 * visuals-render-html.test.js. What is asserted here is that the scan fails
 * closed and says something a model can act on, because its message becomes the
 * correction turn.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scanExplainerSource, ExplainerScanError } = require('../visuals/explainer-scan');

const clean = {
  html: '<div id="box"><button id="go">Push harder</button><p id="out">0 N</p></div>',
  css: '#box { color: var(--ink); }',
  js: 'document.getElementById("go").addEventListener("click", () => { document.getElementById("out").textContent = "10 N"; });',
};

/**
 * Assert the scan rejects, and that the message names both the construct and
 * what to do instead — the remedy half is what stops attempt 2 repeating the
 * defect.
 */
function rejects(source, ...expectedFragments) {
  let error = null;
  try {
    scanExplainerSource({ ...clean, ...source });
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected the scan to reject this source');
  assert.equal(error.name, 'ExplainerScanError', 'should throw ExplainerScanError');
  for (const fragment of expectedFragments) {
    assert.ok(
      error.message.toLowerCase().includes(fragment.toLowerCase()),
      `message should mention "${fragment}" — it becomes the model's correction turn. Got: ${error.message}`
    );
  }
}

describe('explainer static scan', () => {
  it('accepts an ordinary interactive explainer', () => {
    assert.equal(scanExplainerSource(clean), true);
  });

  it('accepts an empty css field', () => {
    assert.equal(scanExplainerSource({ ...clean, css: '' }), true);
  });

  // Network access is the capability that would turn a renderer into a
  // reporter, so each of its spellings is covered rather than just fetch.
  for (const [label, js] of [
    ['fetch', 'fetch("/api/ai/chat")'],
    ['XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['WebSocket', 'new WebSocket("ws://x")'],
    ['EventSource', 'new EventSource("/stream")'],
    ['sendBeacon', 'navigator.sendBeacon("/log", data)'],
  ]) {
    it(`rejects ${label} and names the field`, () => {
      rejects({ js }, 'js', 'network');
    });
  }

  it('rejects dynamically evaluated code', () => {
    rejects({ js: 'eval("1+1")' }, 'js', 'dynamically evaluated');
    rejects({ js: 'const f = new Function("return 1");' }, 'dynamically evaluated');
  });

  // The common, honest mistake: a model remembering a slider position. The
  // message has to explain the reason, not just refuse.
  it('rejects storage and explains that an explainer records nothing', () => {
    rejects({ js: 'localStorage.setItem("pos", 3)' }, 'js', 'persistent storage', 'records nothing');
    rejects({ js: 'document.cookie = "a=1"' }, 'persistent storage');
  });

  it('rejects reaching for the surrounding page', () => {
    rejects({ js: 'window.parent.document.title' }, 'surrounding page');
    rejects({ js: 'parent.postMessage({h: 10}, "*")' }, 'surrounding page');
    rejects({ js: 'top.location.href' }, 'surrounding page');
  });

  it('rejects device and browser capabilities', () => {
    rejects({ js: 'navigator.geolocation.getCurrentPosition(cb)' }, 'device or browser capability');
    rejects({ js: 'navigator.clipboard.readText()' }, 'device or browser capability');
  });

  it('rejects navigation', () => {
    rejects({ js: 'location.href = "/profile"' }, 'js', 'navigation');
    rejects({ js: 'window.open("/x")' }, 'navigation');
  });

  it('rejects forbidden elements in markup', () => {
    rejects({ html: '<div id="a"></div><script>alert(1)</script>' }, 'html', 'forbidden element');
    rejects({ html: '<iframe id="a" src="x"></iframe>' }, 'forbidden element');
    rejects({ html: '<form id="a"><input></form>' }, 'forbidden element');
  });

  // Behaviour belongs in the js field, where the script rules apply to it. An
  // on* attribute is script that skipped the script rules.
  it('rejects inline event handler attributes', () => {
    rejects({ html: '<button id="go" onclick="alert(1)">Go</button>' }, 'html', 'inline event handler', 'addEventListener');
  });

  it('rejects javascript: URLs', () => {
    rejects({ html: '<a id="a" href="javascript:alert(1)">x</a>' }, 'html', 'javascript:');
  });

  it('rejects @import in styles', () => {
    rejects({ css: '@import url("https://fonts.example/x.css");' }, 'css', 'imported');
  });

  // The CSP already blocks the request. This rule exists so the model does not
  // ship an explainer whose picture is a broken image for every student.
  it('rejects an external reference in any field, explaining it cannot load', () => {
    rejects({ html: '<img id="a" src="https://example.com/a.png">' }, 'html', 'external address', 'cannot load');
    rejects({ js: 'const url = "https://cdn.example.com/lib.js";' }, 'js', 'external address');
    rejects({ css: '#a { background: url(//cdn.example.com/x.png); }' }, 'css', 'external address');
  });

  it('does not mistake an ordinary word for a capability', () => {
    // "important" contains "port", "topic" contains "top", "formatting"
    // contains "form" — a scan that fires on these would be unusable.
    assert.equal(scanExplainerSource({
      ...clean,
      html: '<div id="box"><p>This is important. The topic is formatting.</p></div>',
      js: 'const topSpeed = 10; const formatted = String(topSpeed); document.getElementById("out").textContent = formatted;',
    }), true);
  });
});
