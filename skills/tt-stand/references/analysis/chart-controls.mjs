function moveWindow(controller, factor, shift = 0) {
  const current = controller.state.range,
    bounds = controller.bounds;
  if (!current || !bounds) return;
  const span = Math.min(bounds.max - bounds.min, (current.max - current.min) * factor);
  const center = (current.min + current.max) / 2 + shift * (current.max - current.min);
  const min = Math.max(bounds.min, Math.min(bounds.max - span, center - span / 2));
  void controller.setRange({ min, max: min + span });
}

export function chartControls(controller, source, expand) {
  const root = node('div', undefined, 'chart-controls');
  const controls = [
    button('Приблизить', () => moveWindow(controller, 0.5)),
    button('Отдалить', () => moveWindow(controller, 2)),
    button('Влево', () => moveWindow(controller, 1, -0.5)),
    button('Вправо', () => moveWindow(controller, 1, 0.5)),
    button('Весь период', () => controller.fullPeriod()),
  ];
  const scale = button('Масштаб по данным', () => controller.toggleScale());
  root.append(...controls, scale);
  if (expand) root.append(button('Развернуть', expand));
  const grafana = link('#', 'Открыть исходный запрос в Grafana');
  grafana.target = '_blank';
  grafana.rel = 'noopener noreferrer';
  const unavailable = note(
    'Точная ссылка в Grafana недоступна: нужен адрес, известный тип источника и сохранённый запрос.',
  );
  root.append(grafana, unavailable);
  const range = note('');
  range.className = 'range-status';
  root.append(range);
  const update = () => {
    for (const control of controls) control.disabled = Boolean(controller.state.loadingId) || !controller.state.range;
    scale.textContent = controller.state.autoY ? 'Общий масштаб Y' : 'Масштаб по данным';
    scale.setAttribute('aria-pressed', String(controller.state.autoY));
    const value = controller.state.range;
    range.textContent = value
      ? `${formatUtc(value.min)} — ${formatUtc(value.max)} · ${payload.timezone}`
      : 'Период неизвестен';
    const url = grafanaLink(source, value);
    grafana.hidden = !url;
    unavailable.hidden = Boolean(url);
    if (url) grafana.href = url;
  };
  const dispose = controller.subscribe(update);
  update();
  return { element: root, dispose };
}

export function chartWindowSelection(svg, geom, domain, onRange) {
  if (!onRange) return;
  let start = null;
  const selection = svgEl('rect', {
    y: geom.top,
    height: geom.innerH,
    fill: 'var(--accent)',
    opacity: '0.15',
    'pointer-events': 'none',
  });
  selection.style.display = 'none';
  svg.append(selection);
  const position = (event) => {
    const rect = svg.getBoundingClientRect();
    return Math.max(geom.left, Math.min(geom.w - geom.right, ((event.clientX - rect.left) / rect.width) * geom.w));
  };
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    start = position(event);
    svg.setPointerCapture?.(event.pointerId);
    selection.setAttribute('x', start);
    selection.setAttribute('width', 0);
    selection.style.display = '';
  });
  svg.addEventListener('pointermove', (event) => {
    if (start === null) return;
    const end = position(event);
    selection.setAttribute('x', Math.min(start, end));
    selection.setAttribute('width', Math.abs(end - start));
  });
  const cancel = () => {
    start = null;
    selection.style.display = 'none';
  };
  svg.addEventListener('pointercancel', cancel);
  svg.addEventListener('pointerup', (event) => {
    if (start === null) return;
    const end = position(event),
      begin = start;
    cancel();
    if (Math.abs(end - begin) < 8) return;
    const time = (x) => domain.min + ((x - geom.left) / geom.innerW) * (domain.max - domain.min);
    onRange({ min: time(Math.min(begin, end)), max: time(Math.max(begin, end)) });
  });
}
