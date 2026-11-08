export function chartSvg(shown, unit, tip, yDomain, width = 640, options = {}) {
  const geom = { w: width, h: options.height ?? 380, left: 70, right: 18, top: 16, bottom: 44 };
  geom.innerW = geom.w - geom.left - geom.right;
  geom.innerH = geom.h - geom.top - geom.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${geom.w} ${geom.h}`, role: 'img', 'aria-label': 'График' });
  svg.classList.add('chart');
  const xDom = options.range ?? payload.range;
  const filtered = shown.map((entry) => ({
    ...entry,
    item: {
      ...entry.item,
      points: entry.item.points.filter((point) => !xDom || (point.t >= xDom.min && point.t <= xDom.max)),
    },
  }));
  const box = extentOf(filtered);
  if (!box) {
    const text = svgEl('text', { x: 16, y: 40, class: 'axis' });
    text.textContent = 'В выбранном участке нет измерений.';
    svg.append(text);
    return svg;
  }
  const domain = xDom ?? padDomain(box.minT, box.maxT, 1000);
  const yDom = yDomain ?? { min: Math.min(0, box.minV), max: box.maxV || 1 };
  drawGrid(svg, geom, domain, yDom);
  const hits = [];
  for (const entry of filtered) drawSeries(svg, entry, geom, domain, yDom, hits);
  addFocus(svg, geom, domain);
  chartWindowSelection(svg, geom, domain, options.onRange);
  svg.addEventListener('mousemove', (event) => {
    moveTip(svg, hits, unit, tip, event);
    const rect = svg.getBoundingClientRect();
    const relative = ((event.clientX - rect.left) / rect.width) * geom.w;
    updateFocus(
      domain.min + Math.max(0, Math.min(1, (relative - geom.left) / geom.innerW)) * (domain.max - domain.min),
    );
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
  });
  return svg;
}

function extentOf(shown) {
  let minT = Infinity;
  let maxT = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  let times = 0;
  let values = 0;
  for (const entry of shown) {
    for (const point of entry.item.points) {
      if (Number.isFinite(point.t)) {
        times += 1;
        minT = Math.min(minT, point.t);
        maxT = Math.max(maxT, point.t);
      }
      if (Number.isFinite(point.v)) {
        values += 1;
        minV = Math.min(minV, point.v);
        maxV = Math.max(maxV, point.v);
      }
    }
  }
  if (!times || !values) return null;
  return { minT, maxT, minV, maxV };
}

function padDomain(min, max, fallback) {
  if (min === max) {
    const padBy = fallback;
    return { min: min - padBy, max: max + padBy };
  }
  const padBy = (max - min) * 0.08;
  return { min: min - padBy, max: max + padBy };
}

function tickValues(min, max, count) {
  const out = [];
  const step = (max - min) / (count - 1);
  for (let i = 0; i < count; i += 1) out.push(min + step * i);
  return out;
}

function sx(value, domain, geom) {
  return geom.left + ((value - domain.min) / (domain.max - domain.min)) * geom.innerW;
}

function sy(value, domain, geom) {
  return geom.top + ((domain.max - value) / (domain.max - domain.min)) * geom.innerH;
}

function drawGrid(svg, geom, xDom, yDom) {
  for (const value of tickValues(yDom.min, yDom.max, 5)) drawYTick(svg, geom, yDom, value);
  const ticks = tickValues(xDom.min, xDom.max, geom.w <= 420 ? 3 : 5);
  ticks.forEach((time, index) => drawXTick(svg, geom, xDom, time, index, ticks.length));
}

function drawYTick(svg, geom, domain, value) {
  const y = sy(value, domain, geom);
  svg.append(svgEl('line', { x1: geom.left, x2: geom.w - geom.right, y1: y, y2: y, stroke: 'var(--line)' }));
  const label = svgEl('text', { x: geom.left - 8, y: y + 4, 'text-anchor': 'end', class: 'axis' });
  label.textContent = axisNumber(value);
  svg.append(label);
}

function drawXTick(svg, geom, domain, time, index, count) {
  const x = sx(time, domain, geom);
  svg.append(svgEl('line', { x1: x, x2: x, y1: geom.top, y2: geom.top + geom.innerH, stroke: 'var(--line)' }));
  const label = svgEl('text', {
    x,
    y: geom.h - 18,
    'text-anchor': index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
    class: 'axis',
  });
  label.textContent = shortUtc(time, domain.max - domain.min);
  svg.append(label);
}

function drawSeries(svg, entry, geom, xDom, yDom, hits) {
  const color = colorFor(entry.index);
  for (const part of segments(entry.item.points)) {
    drawPart(svg, entry.item, part, color, geom, xDom, yDom, hits);
  }
}

function segments(points) {
  const out = [];
  let current = [];
  const bucket = payload.range ? (payload.range.max - payload.range.min) / 299 : Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.v)) {
      if (current.length) out.push(current);
      current = [];
    } else {
      const previous = current.at(-1);
      if (
        previous &&
        Math.floor((point.t - payload.range.min) / bucket) - Math.floor((previous.t - payload.range.min) / bucket) > 1
      ) {
        out.push(current);
        current = [];
      }
      current.push(point);
    }
  }
  if (current.length) out.push(current);
  return out;
}

function drawPart(svg, item, part, color, geom, xDom, yDom, hits) {
  if (part.length > 1) svg.append(lineOf(item, part, color, geom, xDom, yDom));
  for (const point of part) {
    const x = sx(point.t, xDom, geom),
      y = sy(point.v, yDom, geom);
    if (part.length === 1) svg.append(svgEl('circle', { cx: x, cy: y, r: 3.5, fill: color }));
    hits.push({ x, y, point, item });
  }
}

function lineOf(item, part, color, geom, xDom, yDom) {
  const attrs = {
    points: part.map((point) => `${sx(point.t, xDom, geom)},${sy(point.v, yDom, geom)}`).join(' '),
    fill: 'none',
    stroke: color,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  };
  if (item.dataset === 'baseline') attrs['stroke-dasharray'] = '7 4';
  return svgEl('polyline', attrs);
}

export function svgEl(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function moveTip(svg, hits, unit, tip, event) {
  const hit = nearest(svg, hits, event);
  if (!hit) {
    tip.hidden = true;
    return;
  }
  showTip(tip, hit, unit, event);
}

function nearest(svg, hits, event) {
  const rect = svg.getBoundingClientRect();
  if (!hits.length || rect.width === 0 || rect.height === 0) return null;
  const view = svg.viewBox.baseVal;
  const x = ((event.clientX - rect.left) / rect.width) * view.width;
  const y = ((event.clientY - rect.top) / rect.height) * view.height;
  let best = null;
  let bestDistance = Infinity;
  for (const hit of hits) {
    const distance = (hit.x - x) ** 2 + (hit.y - y) ** 2;
    if (distance < bestDistance) {
      best = hit;
      bestDistance = distance;
    }
  }
  return best;
}

function showTip(tip, hit, unit, event) {
  tip.hidden = false;
  tip.replaceChildren();
  tip.append(tipLine('Время', formatUtc(hit.point.t)));
  tip.append(tipLine('Значение', metricValue(hit.point.v, unit)));
  tip.append(tipLine('Набор', datasetName(hit.item.dataset)));
  tip.append(tipLine('Подпись', hit.item.label || ''));
  const labels = hit.item.labels || {};
  for (const key of Object.keys(labels)) tip.append(tipLine(key, formatCell(labels[key])));
  placeTip(tip, event);
}

function tipLine(name, value) {
  const row = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `${name}: `;
  const span = document.createElement('span');
  span.textContent = value;
  row.append(strong, span);
  return row;
}

function placeTip(tip, event) {
  tip.style.left = '8px';
  tip.style.top = '8px';
  const rect = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, event.clientX + 12), window.innerWidth - rect.width - 8);
  const top = Math.min(Math.max(8, event.clientY + 12), window.innerHeight - rect.height - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function addFocus(svg, geom, domain) {
  const marker = svgEl('line', {
    y1: geom.top,
    y2: geom.top + geom.innerH,
    stroke: 'var(--accent)',
    'stroke-dasharray': '3 3',
    class: 'focus-line',
  });
  marker.style.display = 'none';
  svg.append(marker);
  focusHandlers.set(svg, (time) => {
    const x = sx(time, domain, geom);
    marker.setAttribute('x1', x);
    marker.setAttribute('x2', x);
    marker.style.display = time >= domain.min && time <= domain.max ? '' : 'none';
  });
}
