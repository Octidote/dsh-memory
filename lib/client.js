window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const ReactDOM = require("react-dom");
    const h = React.createElement;

    const PANEL_WIDTH = 468;
    const PANEL_HEIGHT = 680;
    const MAX_LIST = 400;

    const CATEGORY_FALLBACK = [
      { key: "preference", label: "偏好", color: "#e6a6ff" },
      { key: "project", label: "项目", color: "#7cb8ff" },
      { key: "environment", label: "环境", color: "#6fe0c0" },
      { key: "fact", label: "事实", color: "#ffd479" },
      { key: "plan", label: "计划", color: "#ff9f7a" },
      { key: "person", label: "人物", color: "#ff9ec4" },
      { key: "conversation", label: "对话", color: "#9aa7ff" },
    ];
    const CATEGORY_INDEX = new Map(CATEGORY_FALLBACK.map((entry) => [entry.key, entry]));
    const GRAPH_WIDTH = 440;
    const GRAPH_HEIGHT = 350;

    function categoryMeta(key) {
      return CATEGORY_INDEX.get(key) || CATEGORY_INDEX.get("conversation");
    }

    function memoryCategory(memory) {
      return memory && CATEGORY_INDEX.has(memory.category) ? memory.category : "conversation";
    }

    const CSS = `
.dsm-trigger{display:inline-flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit;font-size:12px;line-height:1.2;transition:background-color .12s ease,color .12s ease;-webkit-app-region:no-drag}
.dsm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.dsm-trigger[data-open="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit)}
.dsm-trigger svg{flex:none}
.dsm-trigger-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-panel{position:fixed;z-index:1000;box-sizing:border-box;display:flex;flex-direction:column;width:${PANEL_WIDTH}px;max-width:calc(100vw - 24px);max-height:min(82vh,${PANEL_HEIGHT}px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#242424);color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-shadow-lv3,0 18px 48px rgba(0,0,0,.38));font-family:inherit;font-size:12px;line-height:1.45;-webkit-app-region:no-drag}
.dsm-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px 9px;border-bottom:1px solid var(--dsw-alias-border-l1,#333)}
.dsm-title{display:flex;align-items:center;gap:7px;min-width:0;color:var(--dsw-alias-label-primary,inherit);font-size:13px;font-weight:600}
.dsm-title svg{color:var(--dsw-alias-brand-primary,currentColor)}
.dsm-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-accent-soft,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16)));color:var(--dsw-alias-label-secondary,inherit);font-size:10px;font-weight:500;font-variant-numeric:tabular-nums}
.dsm-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit;font-size:16px;line-height:1;transition:background-color .12s ease,color .12s ease}
.dsm-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));color:var(--dsw-alias-label-primary,inherit)}
.dsm-iconbtn:disabled{opacity:.4;cursor:default}
.dsm-iconbtn.dsm-close{font-size:18px}
.dsm-tabs{display:flex;align-items:center;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#333);flex:none}
.dsm-tab{flex:1;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:11.5px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dsm-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.dsm-tab[data-active="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.dsm-cats{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:7px 10px 3px;overflow:visible;flex:none}
.dsm-chip{flex:none;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#383838);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:10.5px;line-height:1;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.dsm-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.dsm-chip[data-active="true"]{color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.dsm-chip-dot{width:6px;height:6px;border-radius:50%;flex:none}
.dsm-chip-count{color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.dsm-toolbar{display:flex;align-items:center;gap:6px;padding:8px 10px 4px;flex:none}
.dsm-input{box-sizing:border-box;flex:1;min-width:0;height:28px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;outline:none}
.dsm-input:focus{border-color:var(--dsw-alias-state-business-primary,#6f9bf0)}
.dsm-input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}
.dsm-textarea{flex:none;height:auto;min-height:110px;resize:vertical;padding:7px 8px;line-height:1.55}
.dsm-count{flex:none;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-list{flex:1;min-height:0;overflow:auto;padding:4px 10px 8px;overscroll-behavior:contain}
.dsm-row{padding:8px 8px 7px;border:1px solid transparent;border-radius:8px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dsm-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));border-color:var(--dsw-alias-border-l1,#333)}
.dsm-row[data-expanded="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.1));border-color:var(--dsw-alias-border-l2,#3a3a3a)}
.dsm-row-top{display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:3px}
.dsm-kind{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,inherit);font-size:10px;line-height:1}
.dsm-kind[data-kind="note"]{background:var(--dsw-alias-accent-soft,rgba(120,160,255,.16));color:var(--dsw-alias-state-business-primary,#8ab4f8)}
.dsm-cat{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 6px;border:1px solid transparent;border-radius:4px;font-size:10px;line-height:1}
.dsm-time{color:var(--dsw-alias-label-tertiary,#888);font-size:10.5px;white-space:nowrap}
.dsm-hits{margin-left:auto;color:var(--dsw-alias-label-tertiary,#888);font-size:10px;white-space:nowrap}
.dsm-del{flex:none;width:20px;height:20px;margin-left:2px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;font:inherit;font-size:14px;line-height:1}
.dsm-del:hover{background:var(--dsw-alias-state-error-primary,rgba(240,100,100,.18));color:var(--dsw-alias-state-error-primary,#f08a8a)}
.dsm-text{color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.dsm-text[data-clamped="true"]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsm-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.dsm-tag{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.13));color:var(--dsw-alias-label-secondary,inherit);font-size:10px;line-height:1}
.dsm-tag[data-clickable="true"]{cursor:pointer}
.dsm-tag[data-clickable="true"]:hover{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(120,160,255,.2));color:var(--dsw-alias-label-primary,inherit)}
.dsm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:150px;padding:18px;color:var(--dsw-alias-label-tertiary,#888);text-align:center;font-size:12px}
.dsm-empty strong{color:var(--dsw-alias-label-secondary,inherit);font-weight:500}
.dsm-empty-hint{font-size:11px;line-height:1.5;max-width:270px}
.dsm-hint{margin:0;color:var(--dsw-alias-label-tertiary,#888);font-size:10.5px;line-height:1.55}
.dsm-error{margin:4px 10px 0;padding:6px 8px;border:1px solid var(--dsw-alias-state-error-primary,rgba(240,100,100,.5));border-radius:6px;color:var(--dsw-alias-state-error-primary,#f08a8a);font-size:11px;overflow-wrap:anywhere}
.dsm-graph-wrap{flex:1;min-height:0;display:flex;flex-direction:column;padding:2px 8px 8px;overflow:auto}
.dsm-graph-stage{position:relative;flex:none;border:1px solid var(--dsw-alias-border-l1,#30364a);border-radius:11px;overflow:hidden;background:#0b0f19;box-shadow:inset 0 0 42px rgba(110,150,255,.08),0 8px 26px rgba(0,0,0,.18)}
.dsm-graph{display:block;width:100%;height:auto;background:radial-gradient(circle at 50% 44%,#1c2542 0%,#121827 52%,#090c14 100%);cursor:grab;touch-action:none;user-select:none}
.dsm-graph:active{cursor:grabbing}
.dsm-graph-edge{fill:none;stroke-linecap:round;stroke-width:1;transition:stroke-opacity .2s ease,stroke-width .2s ease}
.dsm-graph-edge[data-kind="tag"]{stroke-dasharray:2 5;animation:dsm-dash 9s linear infinite}
.dsm-graph-edge[data-active="true"]{stroke-width:1.7}
.dsm-graph-node{cursor:pointer;transition:opacity .2s ease}
.dsm-graph-node:hover{opacity:1}
.dsm-graph-hub{cursor:pointer}
.dsm-graph-hub-label{font-size:10.5px;font-weight:600;letter-spacing:.2px;paint-order:stroke;stroke:#0b0f19;stroke-width:3px;stroke-linejoin:round;pointer-events:none;user-select:none}
.dsm-graph-label{fill:#aebbd8;font-size:8px;paint-order:stroke;stroke:#0b0f19;stroke-width:2.4px;stroke-linejoin:round;pointer-events:none;user-select:none}
.dsm-graph-pulse{transform-box:fill-box;transform-origin:center;animation:dsm-pulse 3.8s ease-in-out infinite}
.dsm-graph-star{fill:#a9c8ff;animation:dsm-twinkle 4.6s ease-in-out infinite}
.dsm-graph-toolbar{position:absolute;right:7px;top:7px;display:flex;flex-direction:column;gap:3px;z-index:2}
.dsm-graph-tool{display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;padding:0;border:1px solid rgba(160,190,255,.2);border-radius:6px;background:rgba(12,18,32,.72);color:#c6d6f5;font:inherit;font-size:13px;line-height:1;cursor:pointer;backdrop-filter:blur(4px)}
.dsm-graph-tool:hover{background:rgba(70,110,190,.4);color:#fff}
.dsm-graph-hint{position:absolute;left:9px;bottom:7px;color:rgba(190,208,238,.55);font-size:9px;line-height:1;pointer-events:none;letter-spacing:.2px}
.dsm-graph-legend{display:flex;align-items:center;flex-wrap:wrap;gap:5px 9px;padding:7px 2px 0;color:var(--dsw-alias-label-tertiary,#9aa6bc);font-size:9.5px;flex:none}
.dsm-legend-item{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:inherit;cursor:pointer}
.dsm-legend-item:hover{color:var(--dsw-alias-label-primary,inherit)}
.dsm-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px}
.dsm-graph-detail{margin:7px 2px 0;padding:8px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));color:var(--dsw-alias-label-secondary,inherit);font-size:11px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:112px;overflow:auto}
@keyframes dsm-dash{to{stroke-dashoffset:-42}}
@keyframes dsm-pulse{0%,100%{opacity:.18;transform:scale(.96)}50%{opacity:.6;transform:scale(1.16)}}
@keyframes dsm-twinkle{0%,100%{opacity:.18}50%{opacity:.85}}
.dsm-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-base,transparent);flex:none}
.dsm-foot-note{color:var(--dsw-alias-label-tertiary,#888);font-size:10px}
.dsm-clear{height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;font:inherit;font-size:10px}
.dsm-clear:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#f08a8a);border-color:var(--dsw-alias-state-error-primary,#f08a8a)}
.dsm-clear:disabled{opacity:.4;cursor:default}
`;

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dsh-memory-styles") !== null) return;
      const style = document.createElement("style");
      style.id = "dsh-memory-styles";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function MemoryIcon({ size = 16 }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M6 4.2A2.2 2.2 0 0 1 8.2 2H18a1 1 0 0 1 1 1v17.1a.85.85 0 0 1-1.31.72L12 17.1l-5.69 3.72A.85.85 0 0 1 5 20.1V4.2Z" }),
        h("path", { d: "M9 7h6M9 10.5h4" }),
      );
    }

    function apiUrl(method) {
      const base = new URL(".", document.baseURI);
      return new URL(`dsh-memory/api/${method}`, base).toString();
    }

    async function call(method, payload) {
      const response = await fetch(apiUrl(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok || body === undefined || body.ok !== true) {
        const message = body?.error?.message ?? `memory request failed (HTTP ${response.status})`;
        throw new Error(message);
      }
      return body.value;
    }

    function timeAgo(value) {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return "";
      const diff = Math.max(0, Date.now() - time);
      const minute = 60000;
      const hour = 3600000;
      const day = 86400000;
      if (diff < minute) return "刚刚";
      if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
      if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
      if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
      return new Date(time).toISOString().slice(0, 10);
    }

    function cleanQuery(value) {
      return value.trim().toLowerCase();
    }

    function matchesQuery(memory, query) {
      if (query.length === 0) return true;
      if (memory.text.toLowerCase().includes(query)) return true;
      if ((memory.tags || []).some((tag) => tag.toLowerCase().includes(query))) return true;
      return categoryMeta(memoryCategory(memory)).label.includes(query);
    }

    function MemoryRow({ memory, expanded, onToggle, onDelete }) {
      const tags = memory.tags || [];
      const meta = categoryMeta(memoryCategory(memory));
      return h(
        "div",
        {
          className: "dsm-row",
          "data-expanded": expanded ? "true" : "false",
          onClick: onToggle,
          role: "button",
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle();
            }
          },
        },
        h(
          "div",
          { className: "dsm-row-top" },
          h("span", { className: "dsm-cat", style: { color: meta.color, borderColor: `${meta.color}66`, background: `${meta.color}18` } }, meta.label),
          h("span", { className: "dsm-kind", "data-kind": memory.kind }, memory.kind === "note" ? "长期" : "对话"),
          h("span", { className: "dsm-time" }, timeAgo(memory.updatedAt)),
          memory.hits > 0 ? h("span", { className: "dsm-hits" }, `被召回 ${memory.hits}`) : null,
          h(
            "button",
            {
              className: "dsm-del",
              title: "删除这条记忆",
              "aria-label": "删除这条记忆",
              onClick: (event) => {
                event.stopPropagation();
                onDelete(memory);
              },
            },
            "×",
          ),
        ),
        h("div", { className: "dsm-text", "data-clamped": expanded ? "false" : "true" }, memory.text),
        tags.length > 0
          ? h("div", { className: "dsm-tags" }, tags.map((tag) => h("span", { className: "dsm-tag", key: tag }, tag)))
          : null,
      );
    }

    function buildCategoryGraph(memories) {
      const picked = memories.slice(0, 90);
      const groups = new Map();
      for (const memory of picked) {
        const key = memoryCategory(memory);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(memory);
      }
      const order = [...groups.keys()].sort((left, right) => {
        const byCount = groups.get(right).length - groups.get(left).length;
        if (byCount !== 0) return byCount;
        return CATEGORY_FALLBACK.findIndex((entry) => entry.key === left) - CATEGORY_FALLBACK.findIndex((entry) => entry.key === right);
      });
      const nodes = [];
      const edges = [];
      const byId = new Map();
      const addNode = (node) => {
        nodes.push(node);
        byId.set(node.id, node);
        return node;
      };
      const cx = GRAPH_WIDTH / 2;
      const cy = GRAPH_HEIGHT / 2 - 3;
      const hubRadius = Math.max(52, Math.min(108, 46 + order.length * 8));
      const hubs = new Map();
      order.forEach((key, index) => {
        const meta = categoryMeta(key);
        const angle = -Math.PI / 2 + (index / Math.max(1, order.length)) * Math.PI * 2;
        const hub = addNode({
          id: `c:${key}`,
          kind: "hub",
          key,
          name: meta.label,
          color: meta.color,
          count: groups.get(key).length,
          r: 11 + Math.min(7, groups.get(key).length * 1.4),
          x: cx + Math.cos(angle) * hubRadius,
          y: cy + Math.sin(angle) * hubRadius,
          vx: 0,
          vy: 0,
        });
        hubs.set(key, hub);
        const list = groups.get(key);
        const ring = 36 + Math.min(38, list.length * 3.2);
        list.forEach((memory, memoryIndex) => {
          const spread = angle + (memoryIndex / Math.max(1, list.length)) * Math.PI * 2;
          const radius = ring + (memoryIndex % 3) * 11;
          addNode({
            id: `m:${memory.id}`,
            kind: "memory",
            memory,
            category: key,
            color: meta.color,
            hubId: hub.id,
            r: 3.6 + (Number(memory.importance) || 0.4) * 4.4,
            x: hub.x + Math.cos(spread) * radius,
            y: hub.y + Math.sin(spread) * radius,
            vx: 0,
            vy: 0,
          });
          edges.push({ id: `h:${memory.id}`, source: `m:${memory.id}`, target: hub.id, kind: "hub", color: meta.color });
        });
      });
      const tagCounts = new Map();
      for (const memory of picked) {
        for (const tag of memory.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
      const tagList = [...tagCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 14)
        .map(([tag, count]) => ({ tag, count }));
      tagList.forEach(({ tag, count }, index) => {
        const angle = (index / Math.max(1, tagList.length)) * Math.PI * 2 + 0.32;
        const radius = 144 + (index % 4) * 7;
        addNode({
          id: `t:${tag}`,
          kind: "tag",
          name: tag,
          r: 3.3 + Math.min(4, count * 0.9),
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        });
      });
      const tagSet = new Set(tagList.map((entry) => entry.tag));
      for (const memory of picked) {
        for (const tag of memory.tags || []) {
          if (!tagSet.has(tag)) continue;
          edges.push({ id: `t:${memory.id}:${tag}`, source: `m:${memory.id}`, target: `t:${tag}`, kind: "tag", color: "#8fb7ff" });
        }
      }
      for (let step = 0; step < 110; step += 1) {
        for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
          const a = nodes[leftIndex];
          if (a.kind === "hub") continue;
          for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
            const b = nodes[rightIndex];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distance2 = dx * dx + dy * dy;
            if (distance2 < 1) {
              dx = 0.3;
              dy = 0.3;
              distance2 = 0.18;
            }
            const distance = Math.sqrt(distance2);
            const force = Math.min(a.kind === "tag" || b.kind === "tag" ? 4.2 : 6, 270 / distance2);
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;
            a.vx -= fx;
            a.vy -= fy;
            if (b.kind !== "hub") {
              b.vx += fx;
              b.vy += fy;
            }
          }
        }
        for (const edge of edges) {
          const a = byId.get(edge.source);
          const b = byId.get(edge.target);
          if (a === undefined || b === undefined) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 1;
          const target = edge.kind === "hub" ? 47 : 88;
          const strength = edge.kind === "hub" ? 0.022 : 0.0035;
          const force = (distance - target) * strength;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          if (a.kind !== "hub") {
            a.vx += fx;
            a.vy += fy;
          }
          if (b.kind !== "hub") {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
        for (const node of nodes) {
          if (node.kind === "hub") continue;
          if (node.kind === "tag") {
            node.vx += (node.x - cx) * 0.0011;
            node.vy += (node.y - cy) * 0.0011;
          } else {
            node.vx += (cx - node.x) * 0.0006;
            node.vy += (cy - node.y) * 0.0008;
          }
          node.vx *= 0.84;
          node.vy *= 0.84;
          node.x = Math.max(14, Math.min(GRAPH_WIDTH - 14, node.x + Math.max(-4, Math.min(4, node.vx))));
          node.y = Math.max(16, Math.min(GRAPH_HEIGHT - 20, node.y + Math.max(-4, Math.min(4, node.vy))));
        }
      }
      return { nodes, edges, byId, hubs: order.map((key) => hubs.get(key)), tagList };
    }

    function graphEdgePath(left, right, kind) {
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const length = Math.hypot(dx, dy) || 1;
      const bend = kind === "tag" ? Math.min(16, length * 0.1) : 0;
      const nx = (-dy / length) * bend;
      const ny = (dx / length) * bend;
      const mx = (left.x + right.x) / 2 + nx;
      const my = (left.y + right.y) / 2 + ny;
      return `M ${left.x.toFixed(2)} ${left.y.toFixed(2)} Q ${mx.toFixed(2)} ${my.toFixed(2)} ${right.x.toFixed(2)} ${right.y.toFixed(2)}`;
    }

    function MemoryCategoryGraph({ memories, selectedId, onSelect, onTagClick, onCategoryClick }) {
      const graph = React.useMemo(() => buildCategoryGraph(memories), [memories]);
      const [zoom, setZoom] = React.useState(1);
      const [hoverId, setHoverId] = React.useState(null);
      const svgRef = React.useRef(null);

      React.useEffect(() => {
        const element = svgRef.current;
        if (element === null) return undefined;
        const onWheel = (event) => {
          event.preventDefault();
          setZoom((value) => Math.max(0.68, Math.min(2.4, value * (event.deltaY < 0 ? 1.12 : 0.89))));
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
      }, []);

      const selectedNode = selectedId === null ? undefined : graph.nodes.find((node) => node.kind === "memory" && node.memory.id === selectedId);
      const selected = selectedNode?.memory;
      const selectedCategory = selected === undefined ? undefined : memoryCategory(selected);
      const selectedTags = new Set(selected?.tags || []);
      const focusNodeId = selectedNode?.id;
      const focusHubId = selectedCategory === undefined ? undefined : `c:${selectedCategory}`;
      const isDim = (node) => {
        if (selected === undefined) return false;
        if (node.id === focusNodeId || node.id === focusHubId) return false;
        if (node.kind === "memory" && memoryCategory(node.memory) === selectedCategory) return false;
        if (node.kind === "tag" && selectedTags.has(node.name)) return false;
        return true;
      };
      const edgeState = (edge) => {
        if (selected === undefined) return { active: false, dim: false };
        const active = edge.source === focusNodeId || edge.target === focusNodeId || edge.target === focusHubId || (edge.kind === "tag" && selectedTags.has(edge.target.slice(2)));
        return { active, dim: !active };
      };
      const stars = React.useMemo(
        () =>
          Array.from({ length: 30 }, (_, index) => ({
            x: 10 + ((index * 97) % (GRAPH_WIDTH - 20)),
            y: 8 + ((index * 53) % (GRAPH_HEIGHT - 16)),
            r: index % 5 === 0 ? 1.15 : 0.65,
            delay: (index % 9) * 0.45,
          })),
        [],
      );
      const zoomBy = (factor) => setZoom((value) => Math.max(0.68, Math.min(2.4, Number((value * factor).toFixed(3)))));
      const categoryColor = selectedCategory === undefined ? "#9aa7ff" : categoryMeta(selectedCategory).color;

      return h(
        "div",
        { className: "dsm-graph-wrap" },
        h(
          "div",
          { className: "dsm-graph-stage" },
          h(
            "svg",
            { ref: svgRef, className: "dsm-graph", viewBox: `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`, role: "img", "aria-label": "记忆关系图谱" },
            h(
              "defs",
              null,
              h(
                "filter",
                { id: "dsm-memory-glow", x: "-80%", y: "-80%", width: "260%", height: "260%" },
                h("feGaussianBlur", { stdDeviation: "3.2", result: "blur" }),
                h("feMerge", null, h("feMergeNode", { in: "blur" }), h("feMergeNode", { in: "SourceGraphic" })),
              ),
              h(
                "radialGradient",
                { id: "dsm-memory-bg", cx: "50%", cy: "44%", r: "78%" },
                h("stop", { offset: "0%", stopColor: "#1c2542" }),
                h("stop", { offset: "54%", stopColor: "#121827" }),
                h("stop", { offset: "100%", stopColor: "#090c14" }),
              ),
            ),
            h("rect", { x: 0, y: 0, width: GRAPH_WIDTH, height: GRAPH_HEIGHT, fill: "url(#dsm-memory-bg)" }),
            stars.map((star, index) =>
              h("circle", {
                key: `star:${index}`,
                className: "dsm-graph-star",
                cx: star.x,
                cy: star.y,
                r: star.r,
                style: { animationDelay: `${star.delay}s` },
              }),
            ),
            h(
              "g",
              { transform: `translate(${GRAPH_WIDTH / 2} ${GRAPH_HEIGHT / 2}) scale(${zoom}) translate(${-GRAPH_WIDTH / 2} ${-GRAPH_HEIGHT / 2})` },
              graph.edges.map((edge) => {
                const left = graph.byId.get(edge.source);
                const right = graph.byId.get(edge.target);
                if (left === undefined || right === undefined) return null;
                const state = edgeState(edge);
                return h("path", {
                  key: edge.id,
                  className: "dsm-graph-edge",
                  "data-kind": edge.kind,
                  "data-active": state.active ? "true" : "false",
                  d: graphEdgePath(left, right, edge.kind),
                  style: { stroke: edge.color, strokeOpacity: state.dim ? 0.11 : state.active ? 0.82 : 0.22 },
                });
              }),
              graph.edges.map((edge, index) => {
                if (edge.kind !== "tag" || index % 6 !== 0) return null;
                const left = graph.byId.get(edge.source);
                const right = graph.byId.get(edge.target);
                if (left === undefined || right === undefined) return null;
                const state = edgeState(edge);
                if (state.dim) return null;
                return h(
                  "circle",
                  { key: `flow:${edge.id}`, r: 1.25, fill: "#bcd6ff", opacity: 0.85 },
                  h("animateMotion", { dur: `${5.5 + (index % 4) * 1.6}s`, repeatCount: "indefinite", path: graphEdgePath(left, right, "tag") }),
                );
              }),
              graph.nodes.map((node) => {
                const dim = isDim(node);
                if (node.kind === "hub") {
                  return h(
                    "g",
                    {
                      key: node.id,
                      className: "dsm-graph-node dsm-graph-hub",
                      opacity: dim ? 0.3 : 1,
                      onClick: () => onCategoryClick(node.key),
                    },
                    h("circle", { className: "dsm-graph-pulse", cx: node.x, cy: node.y, r: node.r + 8, fill: "none", stroke: node.color, strokeWidth: 1.2 }),
                    h("circle", { cx: node.x, cy: node.y, r: node.r + 4, fill: node.color, opacity: 0.1 }),
                    h("circle", { cx: node.x, cy: node.y, r: node.r, fill: node.color, opacity: 0.92, filter: "url(#dsm-memory-glow)" }),
                    h(
                      "text",
                      { className: "dsm-graph-hub-label", x: node.x, y: node.y + node.r + 13, textAnchor: "middle", fill: node.color },
                      `${node.name} ${node.count}`,
                    ),
                    h("title", null, `分类：${node.name}（${node.count} 条）`),
                  );
                }
                if (node.kind === "tag") {
                  const hovered = hoverId === node.id;
                  return h(
                    "g",
                    {
                      key: node.id,
                      className: "dsm-graph-node",
                      opacity: dim ? 0.28 : 1,
                      onClick: () => onTagClick(node.name),
                      onMouseEnter: () => setHoverId(node.id),
                      onMouseLeave: () => setHoverId((value) => (value === node.id ? null : value)),
                    },
                    h("circle", { cx: node.x, cy: node.y, r: hovered ? node.r + 1.4 : node.r, fill: "#9dbeff", opacity: 0.9 }),
                    h("text", { className: "dsm-graph-label", x: node.x + node.r + 3, y: node.y + 2.6 }, node.name),
                  );
                }
                const hovered = hoverId === node.id;
                const active = selectedId === node.memory.id;
                return h(
                  "g",
                  {
                    key: node.id,
                    className: "dsm-graph-node",
                    opacity: dim ? 0.3 : 1,
                    onClick: () => onSelect(node.memory.id),
                    onMouseEnter: () => setHoverId(node.id),
                    onMouseLeave: () => setHoverId((value) => (value === node.id ? null : value)),
                  },
                  active ? h("circle", { cx: node.x, cy: node.y, r: node.r + 5, fill: node.color, opacity: 0.24 }) : null,
                  h("circle", { cx: node.x, cy: node.y, r: hovered ? node.r + 1.6 : node.r, fill: node.color, stroke: "#0b0f19", strokeWidth: 1 }),
                  active ? h("circle", { cx: node.x, cy: node.y, r: node.r + 2.8, fill: "none", stroke: "#ffffff", strokeWidth: 0.9, opacity: 0.8 }) : null,
                  h("title", null, `${categoryMeta(memoryCategory(node.memory)).label} · ${node.memory.text.slice(0, 140)}`),
                );
              }),
            ),
          ),
          h(
            "div",
            { className: "dsm-graph-toolbar" },
            h("button", { className: "dsm-graph-tool", title: "放大", "aria-label": "放大", onClick: () => zoomBy(1.18) }, "+"),
            h("button", { className: "dsm-graph-tool", title: "缩小", "aria-label": "缩小", onClick: () => zoomBy(0.85) }, "−"),
            h("button", { className: "dsm-graph-tool", title: "重置缩放", "aria-label": "重置缩放", onClick: () => setZoom(1) }, "⟲"),
          ),
          h("div", { className: "dsm-graph-hint" }, "滚轮缩放 · 点击分类节点筛选"),
        ),
        h(
          "div",
          { className: "dsm-graph-legend" },
          graph.hubs.map((hub) =>
            h(
              "button",
              { key: hub.key, className: "dsm-legend-item", onClick: () => onCategoryClick(hub.key), title: `筛选${hub.name}` },
              h("i", { className: "dsm-dot", style: { background: hub.color } }),
              `${hub.name} ${hub.count}`,
            ),
          ),
          h("span", { style: { marginLeft: "auto" } }, `${memories.length} 条`),
        ),
        selected !== undefined
          ? h(
              "div",
              { className: "dsm-graph-detail" },
              h(
                "div",
                { className: "dsm-tags", style: { marginTop: 0, marginBottom: "5px" } },
                h("span", { className: "dsm-cat", style: { color: categoryColor, borderColor: `${categoryColor}66`, background: `${categoryColor}18` } }, categoryMeta(selectedCategory).label),
                (selected.tags || []).map((tag) => h("span", { className: "dsm-tag", key: tag }, tag)),
              ),
              selected.text,
            )
          : h("div", { className: "dsm-graph-detail", style: { color: "var(--dsw-alias-label-tertiary)" } }, "点击记忆节点查看内容；点击分类节点筛选列表。"),
      );
    }

    function MemoryPanel({ anchor, onClose, panelRef }) {
      const [tab, setTab] = React.useState("list");
      const [items, setItems] = React.useState([]);
      const [stats, setStats] = React.useState({ count: 0, notes: 0, dialogues: 0, tags: 0, categories: [] });
      const [query, setQuery] = React.useState("");
      const [category, setCategory] = React.useState("all");
      const [expanded, setExpanded] = React.useState(null);
      const [selectedId, setSelectedId] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");

      const load = React.useCallback(async (silent) => {
        if (!silent) setBusy(true);
        try {
          const value = await call("list", { limit: MAX_LIST });
          setItems(Array.isArray(value.items) ? value.items : []);
          setStats(value.stats || {});
          setError("");
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
          if (!silent) setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        void load(false);
        const timer = setInterval(() => {
          void load(true);
        }, 8000);
        return () => clearInterval(timer);
      }, [load]);

      const categories = React.useMemo(() => {
        const fromStats = Array.isArray(stats.categories) ? stats.categories : [];
        if (fromStats.length > 0) return fromStats;
        return CATEGORY_FALLBACK.map((entry) => ({
          ...entry,
          count: items.filter((memory) => memoryCategory(memory) === entry.key).length,
        }));
      }, [stats, items]);

      const activeCategoryCount = categories.filter((entry) => entry.count > 0).length;

      const filtered = React.useMemo(() => {
        const needle = cleanQuery(query);
        return items.filter((memory) => (category === "all" || memoryCategory(memory) === category) && matchesQuery(memory, needle));
      }, [items, query, category]);

      const remove = async (memory) => {
        setBusy(true);
        try {
          await call("delete", { id: memory.id });
          if (expanded === memory.id) setExpanded(null);
          if (selectedId === memory.id) setSelectedId(null);
          await load(true);
        } catch (deleteError) {
          setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
        } finally {
          setBusy(false);
        }
      };

      const clear = async () => {
        if (!window.confirm("确定清空整个共享记忆池？这个操作不可撤销。")) return;
        setBusy(true);
        try {
          await call("clear", { confirm: true });
          setExpanded(null);
          setSelectedId(null);
          await load(true);
        } catch (clearError) {
          setError(clearError instanceof Error ? clearError.message : String(clearError));
        } finally {
          setBusy(false);
        }
      };

      const listBody = () => {
        if (filtered.length === 0) {
          return h(
            "div",
            { className: "dsm-empty" },
            h(MemoryIcon, { size: 22 }),
            h("strong", null, items.length === 0 ? "记忆池还是空的" : "没有匹配的记忆"),
            h("span", { className: "dsm-empty-hint" }, items.length === 0 ? "在本机任意会话里聊天，内容会自动进入共享池，无需手动添加。" : "换一个关键词，或者清空搜索框。"),
          );
        }
        return filtered.map((memory) =>
          h(MemoryRow, {
            key: memory.id,
            memory,
            expanded: expanded === memory.id,
            onToggle: () => setExpanded(expanded === memory.id ? null : memory.id),
            onDelete: remove,
          }),
        );
      };

      return h(
        "div",
        {
          className: "dsm-panel",
          ref: panelRef,
          role: "dialog",
          "aria-label": "共享记忆",
          style: { left: anchor.left, bottom: anchor.bottom },
        },
        h(
          "div",
          { className: "dsm-head" },
          h("div", { className: "dsm-title" }, h(MemoryIcon, { size: 15 }), h("span", null, "共享记忆"), h("span", { className: "dsm-badge" }, stats.count ?? 0)),
          h(
            "div",
            { style: { display: "flex", gap: "2px", flex: "none" } },
            h("button", { className: "dsm-iconbtn", title: "刷新", "aria-label": "刷新", onClick: () => void load(false), disabled: busy }, "↻"),
            h("button", { className: "dsm-iconbtn dsm-close", title: "关闭", "aria-label": "关闭", onClick: onClose }, "×"),
          ),
        ),
        h(
          "div",
          { className: "dsm-tabs" },
          h("button", { className: "dsm-tab", "data-active": tab === "list" ? "true" : "false", onClick: () => setTab("list") }, "列表"),
          h("button", { className: "dsm-tab", "data-active": tab === "graph" ? "true" : "false", onClick: () => setTab("graph") }, "图谱"),
        ),
        h(
          "div",
          { className: "dsm-cats" },
          h(
            "button",
            {
              className: "dsm-chip",
              "data-active": category === "all" ? "true" : "false",
              onClick: () => setCategory("all"),
              style: category === "all" ? { borderColor: "var(--dsw-alias-state-business-primary,#6f9bf0)", background: "rgba(111,155,240,.16)" } : undefined,
            },
            "全部",
            h("span", { className: "dsm-chip-count" }, items.length),
          ),
          categories
            .filter((entry) => entry.count > 0 || category === entry.key)
            .map((entry) =>
              h(
                "button",
                {
                  key: entry.key,
                  className: "dsm-chip",
                  "data-active": category === entry.key ? "true" : "false",
                  onClick: () => setCategory(category === entry.key ? "all" : entry.key),
                  style: category === entry.key ? { color: entry.color, borderColor: `${entry.color}88`, background: `${entry.color}20` } : undefined,
                },
                h("i", { className: "dsm-chip-dot", style: { background: entry.color } }),
                entry.label,
                h("span", { className: "dsm-chip-count" }, entry.count),
              ),
            ),
        ),
        error.length > 0 ? h("div", { className: "dsm-error" }, error) : null,
        tab === "list"
          ? h(
              React.Fragment,
              null,
              h("div", { className: "dsm-toolbar" }, h("input", { className: "dsm-input", placeholder: "搜索记忆…", value: query, onChange: (event) => setQuery(event.target.value) }), h("span", { className: "dsm-count" }, `${filtered.length}/${items.length}`)),
              h("div", { className: "dsm-list" }, listBody()),
            )
          : null,
        tab === "graph"
          ? h(MemoryCategoryGraph, {
              memories: filtered,
              selectedId,
              onSelect: (id) => setSelectedId(selectedId === id ? null : id),
              onTagClick: (tag) => {
                setQuery(tag);
                setTab("list");
              },
              onCategoryClick: (key) => {
                setCategory(key === category ? "all" : key);
                setTab("list");
              },
            })
          : null,
        h(
          "div",
          { className: "dsm-foot" },
          h("span", { className: "dsm-foot-note" }, busy ? "同步中…" : `${stats.count ?? 0} 条记忆 · ${activeCategoryCount} 类`),
          h("button", { className: "dsm-clear", onClick: () => void clear(), disabled: busy || (stats.count ?? 0) === 0 }, "清空"),
        ),
      );
    }

    function MemoryAction({ wide }) {
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState({ left: 16, bottom: 48 });
      const buttonRef = React.useRef(null);
      const panelRef = React.useRef(null);

      const place = React.useCallback(() => {
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect === undefined) return;
        const left = Math.max(12, Math.min(rect.left + 8, window.innerWidth - PANEL_WIDTH - 12));
        const bottom = Math.max(12, Math.min(window.innerHeight - rect.top + 8, window.innerHeight - 140));
        setAnchor({ left, bottom });
      }, []);

      const toggle = () => {
        place();
        setOpen((value) => !value);
      };

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (panelRef.current?.contains(event.target)) return;
          if (buttonRef.current?.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        window.addEventListener("resize", place);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown);
          window.removeEventListener("resize", place);
        };
      }, [open, place]);

      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            ref: buttonRef,
            className: "dsm-trigger",
            type: "button",
            title: "共享记忆",
            "aria-label": "共享记忆",
            "aria-expanded": open ? "true" : "false",
            "data-open": open ? "true" : "false",
            onClick: toggle,
          },
          h(MemoryIcon, { size: 16 }),
          wide ? h("span", { className: "dsm-trigger-label" }, "记忆") : null,
        ),
        open ? ReactDOM.createPortal(h(MemoryPanel, { anchor, onClose: () => setOpen(false), panelRef }), document.body) : null,
      );
    }

    function apply(ctx) {
      ensureStyles();
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "dsh-memory",
          },
          MemoryAction,
        ),
      );
    }

    const inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
