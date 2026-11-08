import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { runInNewContext } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { tt, homeEnv } from './ttRunner.ts';

const exec = promisify(execFile);
const renderer = resolve('skills/tt-stand/references/analysis/render.mjs');

test('отдельный renderer отвергает view без timezone или unit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  const view = join(root, 'view.json');
  try {
    const args = [renderer, '--manifest', join(root, 'manifest.json'), '--view', view, '--out', join(root, 'out')];
    save(view, { version: 1, panels: [{ kind: 'line', unit: 'none' }] });
    const missingTimezone = await exec(process.execPath, args).catch((error: { stderr: string }) => error);
    assert.match(missingTimezone.stderr, /timezone/u);
    save(view, { version: 1, timezone: '+03:00', panels: [{ kind: 'line', unit: 'none' }] });
    const offsetTimezone = await exec(process.execPath, args).catch((error: { stderr: string }) => error);
    assert.match(offsetTimezone.stderr, /часового пояса IANA/u);
    save(view, { version: 1, timezone: 'UTC', panels: [{ kind: 'line' }] });
    const missingUnit = await exec(process.execPath, args).catch((error: { stderr: string }) => error);
    assert.match(missingUnit.stderr, /unit/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderer диагностирует неверные данные и сохраняет большое конечное среднее в HTML, JSON и CSV', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  const meanCases = [
    { values: [1e308, 1e308], mean: 1e308 },
    { values: [Number.MIN_VALUE, 0], mean: 0 },
    { values: [0, Number.MIN_VALUE], mean: 0 },
    { values: [3 * Number.MIN_VALUE, 0], mean: 2 * Number.MIN_VALUE },
    { values: [0, 3 * Number.MIN_VALUE], mean: 2 * Number.MIN_VALUE },
    { values: [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE, 1e-308], mean: 2e-309 },
    { values: [-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, -1e-308], mean: -2e-309 },
  ];
  try {
    save(join(root, 'source.json'), {
      ok: true,
      data: [
        { record: { time: '2026-02-30T00:00:00Z', value: 1e308, count: 1, duration: 1e308 } },
        { record: { time: '2026-02-28T00:00:00Z', value: 1e308, count: 1, duration: 1e308 } },
      ],
    });
    save(join(root, 'matrix.json'), {
      ok: true,
      data: {
        resultType: 'matrix',
        result: meanCases.map((item, index) => ({
          metric: { sample: String(index) },
          values: item.values.map((value, time) => [time, String(value)]),
        })),
      },
    });
    save(join(root, 'intervals.json'), [
      { begin: 0, end: 1, label: 'missing' },
      { begin: 1, end: 2, label: 'valid', release: 'fixture' },
    ]);
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [
        { id: 'source', responseFile: 'source.json', ok: true },
        { id: 'matrix', responseFile: 'matrix.json', ok: true },
      ],
    });
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'UTC',
      panels: [
        {
          id: 'calendar',
          kind: 'line',
          unit: 'none',
          response: 'source',
          format: 'logs-records',
          timeField: 'time',
          timeEncoding: 'rfc3339',
          valueField: 'value',
          groupFields: [],
        },
        { id: 'mean', kind: 'line', response: 'matrix', format: 'prometheus-matrix', unit: 'none' },
        {
          id: 'http',
          kind: 'table',
          response: 'source',
          format: 'logs-records',
          transform: 'http-summary',
          mapping: { groupFields: [], countField: 'count', durationSumField: 'duration', maxField: 'value' },
        },
        {
          id: 'intervals',
          kind: 'interval',
          format: 'rows-file',
          file: 'intervals.json',
          startField: 'begin',
          endField: 'end',
          labelField: 'label',
          timeEncoding: 'unixSeconds',
          fields: ['release'],
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
    ]).catch((error: { code: number; stdout: string }) => error);
    assert.equal('code' in result ? result.code : 0, 1);
    const files = JSON.parse(result.stdout);
    assert.deepEqual(
      files.panelErrors.map((error: { id: string }) => error.id),
      ['calendar', 'http', 'intervals'],
    );
    assert.match(files.panelErrors[0].text, /календар|RFC3339/);
    assert.match(files.panelErrors[1].text, /переполнение/i);
    assert.match(files.panelErrors[2].text, /release/);
    const payload = reportPayload(readFileSync(files.reportFile, 'utf8'));
    assert.deepEqual(
      payload.panels[1].catalog.map((series: { mean: number }) => series.mean),
      meanCases.map((item) => item.mean),
    );
    assert.deepEqual(payload.panels[2].blocks, []);
    assert.deepEqual(
      payload.panels[3].intervals.map((interval: { fields: object }) => interval.fields),
      [{ release: 'fixture' }],
    );
    const analysis = JSON.parse(readFileSync(files.analysisFile, 'utf8'));
    assert.deepEqual(
      analysis.panels[1].objects.map((series: { mean: number }) => series.mean),
      meanCases.map((item) => item.mean),
    );
    assert.deepEqual(analysis.errors, files.panelErrors);
    const csv = readFileSync(files.tableFiles[0], 'utf8');
    assert.ok(csv.includes(',1e+308\n'));
    assert.deepEqual(
      csv
        .trim()
        .split('\n')
        .slice(1)
        .map((row) => row.slice(row.lastIndexOf(',') + 1)),
      meanCases.map((item) => String(item.mean)),
    );
    assert.doesNotMatch(csv, /Infinity|NaN/);
    assert.equal(files.tableFiles.length, 1);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

function save(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

function reportPayload(html: string) {
  const opening = '<script type="application/json" id="report-data">';
  const start = html.indexOf(opening) + opening.length;
  const value = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
  return value.encoding === 'gzip' ? JSON.parse(gunzipSync(Buffer.from(value.data, 'base64')).toString('utf8')) : value;
}

test('готовый HTML сохраняет буквальные токены подстановки, собственные ключи и ссылку с # и %', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    const literal = "service-$$-$&-$`-$'";
    const sourceFile = join(root, 'link#100% sample.json');
    save(sourceFile, {
      ok: true,
      data: [{ record: { ['__proto__']: literal, constructor: literal, time: 1, value: 2 } }],
    });
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [{ id: literal, responseFile: sourceFile, ok: true }],
    });
    save(join(root, 'view.json'), {
      version: 1,
      title: literal,
      timezone: 'UTC',
      panels: [
        {
          kind: 'line',
          unit: 'none',
          response: literal,
          format: 'logs-records',
          timeField: 'time',
          timeEncoding: 'unixSeconds',
          valueField: 'value',
          groupFields: ['__proto__'],
        },
        { kind: 'table', response: literal, format: 'logs-records', columns: ['__proto__', 'constructor'] },
      ],
    });
    const { stdout } = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]);
    const files = JSON.parse(stdout);
    assert.deepEqual(files.panelErrors, []);
    const html = readFileSync(files.reportFile, 'utf8');
    const payload = reportPayload(html);
    assert.equal(payload.title, literal);
    assert.equal(payload.panels[0].catalog[0].labels.__proto__, literal);
    assert.deepEqual(payload.panels[1].blocks[0].rows, [{ ['__proto__']: literal, constructor: literal }]);
    const hrefs = [...html.matchAll(/<li><a href="([^"]+)">/g)].map((match) => match[1]!);
    const sourceHref = hrefs.find((href) => href.includes('link%23'))!;
    assert.ok(sourceHref.startsWith('../'));
    const linked = new URL(sourceHref, pathToFileURL(files.reportFile));
    assert.equal(linked.hash, '');
    assert.equal(linked.search, '');
    assert.equal(fileURLToPath(linked), sourceFile);
    assert.equal(readFileSync(linked, 'utf8'), readFileSync(sourceFile, 'utf8'));
    assert.ok(html.includes(literal.replaceAll('&', '&amp;')));
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderer сохраняет разные доли миллисекунды в HTML, analysis.json, деталях и CSV', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    save(join(root, 'logs.json'), {
      ok: true,
      data: [
        { record: { time: '2026-01-01T00:00:00.000100Z', value: 1 } },
        { record: { time: '2026-01-01T03:00:00.000200+03:00', value: 2 } },
      ],
    });
    save(join(root, 'matrix.json'), {
      ok: true,
      data: { resultType: 'matrix', result: [{ metric: {}, values: [[1000.123456, '3']] }] },
    });
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [
        { id: 'logs', responseFile: 'logs.json', ok: true },
        { id: 'matrix', responseFile: 'matrix.json', ok: true },
      ],
    });
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'UTC',
      panels: [
        {
          kind: 'line',
          response: 'logs',
          unit: 'none',
          format: 'logs-records',
          timeField: 'time',
          timeEncoding: 'rfc3339',
          valueField: 'value',
          groupFields: [],
        },
        { kind: 'line', response: 'matrix', format: 'prometheus-matrix', unit: 'none' },
      ],
    });
    const { stdout } = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]);
    const files = JSON.parse(stdout);
    assert.deepEqual(files.panelErrors, []);
    const payload = reportPayload(readFileSync(files.reportFile, 'utf8'));
    assert.deepEqual(payload.panels[0].series[0].points, [
      [1767225600000.1, 1],
      [1767225600000.2, 2],
    ]);
    const analysis = JSON.parse(readFileSync(files.analysisFile, 'utf8'));
    assert.equal(analysis.panels[0].objects[0].maxTime, 1767225600000.2);
    const csv = readFileSync(files.tableFiles[0], 'utf8');
    assert.match(csv, /2026-01-01T00:00:00\.0002Z/);
    assert.match(csv, /1970-01-01T00:16:40\.123456Z/);
    const detail = payload.panels[0].catalog[0].detailFile;
    const loaded: Array<{ points: unknown[] }> = [];
    runInNewContext(readFileSync(join(root, 'report', detail), 'utf8'), {
      reportLoad: (_key: string, value: { points: unknown[] }) => loaded.push(value),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(loaded[0]?.points)), payload.panels[0].series[0].points);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch отвергает HTTP groupFields до загрузки профиля, прямой renderer называет ошибку панели', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    const fields = ['requests', 'response_seconds', 'mean_s', 'max_s'];
    const panels = fields.map((field) => ({
      kind: 'table',
      response: 'http',
      format: 'logs-records',
      transform: 'http-summary',
      mapping: { groupFields: [field], countField: 'count', durationSumField: 'duration', maxField: 'max' },
    }));
    save(join(root, 'plan.json'), {
      version: 1,
      goal: 'Проверка mapping',
      requests: [{ id: 'http', why: 'Проверка', argv: ['logs', 'query', '--query', '*'] }],
    });
    for (let index = 0; index < panels.length; index += 1) {
      save(join(root, 'view.json'), { version: 1, timezone: 'UTC', panels: [panels[index]] });
      const result = await tt(
        [
          'batch',
          '--config',
          join(root, 'missing-config.json'),
          '--file',
          join(root, 'plan.json'),
          '--view',
          join(root, 'view.json'),
          '--out',
          join(root, `batch-${index}`),
          '--start',
          '-1h',
          '--end',
          'now',
        ],
        homeEnv(root),
      );
      assert.equal(result.code, 1);
      const body = JSON.parse(result.stdout);
      assert.equal(body.errorClass, 'bad_request');
      assert.match(body.error, /поле группы.*вычисляемым столбцом/);
      assert.ok(body.error.includes(fields[index]));
    }
    save(join(root, 'response.json'), { ok: true, data: [{ record: { count: 1, duration: 2, max: 2 } }] });
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [{ id: 'http', responseFile: 'response.json', ok: true }],
    });
    save(join(root, 'view.json'), { version: 1, timezone: 'UTC', panels });
    const result = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]).catch((error: { code: number; stdout: string }) => error);
    assert.equal('code' in result ? result.code : 0, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.panelErrors.length, 4);
    for (const error of body.panelErrors) assert.match(error.text, /поле группы.*вычисляемым столбцом/);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('ручной renderer строит журнал, взвешенную HTTP-таблицу и интервалы без сервера', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    save(join(root, 'response.json'), {
      ok: true,
      incomplete: false,
      data: [
        { record: { time: '2026-10-04T00:00:00+03:00', route: '/example', count: '2', duration: '10', max: '7' } },
        { record: { time: '2026-10-04T00:01:00+03:00', route: '/example', count: '1', duration: '8', max: '8' } },
      ],
    });
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [{ id: 'http', responseFile: 'response.json', ok: true }],
    });
    save(join(root, 'intervals.json'), [
      { begin: '2026-10-04T00:00:00+03:00', finish: '2026-10-04T00:02:00+03:00', name: 'Прогон' },
    ]);
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'Europe/Moscow',
      panels: [
        {
          kind: 'line',
          response: 'http',
          unit: 'none',
          format: 'logs-records',
          timeField: 'time',
          timeEncoding: 'rfc3339',
          valueField: 'count',
          groupFields: ['route'],
        },
        {
          kind: 'table',
          response: 'http',
          format: 'logs-records',
          transform: 'http-summary',
          mapping: { groupFields: ['route'], countField: 'count', durationSumField: 'duration', maxField: 'max' },
        },
        {
          kind: 'interval',
          format: 'rows-file',
          file: 'intervals.json',
          startField: 'begin',
          endField: 'finish',
          labelField: 'name',
          timeEncoding: 'rfc3339',
        },
      ],
    });
    const { stdout } = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]);
    const result = JSON.parse(stdout);
    assert.deepEqual(result.panelErrors, []);
    const html = readFileSync(result.reportFile, 'utf8');
    assert.ok(html.includes('Прогон'));
    assert.ok(html.includes('Europe/Moscow'));
    const tableFile = result.tableFiles.find((file: string) => file.includes('http-summary'));
    assert.ok(tableFile);
    const table = readFileSync(tableFile, 'utf8');
    assert.match(table, /\/example,3,18,6,8/);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('матрица с повторным временем и журнал без часового пояса называют ошибку', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    save(join(root, 'matrix.json'), {
      ok: true,
      data: {
        resultType: 'matrix',
        result: [
          {
            metric: { pod: 'example' },
            values: [
              [1, '2'],
              [1, '3'],
            ],
          },
        ],
      },
    });
    save(join(root, 'logs.json'), { ok: true, data: [{ record: { time: '2026-10-04T00:00:00', count: 1 } }] });
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [
        { id: 'cpu', responseFile: 'matrix.json', ok: true },
        { id: 'http', responseFile: 'logs.json', ok: true },
      ],
    });
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'UTC',
      panels: [
        { kind: 'line', response: 'cpu', format: 'prometheus-matrix', unit: 'none' },
        {
          kind: 'line',
          response: 'http',
          unit: 'none',
          format: 'logs-records',
          timeField: 'time',
          timeEncoding: 'rfc3339',
          valueField: 'count',
          groupFields: [],
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
    ]).catch((error: { code: number; stdout: string }) => error);
    assert.equal('code' in result ? result.code : 0, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.panelErrors.length, 2);
    assert.match(body.panelErrors[0].text, /повторяется время/);
    assert.match(body.panelErrors[1].text, /часового пояса/);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI renderer даёт компактный обзор, полный каталог и детали пика без изменения исходника', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    const values = Array.from({ length: 1201 }, (_, index) => [1000 + index, index === 701 ? '999' : '1']);
    const series = Array.from({ length: 800 }, (_, index) => ({
      metric: { namespace: 'fictional', pod: `worker-${index}` },
      values:
        index === 799
          ? values
          : [
              [1000, String(index % 10)],
              [2200, String(index % 10)],
            ],
    }));
    save(join(root, 'response.json'), { ok: true, data: { resultType: 'matrix', result: series } });
    const before = readFileSync(join(root, 'response.json'));
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [{ id: 'cpu', responseFile: 'response.json', ok: true }],
    });
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'UTC',
      panels: [{ kind: 'line', response: 'cpu', format: 'prometheus-matrix', unit: 'none' }],
    });
    const { stdout } = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]);
    const result = JSON.parse(stdout);
    const html = readFileSync(result.reportFile, 'utf8');
    const payload = reportPayload(html);
    const panel = payload.panels[0];
    assert.equal(panel.catalog.length, 800);
    assert.equal(panel.series.length, 10);
    assert.ok(Buffer.byteLength(html) <= 1048576);
    const catalogue = panel.catalog.find((row: { labels: { pod: string } }) => row.labels.pod === 'worker-799');
    assert.equal(catalogue.max, 999);
    assert.equal(catalogue.maxTime, 1701000);
    assert.equal(catalogue.count, 1201);
    const graph = panel.series.find((row: { id: string }) => row.id === catalogue.id);
    assert.ok(graph.points.some((pair: number[]) => pair[0] === 1701000 && pair[1] === 999));
    let detail: { points: unknown[] } | undefined;
    runInNewContext(readFileSync(join(root, 'report', catalogue.detailFile), 'utf8'), {
      globalThis: {
        reportLoad: (_key: string, value: { points: unknown[] }) => {
          detail = value;
        },
      },
    });
    assert.equal(detail?.points.length, 1201);
    assert.deepEqual(readFileSync(join(root, 'response.json')), before);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline не расходует лимит текущих лидеров, одинаковые метки не склеиваются', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    const response = {
      ok: true,
      data: {
        resultType: 'matrix',
        result: [
          { metric: { pod: 'same' }, values: [[1000.125, '2']] },
          { metric: { pod: 'same' }, values: [[1000.125, '3']] },
          { metric: { pod: 'unique' }, values: [[1000.125, '4']] },
        ],
      },
    };
    save(join(root, 'response.json'), response);
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [{ id: 'cpu', responseFile: 'response.json', ok: true }],
    });
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'UTC',
      panels: [{ kind: 'line', response: 'cpu', format: 'prometheus-matrix', unit: 'none' }],
    });
    const { stdout } = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--baseline',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]);
    const html = readFileSync(JSON.parse(stdout).reportFile, 'utf8');
    const payload = reportPayload(html);
    assert.equal(payload.panels[0].catalog.length, 6);
    assert.equal(payload.panels[0].series.length, 6);
    assert.equal(payload.panels[0].catalog.filter((row: { duplicate: boolean }) => row.duplicate).length, 4);
    assert.equal(payload.panels[0].unmatched, true);
    assert.deepEqual(payload.range, { min: 999125, max: 1001125 });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});

test('большой baseline кодируется без потери каталогов и исходных пиков', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-stand-report-'));
  try {
    const values = Array.from({ length: 1201 }, (_, index) => [
      2000 + index,
      index === 901 ? '777' : index % 2 ? '2.123456789' : '5.123456789',
    ]);
    save(join(root, 'response.json'), {
      ok: true,
      data: {
        resultType: 'matrix',
        result: Array.from({ length: 10 }, (_, index) => ({ metric: { pod: `fixture-${index}` }, values })),
      },
    });
    save(join(root, 'manifest.json'), {
      version: 1,
      requests: [{ id: 'cpu', responseFile: 'response.json', ok: true }],
    });
    save(join(root, 'view.json'), {
      version: 1,
      timezone: 'UTC',
      panels: Array.from({ length: 6 }, () => ({
        kind: 'line',
        response: 'cpu',
        format: 'prometheus-matrix',
        unit: 'none',
      })),
    });
    const { stdout } = await exec(process.execPath, [
      renderer,
      '--manifest',
      join(root, 'manifest.json'),
      '--baseline',
      join(root, 'manifest.json'),
      '--view',
      join(root, 'view.json'),
      '--out',
      join(root, 'report'),
    ]);
    const html = readFileSync(JSON.parse(stdout).reportFile, 'utf8');
    assert.ok(html.includes('"encoding":"gzip"'));
    assert.ok(Buffer.byteLength(html) <= 1048576);
    const payload = reportPayload(html);
    assert.equal(payload.baseline, true);
    assert.equal(payload.fullSeries, 120);
    assert.equal(payload.panels[0].catalog.length, 20);
    assert.equal(payload.panels[0].series.length, 20);
    assert.equal(payload.panels[0].catalog[0].max, 777);
    assert.equal(payload.panels[0].catalog[0].maxTime, 2901000);
    assert.ok(payload.panels[0].series[0].points.some((pair: number[]) => pair[0] === 2901000 && pair[1] === 777));
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'tt-stand-report-')));
    rmSync(root, { recursive: true, force: true });
  }
});
