const METRIC_UNITS = {
  none: '',
  '%': '%',
  cores: 'ядра CPU',
  seconds: 'с',
  'MiB/s': 'МиБ/с',
  'requests/min': 'запр./мин',
  'errors/min': 'ош./мин',
  bytes: 'байт',
};

export function metricUnit(unit) {
  return Object.hasOwn(METRIC_UNITS, unit) ? METRIC_UNITS[unit] : (unit ?? '');
}

export function metricValue(value, unit = '') {
  if (!Number.isFinite(value)) return 'нет данных';
  const text =
    value !== 0 && Math.abs(value) < 0.01
      ? value.toExponential(2)
      : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
  const suffix = metricUnit(unit);
  return suffix ? `${text} ${suffix}` : text;
}
