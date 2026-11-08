import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseTime } from '../skills/tt-stand/references/analysis/time-values.mjs';
import { logSeries, matrixSeries } from '../skills/tt-stand/references/analysis/response-data.mjs';
import {
  describeSeries,
  httpSummary,
  seriesCsv,
  tableFromRecords,
} from '../skills/tt-stand/references/analysis/tables.mjs';
import { metricUnit, metricValue } from '../skills/tt-stand/references/analysis/metric-format.mjs';

test('неизвестные единицы сохраняются буквально, включая имена свойств прототипа', () => {
  for (const unit of ['requests/s', 'constructor', '__proto__', 'toString']) {
    assert.equal(metricUnit(unit), unit);
    assert.equal(metricValue(5, unit), `5 ${unit}`);
  }
  assert.equal(metricUnit('none'), '');
  assert.equal(metricValue(5, 'none'), '5');
  assert.equal(metricValue(5, 'cores'), '5 ядра CPU');
  assert.equal(metricValue(5), '5');
});

test('RFC3339 сохраняет доступные дроби миллисекунды, смещения и время до эпохи', () => {
  const cases = [
    ['2026-01-01T00:00:00.000100Z', 1767225600000.1],
    ['2026-01-01T00:00:00.000200Z', 1767225600000.2],
    ['2026-01-01T03:00:00.123456+03:00', 1767225600123.456],
    ['2025-12-31T21:00:00.123456-03:00', 1767225600123.456],
    ['1970-01-01T00:00:00.0000001Z', 0.0001],
    ['1969-12-31T23:59:59.9999999Z', -0.0001],
    ['1970-01-01T03:00:00.000100+03:00', 0.1],
    ['1969-12-31T20:59:59.999900-03:00', -0.1],
  ];
  for (const [input, ms] of cases) assert.deepEqual(parseTime(input, 'rfc3339'), { ok: true, ms });
  assert.equal(parseTime('2026-01-01T24:00:00.1Z', 'rfc3339').ok, false);
  const result = logSeries(
    [
      { time: cases[0]![0], value: 1 },
      { time: cases[1]![0], value: 2 },
    ],
    { timeField: 'time', timeEncoding: 'rfc3339', valueField: 'value', groupFields: [] },
    'current',
    'fractional',
  );
  assert.ok(!('error' in result));
  assert.ok(result.series[0]);
  assert.deepEqual(result.series[0].points, [
    { t: 1767225600000.1, v: 1 },
    { t: 1767225600000.2, v: 2 },
  ]);
});

test('RFC3339 отклоняет невозможные даты и часы до нормализации календаря', () => {
  for (const date of ['2026-02-30', '2025-02-29', '2026-04-31', '2026-00-01', '2026-13-01']) {
    for (const suffix of ['T00:00:00Z', 't03:00:00.123456+03:00']) {
      assert.equal(parseTime(`${date}${suffix}`, 'rfc3339').ok, false, `${date}${suffix}`);
    }
  }
  assert.equal(parseTime('2026-01-01T24:00:00Z', 'rfc3339').ok, false);
  for (const date of ['2024-02-29', '2000-02-29', '0000-02-29', '2026-04-30']) {
    const value = `${date}T00:00:00Z`;
    assert.deepEqual(parseTime(value, 'rfc3339'), { ok: true, ms: Date.parse(value) });
  }
});

test('среднее конечных точек сохраняется при больших и противоположных значениях', () => {
  const cases = [
    { values: [1e308, 1e308], mean: 1e308 },
    { values: [Number.MAX_VALUE, Number.MAX_VALUE], mean: Number.MAX_VALUE },
    { values: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], mean: Number.MAX_VALUE },
    { values: [Number.MAX_VALUE, -Number.MAX_VALUE], mean: 0 },
    { values: [-Number.MAX_VALUE, Number.MAX_VALUE], mean: 0 },
    { values: [-Number.MAX_VALUE, -Number.MAX_VALUE], mean: -Number.MAX_VALUE },
    { values: [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE], mean: Number.MAX_VALUE / 3 },
    { values: [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE], mean: 0 },
    { values: [Number.MIN_VALUE, Number.MIN_VALUE], mean: Number.MIN_VALUE },
    { values: [Number.MIN_VALUE, 0], mean: 0 },
    { values: [0, Number.MIN_VALUE], mean: 0 },
    { values: [3 * Number.MIN_VALUE, 0], mean: 2 * Number.MIN_VALUE },
    { values: [0, 3 * Number.MIN_VALUE], mean: 2 * Number.MIN_VALUE },
    { values: [-3 * Number.MIN_VALUE, 0], mean: -2 * Number.MIN_VALUE },
    { values: [1, 2, 3, 4], mean: 2.5 },
    { values: [1, NaN, Infinity, 3], mean: 2 },
  ];
  for (const { values, mean } of cases) {
    const series = { points: values.map((value, index) => ({ t: index * 1000, v: value })) };
    assert.equal(describeSeries(series).meanOfObservedPoints, mean);
    assert.ok(seriesCsv([series]).includes(`,${mean}\n`));
  }
});

test('среднее сохраняет малый остаток после переполнения и округляет к ближайшему чётному', () => {
  const cancellation = [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];
  const cases = [
    { values: [...cancellation, 1e-308], mean: 1e-308 / 5 },
    { values: [...cancellation, -1e-308], mean: -1e-308 / 5 },
    { values: [1e-308, ...cancellation], mean: 1e-308 / 5 },
    { values: [Number.MAX_VALUE, 1e-308, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE], mean: 1e-308 / 5 },
    { values: [...cancellation.map((value) => -value), -1e-308], mean: -1e-308 / 5 },
    { values: [...cancellation, 3 * Number.MIN_VALUE, 0], mean: 0 },
    { values: [...cancellation, -3 * Number.MIN_VALUE, 0], mean: -0 },
    { values: [...cancellation, 9 * Number.MIN_VALUE, 0], mean: 2 * Number.MIN_VALUE },
    { values: [...cancellation, -9 * Number.MIN_VALUE, 0], mean: -2 * Number.MIN_VALUE },
    { values: [...cancellation, 15 * Number.MIN_VALUE, 0], mean: 2 * Number.MIN_VALUE },
    { values: [...cancellation, 8, 2 ** -50, 0, 0], mean: 1 },
    { values: [...cancellation, 8, 3 * 2 ** -50, 0, 0], mean: 1 + 2 * Number.EPSILON },
    { values: [...cancellation, -8, -(3 * 2 ** -50), 0, 0], mean: -1 - 2 * Number.EPSILON },
  ];
  for (const { values, mean } of cases) {
    const series = { points: values.map((value, index) => ({ t: index * 1000, v: value })) };
    assert.equal(describeSeries(series).meanOfObservedPoints, mean, values.join(', '));
    assert.ok(seriesCsv([series]).includes(`,${mean}\n`));
  }
});

test('HTTP-статистика сообщает о переполнении суммы и среднего', () => {
  const cases = [
    [
      { count: 1, duration: 1e308 },
      { count: 1, duration: 1e308 },
    ],
    [
      { count: 1e308, duration: 1 },
      { count: 1e308, duration: 1 },
    ],
    [{ count: 1e-308, duration: 1e308 }],
  ];
  for (const records of cases) {
    const result = httpSummary(
      records.map((record) => ({ ...record, maximum: 1 })),
      {
        groupFields: [],
        countField: 'count',
        durationSumField: 'duration',
        maxField: 'maximum',
      },
    );
    assert.ok('error' in result);
    assert.match(result.error, /переполнение/i);
  }
});

test('CSV сохраняет дробное время без ложных цифр при десятичной и экспоненциальной записи', () => {
  const cases = [
    [1000.123456, 1000123.456, '1970-01-01T00:16:40.123456Z'],
    [-1000.123456, -1000123.456, '1969-12-31T23:43:19.876544Z'],
    [1.001, 1001, '1970-01-01T00:00:01.001Z'],
    [-1.001, -1001, '1969-12-31T23:59:58.999Z'],
    ['1e-10', 1e-7, '1970-01-01T00:00:00.0000000001Z'],
    ['-1e-10', -1e-7, '1969-12-31T23:59:59.9999999999Z'],
    [0, 0, '1970-01-01T00:00:00.000Z'],
  ];
  for (const [seconds, milliseconds, iso] of cases) {
    const result = matrixSeries(
      { resultType: 'matrix', result: [{ metric: {}, values: [[seconds, '2']] }] },
      'current',
      'fractional',
    );
    assert.ok('series' in result);
    assert.ok(result.series[0]);
    assert.equal(result.series[0].points[0].t, milliseconds);
    assert.ok(seriesCsv(result.series).includes(`,${iso},`));
    assert.deepEqual(parseTime(iso, 'rfc3339'), { ok: true, ms: milliseconds });
  }
});

test('HTTP mapping явно отвергает пересечение группы с вычисляемыми столбцами', () => {
  for (const field of ['requests', 'response_seconds', 'mean_s', 'max_s']) {
    const result = httpSummary([{ [field]: 'route-a', count: 1, duration: 2, maximum: 2 }], {
      groupFields: [field],
      countField: 'count',
      durationSumField: 'duration',
      maxField: 'maximum',
    });
    assert.ok('error' in result);
    assert.match(result.error, /поле группы.*вычисляемым столбцом/);
    assert.ok(result.error.includes(field));
  }
});

test('собственные __proto__ и constructor сохраняются в таблице, HTTP-группах и метках логов', () => {
  const records = JSON.parse(
    '[{"__proto__":"a","constructor":"first","time":1,"value":1,"duration":2,"max":2},' +
      '{"__proto__":"b","constructor":"second","time":1,"value":2,"duration":3,"max":3}]',
  );
  const table = tableFromRecords(records, ['__proto__', 'constructor']);
  assert.deepEqual(table.rows, [
    { ['__proto__']: 'a', constructor: 'first' },
    { ['__proto__']: 'b', constructor: 'second' },
  ]);
  const summary = httpSummary(records, {
    groupFields: ['__proto__'],
    countField: 'value',
    durationSumField: 'duration',
    maxField: 'max',
  });
  assert.ok('rows' in summary);
  assert.ok(summary.rows);
  assert.deepEqual(summary.rows, [
    { ['__proto__']: 'a', requests: 1, response_seconds: 2, mean_s: 2, max_s: 2 },
    { ['__proto__']: 'b', requests: 2, response_seconds: 3, mean_s: 1.5, max_s: 3 },
  ]);
  const result = logSeries(
    records,
    { timeField: 'time', timeEncoding: 'unixSeconds', valueField: 'value', groupFields: ['__proto__'] },
    'current',
    'literal',
  );
  assert.ok(!('error' in result));
  assert.deepEqual(
    result.series.map((series: { labels: object }) => series.labels),
    [{ ['__proto__']: 'a' }, { ['__proto__']: 'b' }],
  );
  assert.equal(Object.getPrototypeOf(table.rows[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(summary.rows[0]), Object.prototype);
  assert.ok(result.series[0]);
  assert.equal(Object.getPrototypeOf(result.series[0].labels), Object.prototype);
});
