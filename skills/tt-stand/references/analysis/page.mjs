export function header() {
  const head = node('header');
  head.append(heading('h1', payload.title));
  const range = payload.range;
  head.append(
    note(
      range
        ? `${formatUtc(range.min)} — ${formatUtc(range.max)} · ${payload.timezone}`
        : `Период данных не определён · ${payload.timezone}`,
    ),
  );
  head.append(
    note(`${payload.fullSeries} показателей · ${payload.fullPoints} измерений · полные данные сохранены отдельно`),
  );
  if (payload.baseline)
    head.append(note('Текущий и базовый наборы: общая абсолютная ось. Совпадение по времени не доказывает причину.'));
  const warnings = (payload.errors?.length ?? 0) + (payload.incomplete?.length ?? 0);
  head.append(
    node(
      'p',
      warnings
        ? `Ошибки или неполнота: ${warnings}. Проверьте диагностику.`
        : 'Отметок неполноты и ошибок панелей нет.',
      warnings ? 'bad' : 'status',
    ),
  );
  return head;
}

function diagnostics() {
  const details = node('details', undefined, 'diagnostics');
  details.append(node('summary', 'Источники и диагностика'));
  const list = node('ul');
  for (const source of payload.sources ?? [])
    list.append(
      node(
        'li',
        `${datasetName(source.dataset)} · ${source.id} · ${source.responseOk ? 'ответ получен' : source.error || 'ошибка'} ${(source.issues ?? []).join('; ')}`,
      ),
    );
  for (const error of payload.errors ?? []) list.append(node('li', `${error.id}: ${error.text}`, 'bad'));
  for (const item of payload.incomplete ?? [])
    list.append(node('li', `${datasetName(item.dataset)} · ${item.id}: ${(item.reasons ?? []).join('; ')}`, 'warn'));
  details.append(list);
  for (const file of payload.tableFiles ?? []) details.append(link(file, file), node('br'));
  if (payload.analysisFile) details.append(link(payload.analysisFile, 'Данные для анализа агентом (JSON)'));
  return details;
}

function peakCards() {
  const cards = node('div', undefined, 'peak-grid');
  for (const panel of payload.panels.filter((item) => item.type === 'line').slice(0, 3)) {
    const first = panel.catalog
      .filter((item) => item.dataset === 'current' && Number.isFinite(item.max))
      .sort((a, b) => b.max - a.max)[0];
    if (!first) continue;
    const card = node('div', undefined, 'peak-card');
    card.append(
      node('strong', panel.title),
      node('div', `${axisNumber(first.max)} ${metricUnit(panel.unit)}`.trim(), 'peak-value'),
      note(`${formatUtc(first.maxTime)} · ${shortLabel(first.label, 64)}`),
    );
    cards.append(card);
  }
  return cards;
}

export function watchSize(element, paint) {
  let previousWidth = 0;
  const observer = new ResizeObserver((entries) => {
    const width = entries[0].contentRect.width;
    if (width <= 0 || width === previousWidth) return;
    previousWidth = width;
    requestAnimationFrame(() => {
      paint();
      element.dataset.layoutReady = 'true';
    });
  });
  observer.observe(element);
  return () => observer.disconnect();
}

export function mount() {
  app.replaceChildren();
  app.append(header(), peakCards(), diagnostics());
  for (const panel of payload.panels.filter((item) => item.type === 'interval')) app.append(renderInterval(panel));
  const grid = node('div', undefined, 'chart-grid');
  for (const panel of payload.panels.filter((item) => item.type !== 'interval')) {
    if (panel.type === 'line') grid.append(renderLine(panel));
    else if (panel.type === 'table') grid.append(renderTable(panel));
    else grid.append(warningBox(panel));
  }
  app.append(grid);
  const ready = () => {
    const waiting = [...app.querySelectorAll('.plot-host')].some((element) => element.dataset.layoutReady !== 'true');
    if (waiting) requestAnimationFrame(ready);
    else document.documentElement.dataset.ready = 'true';
  };
  requestAnimationFrame(ready);
}
