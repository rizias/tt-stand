export function reportDialog(title, content, onClose) {
  const dialog = node('dialog', undefined, 'report-dialog');
  dialog.append(
    heading('h2', title),
    button('Закрыть', () => dialog.close()),
    content,
  );
  dialog.addEventListener('close', () => {
    onClose?.();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function renderLine(panel) {
  const box = node('section', undefined, 'panel line-panel');
  box.dataset.panel = panel.id;
  box.tabIndex = -1;
  box.append(heading('h2', panel.title), note(`Единица: ${metricUnit(panel.unit) || 'не указана'}`), warningBox(panel));
  if (panel.description) box.append(note(panel.description));
  if (!panel.catalog?.length) {
    box.append(note(panel.message || 'Нет измерений.'));
    return box;
  }
  const controller = createLineController(panel, payload.range, loadDetail);
  const expand = () => {
    const view = lineView(panel, controller, null, true);
    reportDialog(panel.title, view.element, () => {
      view.dispose();
      box.focus({ preventScroll: true });
    });
  };
  const view = lineView(panel, controller, expand, false);
  box.append(view.element);
  const catalogButton = button(`Выбрать объект (${panel.catalog.length})`, () => {
    let dialog;
    const catalog = seriesCatalog(panel, controller, () => {
      dialog.close();
      box.focus({ preventScroll: true });
      box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    dialog = reportDialog(`${panel.title}: объекты и статистика`, catalog.element, () => {
      catalog.dispose();
      catalogButton.focus({ preventScroll: true });
    });
  });
  box.append(
    catalogButton,
    button('Все объекты', () => controller.reset()),
  );
  return box;
}

function lineView(panel, controller, expand, large) {
  const element = node('div', undefined, 'line-view');
  const controls = chartControls(
    controller,
    panel.sources?.find((source) => source.dataset === 'current'),
    expand,
  );
  const status = node('p', '', 'chart-state');
  status.setAttribute('aria-live', 'polite');
  const legend = node('div', undefined, 'legend');
  const canvas = node('div', undefined, 'plot-host');
  const tip = node('div', undefined, 'tip');
  tip.hidden = true;
  element.append(controls.element, status, legend, canvas, tip);
  const paint = () => {
    const state = controller.state;
    const chosen = panel.catalog.find((item) => item.id === state.selectedId);
    if (state.error) {
      status.textContent = state.error;
      status.className = 'chart-state bad';
    } else {
      status.className = 'chart-state';
      status.textContent = state.loadingId
        ? 'Загрузка полных измерений…'
        : chosen
          ? `На графике: ${chosen.label}. Все ${chosen.count} измерений.`
          : `Обзор: ${state.visible.size} из ${panel.catalog.length} объектов с наибольшими максимумами за период.`;
    }
    paintLineView(panel, controller, legend, canvas, tip, large);
  };
  const unsubscribe = controller.subscribe(paint);
  paint();
  const unwatch = watchSize(canvas, paint);
  return {
    element,
    dispose: () => {
      unsubscribe();
      controls.dispose();
      unwatch();
    },
  };
}

function paintLineView(panel, controller, legend, canvas, tip, large) {
  const state = controller.state,
    series = state.series;
  const palette = seriesPalette(panel, series);
  legend.replaceChildren();
  series.forEach((item, index) => {
    const values =
      Object.values(item.labels ?? {})
        .map(formatCell)
        .join(' · ') ||
      item.label ||
      item.id;
    const toggle = button(shortLabel(values, 70), () => controller.toggle(item.id));
    toggle.className = state.visible.has(item.id) ? 'legend-item' : 'legend-item off';
    toggle.title = `${datasetName(item.dataset)} · ${item.label}`;
    toggle.setAttribute('aria-pressed', String(state.visible.has(item.id)));
    const swatch = node('span', undefined, 'swatch');
    swatch.style.background = colorFor(palette.get(item.id) ?? index);
    if (item.dataset === 'baseline') {
      swatch.classList.add('dashed');
      toggle.append(node('span', ' · для сравнения'));
    }
    toggle.prepend(swatch);
    legend.append(toggle);
  });
  const shown = series
    .map((item, index) => ({ item, index: palette.get(item.id) ?? index }))
    .filter((entry) => state.visible.has(entry.item.id));
  canvas.replaceChildren();
  if (!shown.length) {
    canvas.append(note('Все объекты скрыты. Выберите объект в легенде.'));
    return;
  }
  const height = large ? Math.max(380, Math.floor(window.innerHeight * 0.58)) : 380;
  const svg = chartSvg(shown, panel.unit, tip, controller.yDomain(), canvas.getBoundingClientRect().width || 900, {
    height,
    range: state.range,
    onRange: (range) => {
      void controller.setRange(range);
    },
  });
  svg.setAttribute('aria-label', panel.title);
  canvas.append(svg);
}

function seriesPalette(panel, series) {
  const colors = new Map(),
    result = new Map();
  const ordered = [
    ...series.filter((item) => item.dataset === 'current'),
    ...series.filter((item) => item.dataset !== 'current'),
  ];
  for (const item of ordered) {
    const meta = panel.catalog.find((row) => row.id === item.id);
    const key = meta?.duplicate ? item.id : (meta?.key ?? item.id);
    if (!colors.has(key)) colors.set(key, colors.size);
    result.set(item.id, colors.get(key));
  }
  return result;
}
