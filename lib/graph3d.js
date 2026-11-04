(() => {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  const loading = document.getElementById('loading');
  const statsEl = document.getElementById('stats');
  const legendEl = document.getElementById('legend');
  const detailEl = document.getElementById('detail');
  const relationsEl = document.getElementById('relations');
  const params = new URLSearchParams(location.search);
  if (params.get('embed') === '1') document.body.classList.add('embed');

  const state = {
    nodes: [],
    edges: [],
    byId: new Map(),
    categories: [],
    total: 0,
    shown: 0,
    selectedId: null,
    hoverId: null,
    categoryFilter: params.get('category') || '',
    query: (params.get('q') || '').trim().toLowerCase(),
    yaw: -0.62,
    pitch: 0.34,
    zoom: 1,
    panX: 0,
    panY: 0,
    auto: false,
    drag: null,
    width: 0,
    height: 0,
    dpr: 1,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const hash = (text) => {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  };
  const randomFor = (text, salt) => {
    let value = hash(`${text}:${salt}`) || 1;
    return () => {
      value ^= value << 13; value >>>= 0;
      value ^= value >>> 17;
      value ^= value << 5; value >>>= 0;
      return value / 4294967296;
    };
  };

  function categoryCenters(nodes) {
    const keys = [...new Set(nodes.map((node) => node.category || 'uncategorized'))];
    const centers = new Map();
    keys.forEach((key, index) => {
      const angle = (index / Math.max(1, keys.length)) * Math.PI * 2 - Math.PI / 2;
      const radius = keys.length === 1 ? 0 : 0.72;
      centers.set(key, {
        x: Math.cos(angle) * radius,
        y: ((index % 3) - 1) * 0.32,
        z: Math.sin(angle) * radius,
      });
    });
    return centers;
  }

  function layout(nodes, edges) {
    const centers = categoryCenters(nodes);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      const random = randomFor(node.id, 'position');
      const center = centers.get(node.category || 'uncategorized') || { x: 0, y: 0, z: 0 };
      const radius = 0.13 + random() * 0.25;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      node.x = center.x + Math.sin(phi) * Math.cos(theta) * radius;
      node.y = center.y + Math.cos(phi) * radius * 0.8;
      node.z = center.z + Math.sin(phi) * Math.sin(theta) * radius;
      node.vx = 0; node.vy = 0; node.vz = 0;
      node.degree = 0;
    }
    for (const edge of edges) {
      const left = byId.get(edge.source);
      const right = byId.get(edge.target);
      if (left !== undefined) left.degree += 1;
      if (right !== undefined) right.degree += 1;
    }
    const steps = nodes.length > 180 ? 64 : nodes.length > 80 ? 90 : 126;
    for (let step = 0; step < steps; step += 1) {
      const cooling = 1 - step / steps;
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        const left = nodes[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
          const right = nodes[rightIndex];
          let dx = left.x - right.x;
          let dy = left.y - right.y;
          let dz = left.z - right.z;
          let distance2 = dx * dx + dy * dy + dz * dz;
          if (distance2 < 0.0008) {
            const random = randomFor(`${left.id}:${right.id}`, step);
            dx += (random() - 0.5) * 0.02;
            dy += (random() - 0.5) * 0.02;
            dz += (random() - 0.5) * 0.02;
            distance2 = dx * dx + dy * dy + dz * dz + 0.0008;
          }
          const distance = Math.sqrt(distance2);
          const force = Math.min(0.07, 0.0018 / distance2) * cooling;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          const fz = (dz / distance) * force;
          left.vx += fx; left.vy += fy; left.vz += fz;
          right.vx -= fx; right.vy -= fy; right.vz -= fz;
        }
        const center = centers.get(left.category || 'uncategorized') || { x: 0, y: 0, z: 0 };
        left.vx += (center.x - left.x) * 0.012;
        left.vy += (center.y - left.y) * 0.012;
        left.vz += (center.z - left.z) * 0.012;
        left.vx -= left.x * 0.004; left.vy -= left.y * 0.004; left.vz -= left.z * 0.004;
      }
      for (const edge of edges) {
        const left = byId.get(edge.source);
        const right = byId.get(edge.target);
        if (left === undefined || right === undefined) continue;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const dz = right.z - left.z;
        const distance = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const target = 0.58;
        const force = (distance - target) * 0.055 * Math.max(0.2, edge.weight);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const fz = (dz / distance) * force;
        left.vx += fx; left.vy += fy; left.vz += fz;
        right.vx -= fx; right.vy -= fy; right.vz -= fz;
      }
      for (const node of nodes) {
        node.x += clamp(node.vx, -0.04, 0.04) * cooling;
        node.y += clamp(node.vy, -0.04, 0.04) * cooling;
        node.z += clamp(node.vz, -0.04, 0.04) * cooling;
        node.vx *= 0.76; node.vy *= 0.76; node.vz *= 0.76;
      }
    }
    let extent = 0;
    for (const node of nodes) extent = Math.max(extent, Math.abs(node.x), Math.abs(node.y), Math.abs(node.z));
    if (extent > 0) {
      const scale = Math.min(1.15, 1.0 / extent);
      for (const node of nodes) { node.x *= scale; node.y *= scale; node.z *= scale; }
    }
  }

  function rotate(x, y, z) {
    const cy = Math.cos(state.yaw);
    const sy = Math.sin(state.yaw);
    const cp = Math.cos(state.pitch);
    const sp = Math.sin(state.pitch);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    return { x: x1, y: y * cp - z1 * sp, z: y * sp + z1 * cp };
  }

  function project(node) {
    const rotated = rotate(node.x, node.y, node.z);
    const depth = 3.2 - rotated.z;
    const focal = Math.min(state.width, state.height) * 1.9 * state.zoom;
    return {
      x: state.width / 2 + state.panX + (rotated.x * focal) / depth,
      y: state.height / 2 + state.panY + (rotated.y * focal) / depth,
      depth,
      perspective: 3.0 / depth,
    };
  }

  function nodeRadius(node) {
    return (4.2 + Math.min(16, Math.log1p(Math.max(0, node.mentions)) * 4.5)) * clamp(1 / Math.pow(node._p.depth / 3.2, 1.1), 0.45, 1.9);
  }

  function edgeWidth(weight) {
    return 0.55 + clamp(weight, 0, 1) * 9;
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    state.width = Math.max(120, rect.width);
    state.height = Math.max(120, rect.height);
    state.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    draw();
  }

  function matchesQuery(node) {
    if (!state.query) return true;
    const hay = `${node.text} ${node.categoryLabel} ${(node.tags ?? []).join(' ')}`.toLowerCase();
    return state.query.split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
  }

  function connectedIds() {
    if (state.selectedId === null) return null;
    const ids = new Set([state.selectedId]);
    for (const edge of state.edges) {
      if (edge.source === state.selectedId) ids.add(edge.target);
      if (edge.target === state.selectedId) ids.add(edge.source);
    }
    return ids;
  }

  function textFor(node, limit) {
    const text = (node.text || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function drawLabels(projected, connected) {
    const candidates = [];
    for (const node of state.nodes) {
      const isSelected = node.id === state.selectedId;
      const isHover = node.id === state.hoverId;
      if (state.categoryFilter.length > 0 && node.category !== state.categoryFilter && !isSelected && !isHover) continue;
      if (!matchesQuery(node) && !isSelected && !isHover) continue;
      if (isSelected || isHover) candidates.push({ node, priority: 100, selected: isSelected });
      else if (connected !== null && connected.has(node.id)) candidates.push({ node, priority: 30 + node.mentions, selected: false });
      else candidates.push({ node, priority: node.mentions * 0.8 + Math.min(12, node.degree) });
    }
    candidates.sort((left, right) => right.priority - left.priority);
    const occupied = [];
    const limit = document.body.classList.contains('embed')
      ? (state.width < 360 ? 2 : 4)
      : state.width < 540 ? 7 : 12;
    ctx.textBaseline = 'middle';
    for (const candidate of candidates.slice(0, 26)) {
      const projectedNode = projected.get(candidate.node.id);
      if (projectedNode === undefined) continue;
      if (connected !== null && !connected.has(candidate.node.id) && !candidate.selected) continue;
      ctx.font = `${candidate.selected ? 600 : 400} ${candidate.selected ? 12 : 10.5}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      const label = textFor(candidate.node, candidate.selected ? 30 : 14);
      const width = ctx.measureText(label).width;
      const radius = nodeRadius(candidate.node);
      let x = projectedNode.x + radius + 6;
      let y = projectedNode.y;
      if (x + width > state.width - 6) x = projectedNode.x - radius - width - 6;
      if (x < 4) x = 4;
      if (y < 10 || y > state.height - 10) continue;
      const rect = { left: x - 5, top: y - 10, right: x + width + 5, bottom: y + 10 };
      if (occupied.some((used) => !(rect.right < used.left || rect.left > used.right || rect.bottom < used.top || rect.top > used.bottom))) continue;
      if (occupied.length >= limit) break;
      occupied.push(rect);
      ctx.globalAlpha = candidate.selected ? 1 : Math.max(0.42, Math.min(0.95, 1.3 - projectedNode.depth * 0.16));
      ctx.strokeStyle = 'rgba(6, 9, 15, .92)';
      ctx.lineWidth = candidate.selected ? 4 : 3;
      ctx.strokeText(label, x, y);
      ctx.fillStyle = candidate.selected ? '#ffffff' : '#c7d9f4';
      ctx.fillText(label, x, y);
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (state.nodes.length === 0) return;
    const width = state.width;
    const height = state.height;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const background = ctx.createRadialGradient(width * 0.5, height * 0.36, 4, width * 0.5, height * 0.5, Math.max(width, height) * 0.8);
    background.addColorStop(0, '#182844');
    background.addColorStop(0.48, '#0b1220');
    background.addColorStop(1, '#05070c');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    // Depth haze.
    const glow = ctx.createRadialGradient(width * 0.5, height * 0.45, 0, width * 0.5, height * 0.45, Math.max(width, height) * 0.65);
    glow.addColorStop(0, 'rgba(92, 139, 225, .10)');
    glow.addColorStop(1, 'rgba(6, 9, 15, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    for (const node of state.nodes) node._p = project(node);
    const projected = new Map(state.nodes.map((node) => [node.id, node._p]));
    const connected = connectedIds();
    const edgeOrder = [...state.edges].sort((left, right) => {
      const leftDepth = (state.byId.get(left.source)._p.depth + state.byId.get(left.target)._p.depth) / 2;
      const rightDepth = (state.byId.get(right.source)._p.depth + state.byId.get(right.target)._p.depth) / 2;
      return rightDepth - leftDepth;
    });
    ctx.lineCap = 'round';
    for (const edge of edgeOrder) {
      const left = state.byId.get(edge.source);
      const right = state.byId.get(edge.target);
      if (left?._p === undefined || right?._p === undefined) continue;
      const active = state.selectedId === null || edge.source === state.selectedId || edge.target === state.selectedId;
      const inCategory = state.categoryFilter.length === 0
        || left.category === state.categoryFilter
        || right.category === state.categoryFilter;
      const inQuery = !state.query || matchesQuery(left) || matchesQuery(right);
      const depth = (left._p.depth + right._p.depth) / 2;
      const widthPx = edgeWidth(edge.weight) * clamp(1.35 - depth * 0.08, 0.55, 1.3);
      const alpha = (0.14 + edge.weight * 0.95) * clamp(1.4 - depth * 0.1, 0.32, 1) * (active ? 1 : 0.12) * (inCategory ? 1 : 0.06) * (inQuery ? 1 : 0.05);
      ctx.strokeStyle = left.color || '#7cb8ff';
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(0.35, widthPx);
      ctx.beginPath();
      ctx.moveTo(left._p.x, left._p.y);
      ctx.lineTo(right._p.x, right._p.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const ordered = [...state.nodes].sort((left, right) => right._p.depth - left._p.depth);
    for (const node of ordered) {
      const p = node._p;
      const radius = nodeRadius(node);
      const dimmed = connected !== null && !connected.has(node.id);
      const filtered = state.categoryFilter.length > 0 && node.category !== state.categoryFilter;
      const unmatched = !matchesQuery(node);
      const hovered = node.id === state.hoverId;
      const selected = node.id === state.selectedId;
      const alpha = (dimmed || filtered || unmatched) && !selected && !hovered ? 0.13 : clamp(1.32 - p.depth * 0.1, 0.55, 1.05);
      ctx.globalAlpha = alpha;
      if (selected || hovered) {
        ctx.shadowColor = node.color;
        ctx.shadowBlur = selected ? 24 : 14;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.8, radius), 0, Math.PI * 2);
      ctx.fillStyle = node.color || '#7cb8ff';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = selected ? 2.2 : 1;
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(8, 12, 20, .72)';
      ctx.stroke();
      if (node.pinned) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 218, 128, .7)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    drawLabels(projected, connected);
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    for (const node of state.nodes) {
      const p = node._p;
      if (p === undefined) continue;
      const distance = Math.hypot(p.x - x, p.y - y);
      const hit = Math.max(6, nodeRadius(node) + 5);
      if (distance <= hit && (best === null || p.depth < best.p.depth)) best = { node, p };
    }
    return best?.node ?? null;
  }

  function select(id) {
    state.selectedId = id;
    renderLegend();
    renderDetail(id);
    draw();
  }

  function metaPill(text, color) {
    const span = document.createElement('span');
    span.className = 'pill';
    span.textContent = text;
    if (color) span.style.color = color;
    return span;
  }

  function renderDetail(id) {
    if (id === null) {
      detailEl.className = 'detail muted';
      detailEl.textContent = '点击任意节点查看详情';
      relationsEl.replaceChildren();
      return;
    }
    const node = state.byId.get(id);
    if (node === undefined) return;
    detailEl.className = 'detail';
    detailEl.replaceChildren();
    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.append(
      metaPill(node.categoryLabel || '未分类', node.color),
      metaPill(node.kind === 'episode' ? '回合' : node.kind === 'note' ? '笔记' : '对话', '#aebbd8'),
      metaPill(`提及 ${node.mentions}`, '#9fb6d8'),
      metaPill(`关系 ${node.degree}`, '#9fb6d8'),
    );
    detailEl.append(meta);
    const text = document.createElement('div');
    text.textContent = node.text || '(无文本)';
    detailEl.append(text);
    const relations = [];
    for (const edge of state.edges) {
      const otherId = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
      if (otherId !== null) relations.push({ id: otherId, weight: edge.weight });
    }
    relations.sort((left, right) => right.weight - left.weight);
    relationsEl.replaceChildren();
    for (const relation of relations.slice(0, 8)) {
      const other = state.byId.get(relation.id);
      if (other === undefined) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'relation';
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = other.color;
      const label = document.createElement('span');
      label.className = 'relation-text';
      label.textContent = textFor(other, 24);
      const weight = document.createElement('span');
      weight.className = 'relation-weight';
      weight.textContent = relation.weight.toFixed(2);
      button.append(dot, label, weight);
      button.addEventListener('click', () => select(other.id));
      relationsEl.append(button);
    }
  }

  function renderLegend() {
    legendEl.replaceChildren();
    for (const category of state.categories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'legend-item';
      button.dataset.active = state.categoryFilter === category.key ? 'true' : 'false';
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = category.color;
      const label = document.createElement('span');
      label.textContent = category.label;
      const count = document.createElement('span');
      count.className = 'legend-count';
      count.textContent = category.count;
      button.append(dot, label, count);
      button.addEventListener('click', () => {
        state.categoryFilter = state.categoryFilter === category.key ? '' : category.key;
        renderLegend();
        draw();
      });
      legendEl.append(button);
    }
  }

  function refreshStats() {
    statsEl.textContent = `${state.shown}/${state.total} 节点 · ${state.edges.length} 条关系 · 3D`;
  }

  function frame() {
    if (state.auto) {
      state.yaw += 0.0026;
      draw();
    }
    requestAnimationFrame(frame);
  }

  function bind() {
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture?.(event.pointerId);
      state.drag = {
        x: event.clientX,
        y: event.clientY,
        yaw: state.yaw,
        pitch: state.pitch,
        panX: state.panX,
        panY: state.panY,
        moved: false,
        button: event.button,
        pointerId: event.pointerId,
      };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (state.drag !== null) {
        const dx = event.clientX - state.drag.x;
        const dy = event.clientY - state.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
        if (state.drag.button === 0) {
          state.yaw = state.drag.yaw + dx * 0.006;
          state.pitch = clamp(state.drag.pitch + dy * 0.0045, -1.25, 1.25);
        } else {
          state.panX = state.drag.panX + dx;
          state.panY = state.drag.panY + dy;
        }
        draw();
        return;
      }
      const node = pick(event.clientX, event.clientY);
      if ((node?.id ?? null) !== state.hoverId) {
        state.hoverId = node?.id ?? null;
        canvas.style.cursor = node === null ? 'grab' : 'pointer';
        draw();
      }
    });
    const end = (event) => {
      if (state.drag === null) return;
      const drag = state.drag;
      state.drag = null;
      canvas.releasePointerCapture?.(drag.pointerId);
      if (!drag.moved && drag.button === 0) select(pick(event.clientX, event.clientY)?.id ?? null);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      state.zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.0012), 0.4, 3.4);
      draw();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('dblclick', () => resetView());
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(stage);
  }

  function resetView() {
    state.yaw = -0.62;
    state.pitch = 0.34;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    draw();
  }

  function openPopout() {
    const url = new URL(location.href);
    url.searchParams.delete('embed');
    url.searchParams.set('popout', '1');
    const opened = window.open(url.toString(), 'dsh-memory-graph', 'popup=yes,width=1120,height=820,resizable=yes,scrollbars=no');
    if (opened === null) {
      // A blocked popup is still recoverable: fullscreen keeps the graph usable.
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  async function load() {
    try {
      const response = await fetch('/dsh-memory/api/graph', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 600 }),
        credentials: 'same-origin',
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error?.message || '加载图谱失败');
      const data = payload.value;
      state.nodes = Array.isArray(data.nodes) ? data.nodes : [];
      state.edges = Array.isArray(data.edges) ? data.edges : [];
      state.byId = new Map(state.nodes.map((node) => [node.id, node]));
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      state.total = data.total ?? state.nodes.length;
      state.shown = data.shown ?? state.nodes.length;
      layout(state.nodes, state.edges);
      loading.classList.add('hidden');
      refreshStats();
      renderLegend();
      renderDetail(null);
      resize();
      window.__DSM_GRAPH__ = {
        state,
        nodes: state.nodes,
        edges: state.edges,
        categories: state.categories,
        edgeWidth,
        nodeRadius: (node) => nodeRadius(node),
        project: (node) => project(node),
        select,
        resetView,
      };
    } catch (error) {
      loading.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  document.getElementById('auto').addEventListener('click', (event) => {
    state.auto = !state.auto;
    event.currentTarget.dataset.active = state.auto ? 'true' : 'false';
  });
  document.getElementById('reset').addEventListener('click', resetView);
  document.getElementById('full').addEventListener('click', toggleFullscreen);
  document.getElementById('popout').addEventListener('click', openPopout);
  bind();
  requestAnimationFrame(frame);
  void load();
})();
