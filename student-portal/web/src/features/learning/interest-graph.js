/* Discover's presentation-only graph. No preference writes or external dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RoognisInterestGraph = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CLUSTERS = {
    science: "Science",
    tech: "Technology",
    business: "Business",
    civic: "Current affairs",
    sports: "Sport",
    culture: "Culture",
    health: "Health",
    education: "Education",
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const weight = (n) => (Number.isFinite(n) ? Math.max(0, n) : 0);
  const confirmed = (n) =>
    n.origin === "confirmed" || n.origin === "onboarding";
  function hash(text) {
    let h = 2166136261;
    for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  function prepareGraph(graph = {}) {
    const byId = new Map();
    for (const source of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!source || typeof source.id !== "string" || byId.has(source.id))
        continue;
      byId.set(source.id, {
        id: source.id,
        label: String(source.label || source.id),
        kind: String(source.kind || "interest"),
        cluster: String(source.cluster || ""),
        origin: source.origin,
        weight: weight(source.weight),
        neighbors: new Set(),
        vx: 0,
        vy: 0,
      });
    }
    const nodes = [...byId.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const edges = (Array.isArray(graph.edges) ? graph.edges : [])
      .filter((e) => e && e.from !== e.to && byId.has(e.from) && byId.has(e.to))
      .map((e) => ({
        source: byId.get(e.from),
        target: byId.get(e.to),
        weight: weight(e.weight),
      }));
    edges.forEach((e) => {
      e.source.neighbors.add(e.target.id);
      e.target.neighbors.add(e.source.id);
    });
    // Obsidian-like graphs put connected hubs in the core and let weakly connected
    // nodes form the outer halo. ID remains the stable tiebreaker.
    const layoutOrder = [...nodes].sort(
      (a, b) => b.neighbors.size - a.neighbors.size || a.id.localeCompare(b.id),
    );
    layoutOrder.forEach((n, i) => {
      // A compact phyllotaxis seed avoids the large, ID-ordered spiral shown by the previous renderer.
      const angle =
        i * Math.PI * (3 - Math.sqrt(5)) + (hash(n.id) % 100) / 1000;
      const radius = 12 * Math.sqrt(i);
      n.x = Math.cos(angle) * radius;
      n.y = Math.sin(angle) * radius;
      n.radius = 3 + Math.min(5, Math.sqrt(n.neighbors.size) * 1.15);
    });
    return {
      nodes,
      edges,
      byId,
      summary: graph.summary || {},
      maxWeight: Math.max(1, ...nodes.map((n) => n.weight)),
    };
  }

  // One bounded tick; callers spread ticks over frames. World coordinates are never clamped.
  function tick(graph, alpha, nodeScale = 1) {
    const { nodes, edges } = graph;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x,
          dy = a.y - b.y;
        if (dx === 0 && dy === 0) {
          dx = ((hash(a.id) % 11) + 1) * 0.01;
          dy = 0.1;
        }
        const distance = Math.max(0.1, Math.hypot(dx, dy));
        const collision = (a.radius + b.radius) * nodeScale + 12;
        const force =
          Math.min(8, (950 * alpha) / (distance * distance)) +
          Math.max(0, collision - distance) * 0.2;
        const fx = (dx / distance) * force,
          fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    for (const e of edges) {
      const dx = e.target.x - e.source.x,
        dy = e.target.y - e.source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force =
        (distance - 58) * 0.035 * alpha * (0.65 + Math.min(1, e.weight));
      const fx = (dx / distance) * force,
        fy = (dy / distance) * force;
      // Hubs should not swallow their satellites.
      const a = 1 / Math.sqrt(e.source.neighbors.size || 1),
        b = 1 / Math.sqrt(e.target.neighbors.size || 1);
      e.source.vx += fx * a;
      e.source.vy += fy * a;
      e.target.vx -= fx * b;
      e.target.vy -= fy * b;
    }
    let movement = 0,
      centerX = 0,
      centerY = 0,
      movable = 0;
    for (const n of nodes) {
      if (n.pinned) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      // Center attraction controls compactness. Connected nodes pull toward the
      // center more strongly, while orphans settle into a surrounding halo.
      const centerForce = n.neighbors.size ? 0.012 : 0.006;
      n.vx = (n.vx - n.x * centerForce * alpha) * 0.72;
      n.vy = (n.vy - n.y * centerForce * alpha) * 0.72;
      n.x += n.vx;
      n.y += n.vy;
      centerX += n.x;
      centerY += n.y;
      movable++;
      movement = Math.max(movement, Math.abs(n.vx), Math.abs(n.vy));
    }
    // forceCenter: prevent a small numerical imbalance from drifting the whole
    // graph away from the viewport center. Do not move the world during a drag.
    if (movable === nodes.length && movable) {
      centerX /= movable;
      centerY /= movable;
      for (const n of nodes) {
        n.x -= centerX;
        n.y -= centerY;
      }
    }
    return movement;
  }

  function fitView(nodes, width, height, nodeScale = 1) {
    if (!nodes.length) return { x: width / 2, y: height / 2, scale: 1 };
    // Center on the perceptual core (degree-weighted), while fitting every node
    // inside a quiet outer margin. Exact bounding-box centering let outliers pull
    // the main cluster visibly to one side.
    let total = 0,
      centerX = 0,
      centerY = 0;
    for (const n of nodes) {
      const importance = Math.sqrt(n.neighbors.size + 1);
      centerX += n.x * importance;
      centerY += n.y * importance;
      total += importance;
    }
    centerX /= total;
    centerY /= total;
    const extentX = Math.max(
      40,
      ...nodes.map((n) => Math.abs(n.x - centerX) + n.radius * nodeScale),
    );
    const extentY = Math.max(
      40,
      ...nodes.map((n) => Math.abs(n.y - centerY) + n.radius * nodeScale),
    );
    const scale = clamp(
      Math.min((width * 0.72) / (extentX * 2), (height * 0.72) / (extentY * 2)),
      0.08,
      2,
    );
    return {
      x: width / 2 - centerX * scale,
      y: height / 2 - centerY * scale,
      scale,
    };
  }

  function zoomAt(view, point, scale) {
    scale = clamp(scale, 0.08, 8);
    const ratio = scale / view.scale;
    return {
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
      scale,
    };
  }

  // Prioritize focused neighborhoods, then degree. Grid buckets bound collision checks for 400 labels.
  function labelLayout(
    nodes,
    view,
    width,
    height,
    { activeId = null, nodeScale = 1, labels = 1, activeCluster = null } = {},
  ) {
    const active = nodes.find((n) => n.id === activeId);
    const rank = (n) =>
      n.id === activeId ? 3 : active?.neighbors.has(n.id) ? 2 : 1;
    const ordered = [...nodes].sort(
      (a, b) =>
        rank(b) - rank(a) ||
        b.neighbors.size - a.neighbors.size ||
        a.id.localeCompare(b.id),
    );
    const cells = new Map(),
      result = new Map();
    for (const n of ordered) {
      const priority = rank(n),
        important = priority > 1;
      const x = n.x * view.scale + view.x,
        y = n.y * view.scale + view.y + n.radius * nodeScale * view.scale + 12;
      const opacity = important
        ? 1
        : clamp(
            (view.scale * labels -
              0.35 +
              Math.min(4, n.neighbors.size) * 0.07) /
              0.65,
            0,
            0.85,
          );
      if (
        opacity === 0 ||
        (!important && activeCluster && n.cluster !== activeCluster)
      )
        continue;
      const labelWidth = n.labelWidth || Math.min(210, n.label.length * 6.5);
      const box = {
        left: x - labelWidth / 2 - 3,
        right: x + labelWidth / 2 + 3,
        top: y - 11,
        bottom: y + 4,
      };
      if (
        box.left < 4 ||
        box.right > width - 4 ||
        box.top < 4 ||
        box.bottom > height - 4
      )
        continue;
      const keys = [];
      for (
        let gx = Math.floor(box.left / 64);
        gx <= Math.floor(box.right / 64);
        gx++
      ) {
        for (
          let gy = Math.floor(box.top / 24);
          gy <= Math.floor(box.bottom / 24);
          gy++
        )
          keys.push(`${gx}:${gy}`);
      }
      const overlap = keys.some((key) =>
        (cells.get(key) || []).some(
          (b) =>
            box.left < b.right &&
            box.right > b.left &&
            box.top < b.bottom &&
            box.bottom > b.top,
        ),
      );
      if (overlap && priority !== 3) continue;
      keys.forEach((key) => {
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(box);
      });
      result.set(n.id, { x, y, opacity });
    }
    return result;
  }

  function element(tag, attrs = {}, text) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs))
      el.setAttribute(key, value);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function svgElement(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs))
      el.setAttribute(key, value);
    return el;
  }

  let activeController = null;
  function mount({
    trigger = document.activeElement,
    loadGraph,
    onClose,
  } = {}) {
    activeController?.destroy();
    const life = new AbortController();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dialog = element("dialog", {
      class: "ig-dialog",
      "aria-labelledby": "ig-title",
    });
    dialog.innerHTML = `
      <header class="ig-header"><div><h2 id="ig-title">Your interests</h2><span class="ig-count" aria-live="polite">Loading your map…</span></div>
        <div class="ig-header-actions"><button type="button" data-ig-panel="list" aria-expanded="false" aria-controls="ig-list-panel">Node list</button>
          <button type="button" data-ig-panel="settings" aria-expanded="false" aria-controls="ig-settings-panel" aria-label="Graph settings">⚙<span class="ig-wide-label"> Settings</span></button>
          <button type="button" data-ig-close aria-label="Close interest graph">✕</button></div></header>
      <div class="ig-workspace"><div class="ig-stage">
        <svg class="ig-svg" tabindex="0" role="group" aria-label="Interest graph. Drag to pan, scroll to zoom. Use arrow keys to pan, plus and minus to zoom. Use the node list to select an interest.">
          <g class="ig-viewport" aria-hidden="true"><g class="ig-edges"></g><g class="ig-nodes"></g></g><g class="ig-labels" aria-hidden="true"></g></svg>
        <div class="ig-message" role="status">Loading your interest map…</div>
        <div class="ig-navigation" role="group" aria-label="Graph navigation"><button type="button" data-ig-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-ig-zoom="in" aria-label="Zoom in">+</button><button type="button" data-ig-fit aria-label="Fit graph to view">⌖</button></div>
        <div class="ig-hint" aria-hidden="true">Drag to explore · Scroll to zoom</div>
      </div><aside class="ig-panel" id="ig-settings-panel" aria-label="Graph settings" hidden>
        <div class="ig-panel-heading"><h3>Graph settings</h3><button type="button" data-ig-dismiss aria-label="Close settings">✕</button></div>
        <label class="ig-setting">Node size<input type="range" data-ig-setting="nodeScale" min="0.65" max="2" step="0.05" value="1"></label>
        <label class="ig-setting">Link width<input type="range" data-ig-setting="linkWidth" min="0.4" max="2" step="0.1" value="0.8"></label>
        <label class="ig-setting">Label visibility<input type="range" data-ig-setting="labels" min="0" max="2" step="0.1" value="1"></label>
        <h4>Highlight a cluster</h4><div class="ig-clusters"></div><button type="button" data-ig-defaults>Restore defaults</button>
        <details class="ig-summary"><summary>Interest summary</summary><div class="ig-summary-content"></div></details>
      </aside><aside class="ig-panel" id="ig-list-panel" aria-label="Interest node list" hidden>
        <div class="ig-panel-heading"><h3>All interests</h3><button type="button" data-ig-dismiss aria-label="Close node list">✕</button></div>
        <p class="ig-list-description">Select an interest to view its connections.</p><ul class="ig-node-list"></ul>
      </aside><aside class="ig-panel ig-detail" aria-label="Selected interest" hidden></aside></div>`;
    document.body.append(dialog);
    const q = (selector) => dialog.querySelector(selector);
    const svg = q(".ig-svg"),
      stage = q(".ig-stage"),
      viewport = q(".ig-viewport");
    const message = q(".ig-message"),
      detail = q(".ig-detail");
    const settings = {
      nodeScale: 1,
      linkWidth: 0.8,
      labels: 1,
      activeCluster: null,
    };
    const pointers = new Map(),
      nodeElements = new Map(),
      edgeElements = [],
      labelElements = new Map();
    let graph = null,
      destroyed = false,
      frame = 0,
      timeout = 0,
      fetchController = null;
    let width = 1,
      height = 1,
      view = { x: 0, y: 0, scale: 1 },
      selectedId = null,
      hoverId = null;
    let alpha = 0,
      ticks = 0,
      autoFit = true,
      gesture = null,
      panel = null,
      previousFrame = 0;
    let layoutReady = false;
    const listen = (el, type, fn, options = {}) =>
      el.addEventListener(type, fn, { ...options, signal: life.signal });
    function schedule() {
      if (!destroyed && !frame && !document.hidden)
        frame = requestAnimationFrame(render);
    }
    function wake() {
      if (!graph) return;
      alpha = 0.8;
      ticks = 0;
      schedule();
    }
    function dimensions() {
      const box = stage.getBoundingClientRect(),
        nextWidth = Math.max(1, box.width),
        nextHeight = Math.max(1, box.height);
      view.x += (nextWidth - width) / 2;
      view.y += (nextHeight - height) / 2;
      width = nextWidth;
      height = nextHeight;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      schedule();
    }
    const resize = new ResizeObserver(dimensions);
    function showPanel(name) {
      panel = name;
      q("#ig-settings-panel").hidden = name !== "settings";
      q("#ig-list-panel").hidden = name !== "list";
      detail.hidden = name !== "detail";
      dialog
        .querySelectorAll("[data-ig-panel]")
        .forEach((el) =>
          el.setAttribute("aria-expanded", String(el.dataset.igPanel === name)),
        );
      dimensions();
    }
    function closePanel() {
      const oldPanel = panel;
      showPanel(null);
      if (oldPanel === "settings" || oldPanel === "list")
        q(`[data-ig-panel="${oldPanel}"]`).focus();
      else svg.focus();
    }
    function highlight() {
      if (!graph) return;
      const active = graph.byId.get(hoverId || selectedId);
      for (const n of graph.nodes) {
        const el = nodeElements.get(n.id);
        const neighborhood =
          !active || n === active || active.neighbors.has(n.id);
        const cluster =
          !settings.activeCluster || n.cluster === settings.activeCluster;
        el.classList.toggle("is-muted", !neighborhood || !cluster);
        el.classList.toggle("is-active", n === active);
        el.classList.toggle("is-selected", n.id === selectedId);
        el.setAttribute("aria-pressed", String(n.id === selectedId));
      }
      edgeElements.forEach(({ edge, el }) => {
        const touches =
          active && (edge.source === active || edge.target === active);
        const inCluster =
          !settings.activeCluster ||
          edge.source.cluster === settings.activeCluster ||
          edge.target.cluster === settings.activeCluster;
        el.classList.toggle("is-active", Boolean(touches));
        el.classList.toggle(
          "is-muted",
          Boolean(active && !touches) || !inCluster,
        );
      });
      schedule();
    }
    function select(id, center = false) {
      if (!graph) return;
      selectedId = graph.byId.has(id) ? id : null;
      const node = graph.byId.get(selectedId);
      if (!node) {
        if (panel === "detail") closePanel();
        highlight();
        return;
      }
      detail.replaceChildren();
      const heading = element("div", { class: "ig-panel-heading" });
      const title = element("h3", { tabindex: "-1" }, node.label);
      heading.append(
        title,
        element(
          "button",
          {
            type: "button",
            "data-ig-clear": "",
            "aria-label": "Close interest details",
          },
          "✕",
        ),
      );
      detail.append(
        heading,
        element(
          "p",
          { class: "ig-detail-type" },
          [CLUSTERS[node.cluster], node.kind].filter(Boolean).join(" · "),
        ),
        element(
          "p",
          {},
          confirmed(node)
            ? "You confirmed this interest"
            : "Inferred from reading",
        ),
        element(
          "p",
          {},
          `${Math.round((node.weight / graph.maxWeight) * 100)}% relative affinity`,
        ),
        element(
          "h4",
          {},
          `${node.neighbors.size} ${node.neighbors.size === 1 ? "connection" : "connections"}`,
        ),
      );
      const neighbors = element("ul", { class: "ig-neighbor-list" });
      [...node.neighbors]
        .map((nid) => graph.byId.get(nid))
        .sort((a, b) => a.label.localeCompare(b.label))
        .forEach((n) => {
          const item = element("li");
          item.append(
            element(
              "button",
              { type: "button", "data-ig-select": n.id },
              n.label,
            ),
          );
          neighbors.append(item);
        });
      detail.append(neighbors);
      if (!node.neighbors.size)
        detail.append(element("p", {}, "No connections in this map yet."));
      showPanel("detail");
      if (center) {
        autoFit = false;
        view.x = width / 2 - node.x * view.scale;
        view.y = height / 2 - node.y * view.scale;
      }
      title.focus({ preventScroll: true });
      highlight();
    }
    function render(now) {
      frame = 0;
      if (destroyed || !graph) return;
      if (alpha > 0 && !document.hidden) {
        const start = performance.now();
        let movement = 0;
        // At most three O(n²) ticks and an 8ms budget per frame at the API's 400-node limit.
        for (let i = 0; i < 3; i++) {
          movement = tick(graph, alpha, settings.nodeScale);
          alpha *= 0.978;
          ticks++;
          if (performance.now() - start > 8) break;
        }
        if (ticks >= 300 || (alpha < 0.012 && movement < 0.06)) alpha = 0;
      }
      if (!alpha) {
        layoutReady = true;
        q(".ig-count").textContent =
          `${graph.nodes.length} interests · ${graph.edges.length} connections`;
      }
      if (autoFit)
        view = fitView(graph.nodes, width, height, settings.nodeScale);
      viewport.setAttribute(
        "transform",
        `translate(${view.x},${view.y}) scale(${view.scale})`,
      );
      viewport.style.setProperty("--ig-link-width", settings.linkWidth);
      for (const n of graph.nodes) {
        const group = nodeElements.get(n.id);
        group.setAttribute("transform", `translate(${n.x},${n.y})`);
        group
          .querySelector(".ig-dot")
          .setAttribute("r", n.radius * settings.nodeScale);
        group
          .querySelector(".ig-hit")
          .setAttribute(
            "r",
            Math.max(n.radius * settings.nodeScale, 12 / view.scale),
          );
      }
      edgeElements.forEach(({ edge: e, el }) => {
        el.setAttribute("x1", e.source.x);
        el.setAttribute("y1", e.source.y);
        el.setAttribute("x2", e.target.x);
        el.setAttribute("y2", e.target.y);
      });
      // Reduced motion computes the same final layout in small batches, without displaying travel.
      const reveal = !media.matches || layoutReady;
      viewport.style.visibility = reveal ? "" : "hidden";
      q(".ig-labels").style.visibility = reveal ? "" : "hidden";
      message.hidden = reveal;
      if (!reveal) message.textContent = "Arranging your interests…";
      if (!alpha || now - previousFrame > 45 || pointers.size) {
        const labels = labelLayout(graph.nodes, view, width, height, {
          ...settings,
          activeId: hoverId || selectedId,
        });
        labelElements.forEach((el, id) => {
          const label = labels.get(id);
          el.setAttribute("opacity", label ? label.opacity : 0);
          if (label) {
            el.setAttribute("x", label.x);
            el.setAttribute("y", label.y);
          }
          el.classList.toggle("is-active", id === (hoverId || selectedId));
        });
        previousFrame = now;
      }
      if (alpha > 0) schedule();
    }
    function populate(data) {
      graph = prepareGraph(data);
      q(".ig-count").textContent =
        `${graph.nodes.length} interests · ${graph.edges.length} connections`;
      message.hidden = Boolean(graph.nodes.length);
      if (!graph.nodes.length) {
        message.textContent =
          "Nothing mapped yet. Open stories in Discover to build your interest map.";
        return;
      }
      const measure = document.createElement("canvas").getContext("2d");
      if (measure) measure.font = `12px ${getComputedStyle(dialog).fontFamily}`;
      graph.nodes.forEach((n) => {
        const group = svgElement("g", {
          class: "ig-node",
          "data-id": n.id,
          "data-cluster": n.cluster,
          "data-kind": n.kind,
          role: "button",
          "aria-label": n.label,
          "aria-pressed": "false",
        });
        group.append(
          svgElement("circle", { class: "ig-hit" }),
          svgElement("circle", { class: "ig-dot" }),
        );
        const title = svgElement("title");
        title.textContent = n.label;
        group.append(title);
        nodeElements.set(n.id, group);
        q(".ig-nodes").append(group);
        let text = n.label;
        if (measure) {
          while (text.length > 1 && measure.measureText(text).width > 196)
            text = text.slice(0, -1);
        } else text = text.slice(0, 30);
        if (text !== n.label) text += "…";
        n.labelWidth = measure
          ? measure.measureText(text).width
          : text.length * 6.5;
        const label = svgElement("text", {
          class: "ig-label",
          "text-anchor": "middle",
        });
        label.textContent = text;
        labelElements.set(n.id, label);
        q(".ig-labels").append(label);
      });
      graph.edges.forEach((edge) => {
        const el = svgElement("line", {
          class: "ig-edge",
          "vector-effect": "non-scaling-stroke",
        });
        q(".ig-edges").append(el);
        edgeElements.push({ edge, el });
      });
      [...graph.nodes]
        .sort((a, b) => a.label.localeCompare(b.label))
        .forEach((n) => {
          const li = element("li");
          li.append(
            element(
              "button",
              { type: "button", "data-ig-select": n.id },
              n.label,
            ),
          );
          q(".ig-node-list").append(li);
        });
      [...new Set(graph.nodes.map((n) => n.cluster).filter(Boolean))]
        .sort()
        .forEach((cluster) => {
          q(".ig-clusters").append(
            element(
              "button",
              {
                type: "button",
                "data-ig-cluster": cluster,
                "data-cluster": cluster,
                "aria-pressed": "false",
              },
              CLUSTERS[cluster] || cluster,
            ),
          );
        });
      if (!q(".ig-clusters").children.length)
        q(".ig-clusters").textContent = "No topic clusters yet.";
      const summary = q(".ig-summary-content"),
        s = graph.summary;
      const affinities = [
        ["Science", "scienceAffinity", "science"],
        ["Technology", "techAffinity", "tech"],
        ["Sport", "sportsAffinity", "sports"],
        ["Culture", "cultureAffinity", "culture"],
        ["Business", "businessAffinity", "business"],
        ["Current affairs", "civicEngagement", "civic"],
        ["Hobbies and interests", "personalAffinity", "education"],
      ];
      affinities
        .filter(([, key]) => weight(s[key]) > 0)
        .sort((a, b) => s[b[1]] - s[a[1]])
        .forEach(([label, key, cluster]) => {
          const pct = Math.round(clamp(weight(s[key]), 0, 1) * 100);
          const row = element("div", {
            class: "ig-affinity",
            "data-cluster": cluster,
          });
          row.append(
            element("span", {}, label),
            element("span", {}, `${pct}%`),
          );
          const meter = element("meter", {
            min: "0",
            max: "100",
            value: String(pct),
            "aria-label": label,
          });
          row.append(meter);
          summary.append(row);
        });
      const entities = Array.isArray(s.topEntities)
        ? s.topEntities.slice(0, 6)
        : [];
      if (entities.length) {
        summary.append(element("h4", {}, "Names you follow"));
        entities.forEach((e) =>
          summary.append(element("p", {}, String(e.key || ""))),
        );
      }
      summary.append(
        element(
          "p",
          { class: "ig-summary-note" },
          "Your Discover interests help your tutor choose examples. They do not change what you are taught.",
        ),
      );
      wake();
    }
    async function load() {
      const request = new AbortController();
      fetchController = request;
      timeout = setTimeout(() => request.abort(), 30000);
      try {
        const data = await loadGraph(request.signal);
        if (!destroyed && fetchController === request) populate(data);
      } catch (error) {
        if (destroyed || fetchController !== request) return;
        q(".ig-count").textContent = "Map unavailable";
        message.replaceChildren(
          element(
            "p",
            {},
            "Could not load your interest map. Please try again.",
          ),
          element("button", { type: "button", "data-ig-retry": "" }, "Retry"),
        );
      } finally {
        if (fetchController === request) {
          clearTimeout(timeout);
          fetchController = null;
        }
      }
    }
    const localPoint = (event) => {
      const r = svg.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };
    const worldPoint = (p) => ({
      x: (p.x - view.x) / view.scale,
      y: (p.y - view.y) / view.scale,
    });
    function startPinch() {
      if (gesture?.node) gesture.node.pinned = false;
      const [a, b] = [...pointers.values()];
      gesture = {
        type: "pinch",
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        anchor: worldPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
        scale: view.scale,
        moved: true,
      };
    }
    listen(svg, "pointerdown", (event) => {
      if (
        !graph?.nodes.length ||
        (event.pointerType === "mouse" && event.button !== 0) ||
        pointers.size >= 2
      )
        return;
      event.preventDefault();
      svg.focus({ preventScroll: true });
      autoFit = false;
      const point = localPoint(event);
      pointers.set(event.pointerId, point);
      svg.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        startPinch();
        return;
      }
      const node = graph.byId.get(
        event.target.closest("[data-id]")?.dataset.id,
      );
      const world = worldPoint(point);
      gesture = {
        type: node ? "node" : "pan",
        node,
        start: point,
        view: { ...view },
        moved: false,
        offset: node ? { x: node.x - world.x, y: node.y - world.y } : null,
      };
      svg.classList.add("is-dragging");
    });
    listen(svg, "pointermove", (event) => {
      const point = localPoint(event);
      if (!pointers.has(event.pointerId)) {
        if (event.pointerType === "touch") return;
        const id = event.target.closest("[data-id]")?.dataset.id || null;
        if (id !== hoverId) {
          hoverId = id;
          highlight();
        }
        return;
      }
      pointers.set(event.pointerId, point);
      if (gesture.type === "pinch" && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const scale = clamp(
          (gesture.scale * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.distance,
          0.08,
          8,
        );
        view = {
          x: (a.x + b.x) / 2 - gesture.anchor.x * scale,
          y: (a.y + b.y) / 2 - gesture.anchor.y * scale,
          scale,
        };
      } else {
        const dx = point.x - gesture.start.x,
          dy = point.y - gesture.start.y;
        if (Math.hypot(dx, dy) > 5) gesture.moved = true;
        if (!gesture.moved) return;
        if (gesture.type === "node") {
          const world = worldPoint(point),
            n = gesture.node;
          n.pinned = true;
          n.x = world.x + gesture.offset.x;
          n.y = world.y + gesture.offset.y;
          if (!media.matches) wake();
        } else {
          view.x = gesture.view.x + dx;
          view.y = gesture.view.y + dy;
        }
      }
      schedule();
    });
    function release(event) {
      if (!pointers.has(event.pointerId)) return;
      const finished = gesture;
      pointers.delete(event.pointerId);
      if (svg.hasPointerCapture(event.pointerId))
        svg.releasePointerCapture(event.pointerId);
      if (finished?.node) {
        finished.node.pinned = false;
        if (finished.moved && !media.matches) wake();
      }
      if (pointers.size) {
        gesture = {
          type: "pan",
          start: [...pointers.values()][0],
          view: { ...view },
          moved: true,
        };
      } else {
        gesture = null;
        svg.classList.remove("is-dragging");
        if (event.type === "pointerup" && !finished?.moved)
          select(finished?.node?.id || null);
      }
    }
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
      listen(svg, type, release),
    );
    listen(svg, "pointerleave", () => {
      hoverId = null;
      highlight();
    });
    listen(
      svg,
      "wheel",
      (event) => {
        event.preventDefault();
        autoFit = false;
        const delta =
          event.deltaY *
          (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
        view = zoomAt(
          view,
          localPoint(event),
          view.scale * Math.exp(-clamp(delta, -200, 200) * 0.003),
        );
        schedule();
      },
      { passive: false },
    );
    listen(svg, "keydown", (event) => {
      const amount = event.shiftKey ? 100 : 35;
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        autoFit = false;
        view.x +=
          event.key === "ArrowLeft"
            ? amount
            : event.key === "ArrowRight"
              ? -amount
              : 0;
        view.y +=
          event.key === "ArrowUp"
            ? amount
            : event.key === "ArrowDown"
              ? -amount
              : 0;
        schedule();
      } else if (["+", "=", "-"].includes(event.key)) {
        event.preventDefault();
        autoFit = false;
        view = zoomAt(
          view,
          { x: width / 2, y: height / 2 },
          view.scale * (event.key === "-" ? 1 / 1.25 : 1.25),
        );
        schedule();
      } else if (event.key === "Home") {
        event.preventDefault();
        autoFit = true;
        schedule();
      }
    });
    listen(dialog, "click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.hasAttribute("data-ig-close")) {
        destroy();
        return;
      }
      if (button.hasAttribute("data-ig-dismiss")) {
        closePanel();
        return;
      }
      if (button.hasAttribute("data-ig-clear")) {
        select(null);
        return;
      }
      if (button.hasAttribute("data-ig-panel")) {
        showPanel(
          panel === button.dataset.igPanel ? null : button.dataset.igPanel,
        );
        return;
      }
      if (button.hasAttribute("data-ig-select")) {
        hoverId = null;
        select(button.dataset.igSelect, true);
        return;
      }
      if (button.hasAttribute("data-ig-fit")) {
        autoFit = true;
        schedule();
        return;
      }
      if (button.hasAttribute("data-ig-zoom")) {
        autoFit = false;
        view = zoomAt(
          view,
          { x: width / 2, y: height / 2 },
          view.scale * (button.dataset.igZoom === "in" ? 1.25 : 1 / 1.25),
        );
        schedule();
        return;
      }
      if (button.hasAttribute("data-ig-cluster")) {
        settings.activeCluster =
          settings.activeCluster === button.dataset.igCluster
            ? null
            : button.dataset.igCluster;
        dialog
          .querySelectorAll("[data-ig-cluster]")
          .forEach((el) =>
            el.setAttribute(
              "aria-pressed",
              String(el.dataset.igCluster === settings.activeCluster),
            ),
          );
        highlight();
        return;
      }
      if (button.hasAttribute("data-ig-defaults")) {
        Object.assign(settings, {
          nodeScale: 1,
          linkWidth: 0.8,
          labels: 1,
          activeCluster: null,
        });
        dialog.querySelectorAll("[data-ig-setting]").forEach((el) => {
          el.value = settings[el.dataset.igSetting];
        });
        dialog
          .querySelectorAll("[data-ig-cluster]")
          .forEach((el) => el.setAttribute("aria-pressed", "false"));
        highlight();
        wake();
        return;
      }
      if (button.hasAttribute("data-ig-retry") && !fetchController) {
        message.textContent = "Loading your interest map…";
        q(".ig-count").textContent = "Loading your map…";
        void load();
      }
    });
    listen(dialog, "input", (event) => {
      const key = event.target.dataset.igSetting;
      if (!["nodeScale", "linkWidth", "labels"].includes(key)) return;
      settings[key] = Number(event.target.value);
      if (key === "nodeScale" && !media.matches) wake();
      else schedule();
    });
    listen(dialog, "cancel", (event) => {
      event.preventDefault();
      if (panel) closePanel();
      else destroy();
    });
    listen(dialog, "close", destroy);
    listen(window, "pagehide", destroy);
    listen(document, "visibilitychange", () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else schedule();
    });
    listen(media, "change", () => {
      if (media.matches && layoutReady) alpha = 0;
      schedule();
    });
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      life.abort();
      fetchController?.abort();
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      resize.disconnect();
      pointers.clear();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      if (activeController === controller) activeController = null;
      if (onClose) onClose();
    }
    const controller = { destroy };
    activeController = controller;
    dialog.showModal();
    q("[data-ig-close]").focus();
    resize.observe(stage);
    dimensions();
    void load();
    return controller;
  }

  return { mount, prepareGraph, tick, fitView, zoomAt, labelLayout };
});
