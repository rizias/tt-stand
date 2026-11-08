export function grafanaOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function grafanaQuery(echo) {
  if (!echo?.datasourceUid || !echo.datasourceType || typeof echo.query !== 'string') return null;
  const query = {
    refId: 'A',
    datasource: { uid: echo.datasourceUid, type: echo.datasourceType },
    expr: echo.query,
    editorMode: 'code',
  };
  if (
    ['prometheus', 'victoriametrics-datasource', 'victoriametrics-metrics-datasource'].includes(echo.datasourceType)
  ) {
    return { ...query, range: true, instant: false, ...(echo.step ? { interval: echo.step } : {}) };
  }
  if (echo.datasourceType === 'victoriametrics-logs-datasource') return { ...query, queryType: 'instant' };
  return null;
}

export function grafanaLink(source, range) {
  const base = grafanaOrigin(source?.baseUrl);
  if (!base || !source.queryModel || !range) return null;
  const url = new URL(`${base}/explore`);
  url.searchParams.set('schemaVersion', '1');
  url.searchParams.set(
    'panes',
    JSON.stringify({
      report: {
        datasource: source.queryModel.datasource.uid,
        queries: [source.queryModel],
        range: { from: String(range.min), to: String(range.max) },
      },
    }),
  );
  if (Number.isSafeInteger(source.orgId) && source.orgId > 0) url.searchParams.set('orgId', String(source.orgId));
  return url.href;
}
