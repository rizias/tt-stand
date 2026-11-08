import assert from 'node:assert/strict';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reportDom, ReportElement } from './reportDom.ts';

const exec = promisify(execFile);
const renderer = resolve('skills/tt-stand/references/analysis/render.mjs');

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-ux-'));
  const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));
  const start = Date.parse('2001-02-03T00:00:00Z') / 1000;
  save('answer.json', {
    ok: true,
    incomplete: false,
    incompleteReasons: [],
    echo: {
      query: 'example_metric',
      datasourceType: 'prometheus',
      datasourceUid: 'fictional',
      start: '2001-02-03T00:00:00Z',
      end: '2001-02-03T08:00:00Z',
      namespaceScope: null,
    },
    data: {
      resultType: 'matrix',
      result: [
        {
          metric: { instance: 'fictional-a' },
          values: Array.from({ length: 9 }, (_, i) => [start + i * 3600, String(70 + i * 0.713456)]),
        },
        {
          metric: { instance: 'fictional-b' },
          values: Array.from({ length: 9 }, (_, i) => [start + i * 3600, String(30 + i * 0.412345)]),
        },
      ],
    },
  });
  save('manifest.json', {
    version: 1,
    grafana: { baseUrl: 'https://monitor.example.invalid/grafana' },
    requests: [{ id: 'memory', ok: true, responseFile: 'answer.json' }],
  });
  save('view.json', {
    version: 1,
    title: 'Пример',
    timezone: 'UTC',
    panels: [
      {
        kind: 'line',
        title: 'Использование памяти',
        description: 'Доля использованной памяти',
        unit: '%',
        format: 'prometheus-matrix',
        response: 'memory',
      },
    ],
  });
  const result = await exec(process.execPath, [
    renderer,
    '--manifest',
    join(root, 'manifest.json'),
    '--view',
    join(root, 'view.json'),
    '--out',
    join(root, 'report'),
  ]);
  const files = JSON.parse(result.stdout);
  const dom = await reportDom(files.reportFile);
  const buttons = (where: ReportElement, text: string) =>
    where.querySelectorAll('button').filter((button) => button.textContent === text);
  const panel = dom.document.root.querySelectorAll('.line-panel')[0]!;
  return {
    root,
    files,
    dom,
    buttons,
    panel,
    close() {
      dom.dispose();
      assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-ux-')));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('выбор через готовый HTML меняет состояние кнопки, подпись и фокус; повторная загрузка допускается после ошибки', async () => {
  const f = await fixture();
  try {
    await f.buttons(f.panel, 'Выбрать объект (2)')[0]!.click();
    let dialog = f.dom.document.root.querySelectorAll('dialog')[0]!;
    const pending = f.buttons(dialog, 'Показать')[0]!.click();
    assert.equal(f.buttons(dialog, 'Загрузка…')[0]!.disabled, true);
    f.dom.document.scripts.at(-1)!.onerror!();
    await pending;
    assert.match(dialog.textContent, /Не удалось загрузить детализацию/);
    const retry = f.buttons(dialog, 'Показать')[0]!.click();
    f.dom.resolve(f.dom.document.scripts.at(-1)!);
    await retry;
    await f.dom.flush();
    assert.equal(f.dom.document.root.querySelectorAll('dialog').length, 0);
    assert.equal(f.dom.document.scrolledTo, f.panel);
    assert.match(f.panel.querySelectorAll('.chart-state')[0]!.textContent, /fictional-a/);
    await f.buttons(f.panel, 'Выбрать объект (2)')[0]!.click();
    dialog = f.dom.document.root.querySelectorAll('dialog')[0]!;
    const selected = f.buttons(dialog, 'Выбрано')[0]!;
    assert.equal(selected.disabled, true);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    await f.buttons(dialog, 'Все объекты')[0]!.click();
    assert.equal(f.buttons(dialog, 'Выбрано').length, 0);
    assert.equal(f.buttons(dialog, 'Показать').length, 2);
    assert.ok(dialog.textContent.includes('%'));
    assert.ok(!dialog.textContent.includes('Полный максимум'));
    assert.ok(dialog.querySelectorAll('.numeric').every((cell) => !/\d,\d{3}/.test(cell.textContent)));
  } finally {
    f.close();
  }
});

test('приближение, возврат периода и большой dialog работают через кнопки без переноса главной панели', async () => {
  const f = await fixture();
  try {
    const parent = f.panel.parentNode;
    await f.buttons(f.panel, 'Приблизить')[0]!.click();
    assert.equal(f.dom.document.scripts.length, 2);
    for (const script of f.dom.document.scripts) f.dom.resolve(script);
    await f.dom.flush();
    await new Promise<void>((done) => setImmediate(done));
    const range = f.panel.querySelectorAll('.range-status')[0]!.textContent;
    assert.match(range, /02:00:00/);
    assert.match(range, /06:00:00/);
    const url = new URL(f.panel.querySelectorAll('a')[0]!.href);
    const panes = JSON.parse(url.searchParams.get('panes')!);
    assert.equal(panes.report.queries[0].expr, 'example_metric');
    assert.equal(panes.report.range.from, String(Date.parse('2001-02-03T02:00:00Z')));
    assert.equal(url.pathname, '/grafana/explore');
    await f.buttons(f.panel, 'Весь период')[0]!.click();
    assert.match(f.panel.querySelectorAll('.range-status')[0]!.textContent, /08:00:00/);
    await f.buttons(f.panel, 'Развернуть')[0]!.click();
    const dialog = f.dom.document.root.querySelectorAll('dialog')[0]!;
    assert.equal(dialog.open, true);
    assert.equal(f.panel.parentNode, parent);
    assert.ok(dialog.querySelectorAll('svg')[0]!.viewBox.baseVal.height > 380);
    await f.buttons(dialog, 'Закрыть')[0]!.click();
    assert.equal(f.panel.parentNode, parent);
    assert.equal(f.dom.document.activeElement, f.panel);
  } finally {
    f.close();
  }
});

test('analysis.json передаёт агенту единицы, определения и неокруглённые значения с полным источником', async () => {
  const f = await fixture();
  try {
    const analysis = JSON.parse(readFileSync(f.files.analysisFile, 'utf8'));
    const panel = analysis.panels[0];
    assert.equal(panel.unit, '%');
    assert.equal(panel.description, 'Доля использованной памяти');
    assert.equal(panel.objects[0].max, 70 + 8 * 0.713456);
    assert.equal(panel.objects[0].count, 9);
    assert.equal(panel.sources[0].query, 'example_metric');
    assert.equal(panel.sources[0].namespaceScope, null);
    assert.ok(
      readFileSync(resolve(join(f.files.analysisFile, '..'), panel.sources[0].responseFile), 'utf8').includes(
        'fictional-a',
      ),
    );
    assert.match(analysis.definitions.mean, /без взвешивания/);
    assert.equal(panel.objects[0].points, undefined);
  } finally {
    f.close();
  }
});

test('поздний ответ первого выбора не подменяет второй выбранный объект', async () => {
  const f = await fixture();
  try {
    await f.buttons(f.panel, 'Выбрать объект (2)')[0]!.click();
    const dialog = f.dom.document.root.querySelectorAll('dialog')[0]!;
    const first = f.buttons(dialog, 'Показать')[0]!.click();
    const second = f.buttons(dialog, 'Показать')[0]!.click();
    f.dom.resolve(f.dom.document.scripts[1]!);
    await second;
    f.dom.resolve(f.dom.document.scripts[0]!);
    await first;
    assert.match(f.panel.querySelectorAll('.chart-state')[0]!.textContent, /fictional-b/);
    await f.buttons(f.panel, 'Выбрать объект (2)')[0]!.click();
    const selected = f.buttons(f.dom.document.root.querySelectorAll('dialog')[0]!, 'Выбрано')[0]!;
    assert.equal(selected.dataset.objectId, 'current/memory/1');
  } finally {
    f.close();
  }
});

test('выделение мышью участка между отметками времени приближает соответствующие два часа — шесть часов', async () => {
  const f = await fixture();
  try {
    const svg = f.panel.querySelectorAll('svg')[0]!;
    const labels = svg.querySelectorAll('text');
    const start = Number(labels.find((label) => label.textContent === '02:00')!.getAttribute('x'));
    const finish = Number(labels.find((label) => label.textContent === '06:00')!.getAttribute('x'));
    await svg.emit('pointerdown', { clientX: start });
    await svg.emit('pointermove', { clientX: finish });
    await svg.emit('pointerup', { clientX: finish });
    for (const script of f.dom.document.scripts) f.dom.resolve(script);
    await new Promise<void>((done) => setImmediate(done));
    assert.match(f.panel.querySelectorAll('.range-status')[0]!.textContent, /02:00:00.*06:00:00/);
  } finally {
    f.close();
  }
});

test('Grafana-ссылка сохраняет VictoriaMetrics-запрос и UID, небезопасный адрес отклоняется', async () => {
  const f = await fixture();
  try {
    const answerPath = join(f.root, 'answer.json');
    const answer = JSON.parse(readFileSync(answerPath, 'utf8'));
    answer.echo.datasourceType = 'victoriametrics-datasource';
    answer.echo.query = 'sum by (instance) (rate(example_counter[5m]))';
    writeFileSync(answerPath, JSON.stringify(answer));
    const generated = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(f.root, 'manifest.json'),
      '--view',
      join(f.root, 'view.json'),
      '--out',
      join(f.root, 'vm-report'),
    ]);
    const analysis = JSON.parse(readFileSync(JSON.parse(generated.stdout).analysisFile, 'utf8'));
    const url = new URL(analysis.panels[0].grafanaUrl);
    const query = JSON.parse(url.searchParams.get('panes')!).report.queries[0];
    assert.equal(query.expr, answer.echo.query);
    assert.equal(query.datasource.type, 'victoriametrics-datasource');
    assert.equal(query.datasource.uid, 'fictional');
    assert.equal(query.range, true);
    assert.equal(url.searchParams.get('schemaVersion'), '1');
    assert.equal(url.searchParams.has('orgId'), false);
    const viewPath = join(f.root, 'view.json');
    const view = JSON.parse(readFileSync(viewPath, 'utf8'));
    view.grafana = { baseUrl: 'https://reader:placeholder@grafana.example.invalid' };
    writeFileSync(viewPath, JSON.stringify(view));
    await assert.rejects(
      exec(process.execPath, [
        renderer,
        '--manifest',
        join(f.root, 'manifest.json'),
        '--view',
        viewPath,
        '--out',
        join(f.root, 'unsafe'),
      ]),
      /без учётных данных/,
    );
  } finally {
    f.close();
  }
});
