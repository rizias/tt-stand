export function renderInterval(panel) {
  const box = node('section', undefined, 'panel timeline-panel');
  box.append(heading('h2', panel.title), warningBox(panel));
  const items = panel.intervals ?? [];
  if (!items.length || !payload.range) {
    box.append(note(panel.message || 'Пустые данные.'));
    return box;
  }
  const canvas = node('div', undefined, 'plot-host');
  const paint = () => {
    canvas.replaceChildren(drawTimeline(panel, canvas.getBoundingClientRect().width || 1040));
  };
  box.append(
    canvas,
    note('Интервалы показаны только по предоставленным данным; дополнительные поля доступны в полном списке.'),
  );
  const details = node('details');
  details.append(node('summary', 'Полные названия и интервалы'));
  const list = node('ul');
  for (const item of items)
    list.append(
      node(
        'li',
        `${item.label} · ${formatUtc(item.start)} — ${formatUtc(item.end)} · ${JSON.stringify(item.fields ?? {})}`,
      ),
    );
  details.append(list);
  box.append(details);
  paint();
  watchSize(canvas, paint);
  return box;
}

function drawTimeline(panel, width) {
  const items = panel.intervals;
  const geom = {
    w: width,
    h: items.length * 24 + 48,
    left: Math.min(235, width * 0.38),
    right: 20,
    top: 12,
    bottom: 36,
  };
  geom.innerW = geom.w - geom.left - geom.right;
  geom.innerH = geom.h - geom.top - geom.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${geom.w} ${geom.h}`, role: 'img', 'aria-label': panel.title });
  svg.classList.add('timeline');
  const range = payload.range;
  const ticks = width <= 420 ? 3 : 5;
  for (let index = 0; index < ticks; index++) {
    const time = range.min + ((range.max - range.min) * index) / (ticks - 1);
    const x = geom.left + (geom.innerW * index) / (ticks - 1);
    svg.append(svgEl('line', { x1: x, x2: x, y1: geom.top, y2: geom.h - geom.bottom, stroke: 'var(--line)' }));
    const text = svgEl('text', {
      x,
      y: geom.h - 12,
      class: 'axis',
      'text-anchor': index === 0 ? 'start' : index === ticks - 1 ? 'end' : 'middle',
    });
    text.textContent = shortUtc(time, range.max - range.min);
    svg.append(text);
  }
  items.forEach((item, index) => {
    const y = geom.top + index * 24;
    const label = svgEl('text', { x: 4, y: y + 13, class: 'axis' });
    label.textContent = shortLabel(item.label, Math.max(8, Math.floor((geom.left - 8) / 7)));
    const title = svgEl('title', {});
    title.textContent = `${item.label} · ${formatUtc(item.start)} — ${formatUtc(item.end)} · ${JSON.stringify(item.fields ?? {})}`;
    label.append(title);
    const start = geom.left + ((item.start - range.min) / (range.max - range.min)) * geom.innerW;
    const stop = geom.left + ((item.end - range.min) / (range.max - range.min)) * geom.innerW;
    const bar = svgEl('rect', { x: start, y: y + 4, width: Math.max(1, stop - start), height: 10, fill: '#9eabb7' });
    const barTitle = svgEl('title', {});
    barTitle.textContent = title.textContent;
    bar.append(barTitle);
    svg.append(label, bar);
  });
  addFocus(svg, geom, range);
  svg.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * geom.w;
    updateFocus(range.min + Math.max(0, Math.min(1, (x - geom.left) / geom.innerW)) * (range.max - range.min));
  });
  return svg;
}
