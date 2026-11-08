function compareCells(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  const number = (value) =>
    typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  const na = number(a),
    nb = number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? nb - na : String(b).localeCompare(String(a));
}

function pages(columns, initialRows, options = {}) {
  const box = node('div', undefined, 'paged-table');
  const search = node('input');
  search.type = 'search';
  search.placeholder = 'Поиск по всем строкам';
  search.setAttribute('aria-label', options.searchLabel ?? 'Поиск по всем строкам');
  const status = note('');
  status.className = 'table-status note';
  const table = node('table');
  const head = node('thead'),
    body = node('tbody'),
    headerRow = node('tr');
  const state = { rows: initialRows, page: 0, field: options.rankField ?? null, direction: 1 };
  for (const column of columns) {
    const cell = node('th');
    cell.append(
      button(options.titles?.[column] ?? column, () => {
        state.direction = state.field === column ? -state.direction : 1;
        state.field = column;
        state.page = 0;
        paint();
      }),
    );
    headerRow.append(cell);
  }
  head.append(headerRow);
  table.append(head, body);
  const previous = button('Назад', () => {
    state.page--;
    paint();
  });
  const next = button('Далее', () => {
    state.page++;
    paint();
  });
  const nav = node('div', undefined, 'pager');
  nav.append(previous, next);
  search.addEventListener('input', () => {
    state.page = 0;
    paint();
  });
  function paint() {
    const query = search.value.toLocaleLowerCase();
    let rows = state.rows.filter((row) =>
      (options.searchText?.(row) ?? Object.values(row).map(formatCell).join(' ')).toLocaleLowerCase().includes(query),
    );
    if (state.field) rows = [...rows].sort((a, b) => state.direction * compareCells(a[state.field], b[state.field]));
    const start = state.page * 20;
    const shown = rows.slice(start, start + 20);
    body.replaceChildren();
    for (const row of shown) {
      const tr = node('tr');
      for (const column of columns) {
        const td = node('td');
        if (options.cell) options.cell(td, row, column);
        else {
          td.textContent = formatCell(row[column]);
          if (typeof row[column] === 'number') td.className = 'numeric';
        }
        tr.append(td);
      }
      body.append(tr);
    }
    status.textContent = `Показано ${shown.length} из ${rows.length} · всего ${state.rows.length} · страница ${state.page + 1}`;
    previous.disabled = state.page === 0;
    next.disabled = start + 20 >= rows.length;
  }
  box.append(search, status, table, nav);
  paint();
  return {
    box,
    refresh: paint,
    replace: (rows) => {
      state.rows = rows;
      state.page = 0;
      paint();
    },
  };
}

export function seriesCatalog(panel, controller, onSelected) {
  const box = node('div', undefined, 'series-catalog');
  box.append(note(`Показатель: ${panel.title}. Единица: ${metricUnit(panel.unit) || 'не указана'}.`));
  box.append(
    note(
      'Статистика за весь период отчёта. Максимум — наибольшее измерение. Среднее — сумма конечных измерений, делённая на их число; пропуски исключены, длительность между измерениями не учитывается.',
    ),
  );
  const message = note('');
  message.className = 'detail-status';
  message.setAttribute('aria-live', 'polite');
  const columns = ['label', 'max', 'maxTime', 'mean', 'count', 'choose'];
  const titles = {
    label: 'Объект',
    max: 'Максимум за период',
    maxTime: 'Время максимума',
    mean: 'Среднее за период',
    count: 'Измерений',
    choose: 'Выбор',
  };
  const cell = (td, row, column) => {
    if (column === 'choose') {
      const selected = controller.state.selectedId === row.id;
      const loading = controller.state.loadingId === row.id;
      const select = button(loading ? 'Загрузка…' : selected ? 'Выбрано' : 'Показать', async () => {
        if (await controller.select(row)) onSelected();
      });
      select.disabled = selected || loading;
      select.setAttribute('aria-pressed', String(selected));
      select.dataset.objectId = row.id;
      td.append(select);
    } else if (column === 'label') {
      td.textContent = `${datasetName(row.dataset)} · ${row.label}${row.duplicate ? ' · совпадающие метки, сравнение неоднозначно' : ''}`;
      td.title = JSON.stringify(row.labels);
    } else if (column === 'maxTime') td.textContent = formatUtc(row[column]);
    else {
      td.className = 'numeric';
      td.textContent = column === 'count' ? String(row.count) : metricValue(row[column], panel.unit);
    }
  };
  const table = pages(columns, panel.catalog, {
    titles,
    cell,
    rankField: 'max',
    searchText: (row) => `${row.label} ${JSON.stringify(row.labels)} ${row.id} ${row.dataset}`,
    searchLabel: 'Поиск объекта по всем меткам',
  });
  const update = () => {
    message.className = controller.state.error ? 'detail-status bad' : 'detail-status';
    message.textContent =
      controller.state.error ??
      (controller.state.loadingId
        ? 'Загрузка измерений…'
        : controller.state.selectedId
          ? 'Выбранный объект отмечен в таблице.'
          : 'Выберите объект для просмотра его измерений.');
    table.refresh();
  };
  const dispose = controller.subscribe(update);
  box.append(
    button('Все объекты', () => controller.reset()),
    message,
    table.box,
  );
  update();
  return { element: box, dispose };
}

export function renderTable(panel) {
  const box = node('section', undefined, 'panel table-panel');
  box.dataset.panel = panel.id;
  box.append(heading('h2', panel.title), warningBox(panel));
  if (!panel.blocks?.length) {
    box.append(note(panel.message || 'Пустые данные.'));
    return box;
  }
  for (const block of panel.blocks) {
    const section = node('div', undefined, 'table-block');
    section.append(
      heading('h3', datasetName(block.dataset)),
      note(
        block.rankField
          ? `Обзор: убывание ${block.rankField}. HTTP-длительность не является CPU; процентили не складываются.`
          : 'Обзор: порядок источника, критерий ранжирования не задан.',
      ),
    );
    const table = pages(block.columns, block.rows, { rankField: block.rankField });
    const message = note(
      `Показано ${block.rows.length} из ${block.totalRows} строк. Поиск полного набора доступен после загрузки детализации.`,
    );
    const load = button(`Загрузить все строки (${block.totalRows})`, async () => {
      load.disabled = true;
      message.textContent = `Загрузка ${block.detailFile}`;
      try {
        const full = await loadDetail(block.detailKey, block.detailFile);
        table.replace(full.rows);
        message.textContent = `Поиск и сортировка по всем ${full.rows.length} строкам. На странице до 20 строк.`;
      } catch (error) {
        message.textContent = error.message;
        message.className = 'bad';
        load.disabled = false;
      }
    });
    section.append(message, load, table.box);
    box.append(section);
  }
  return box;
}
