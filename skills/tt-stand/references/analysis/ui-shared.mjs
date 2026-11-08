export const payload = await readPayload();
export const app = document.getElementById('app');
export const focusHandlers = new Map();
const fullDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: payload?.timezone ?? 'UTC',
  dateStyle: 'short',
  timeStyle: 'medium',
});
const shortDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: payload?.timezone ?? 'UTC',
  hour: '2-digit',
  minute: '2-digit',
});
const dayDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: payload?.timezone ?? 'UTC',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const axisNumbers = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const COLORS = [
  '#3673c6',
  '#d16a26',
  '#368e64',
  '#985ab8',
  '#bd4e62',
  '#8e821b',
  '#328f99',
  '#93674d',
  '#485bad',
  '#aa5d89',
];

async function readPayload() {
  try {
    let value = JSON.parse(document.getElementById('report-data').textContent);
    if (value.encoding === 'gzip') {
      if (typeof DecompressionStream !== 'function') throw new Error('Нужен браузер с DecompressionStream для gzip.');
      const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      value = JSON.parse(await new Response(stream).text());
    }
    if (!value || !Array.isArray(value.panels)) throw new Error('Повреждена модель отчёта.');
    return value;
  } catch (error) {
    const main = document.getElementById('app');
    main.replaceChildren(
      node('h1', 'Отчёт не открыт'),
      node('p', `${error.message} Распаковка использует DecompressionStream('gzip').`, 'bad'),
    );
    document.getElementById('report-links').hidden = false;
    return null;
  }
}

export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function note(text) {
  return node('p', text, 'note');
}
export function heading(tag, text) {
  return node(tag, text);
}
export function colorFor(index) {
  return COLORS[index % COLORS.length];
}
export function datasetName(dataset) {
  return dataset === 'baseline' ? 'базовый' : 'текущий';
}
export function formatUtc(ms) {
  return Number.isFinite(ms) ? fullDate.format(ms) : 'нет времени';
}
export function shortUtc(ms, span) {
  return (span >= 86400000 ? dayDate : shortDate).format(ms);
}
export function formatNumber(value) {
  return metricValue(value);
}
export function axisNumber(value) {
  if (value !== 0 && Math.abs(value) < 0.01) return value.toExponential(2);
  return axisNumbers.format(value);
}
export function formatCell(value) {
  if (value === null || value === undefined) return 'нет значения';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function shortLabel(text, length = 46) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
export function fromWire(item) {
  return { ...item, points: item.points.map((pair) => ({ t: pair[0], v: pair[1] })) };
}

export function warningBox(panel) {
  const box = node('div', undefined, 'warnings');
  for (const text of panel.messages ?? []) box.append(node('p', text, 'warn'));
  return box;
}

export function link(file, text) {
  const element = node('a', text);
  element.href = file;
  return element;
}

export function button(text, action) {
  const element = node('button', text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

export function updateFocus(time) {
  for (const [svg, handler] of focusHandlers) {
    if (svg.isConnected) handler(time);
    else focusHandlers.delete(svg);
  }
}

const received = new Map();
const pending = new Map();
globalThis.reportLoad = (key, value) => {
  received.set(key, value);
  const waiter = pending.get(key);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(value);
    pending.delete(key);
  }
};

export function loadDetail(key, file) {
  if (received.has(key)) return Promise.resolve(received.get(key));
  if (pending.has(key)) return pending.get(key).promise;
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const script = node('script');
  const fail = (message) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
    script.remove();
    reject(new Error(message));
  };
  const timer = setTimeout(() => fail(`Детализация не загрузилась за 15 с: ${file}`), 15000);
  pending.set(key, { promise, resolve, reject, timer });
  script.src = file;
  script.onerror = () => fail(`Не удалось загрузить детализацию: ${file}`);
  script.onload = () => {
    if (!received.has(key)) fail(`Файл детализации не вернул данные: ${file}`);
  };
  document.head.append(script);
  return promise;
}
