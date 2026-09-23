import { matchesScope, type NamespaceScope } from './scope.ts';

export interface SeriesFilterResult {
  data: unknown;
  outOfScope: number;
  withoutNamespace: number;
  shapeHidden: boolean;
}

function filterLabelled(
  items: unknown[],
  scope: NamespaceScope,
  labelsOf: (item: Record<string, unknown>) => Record<string, unknown> | undefined,
): { kept: unknown[]; outOfScope: number; withoutNamespace: number; shapeHidden: number } {
  let outOfScope = 0;
  let withoutNamespace = 0;
  let shapeHidden = 0;
  const kept = items.filter((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      shapeHidden += 1;
      return false;
    }
    const namespace = labelsOf(item as Record<string, unknown>)?.namespace;
    if (typeof namespace !== 'string') {
      withoutNamespace += 1;
      return false;
    }
    if (!matchesScope(namespace, scope)) {
      outOfScope += 1;
      return false;
    }
    return true;
  });
  return { kept, outOfScope, withoutNamespace, shapeHidden };
}

export function filterMatrixOrVector(data: unknown, scope: NamespaceScope): SeriesFilterResult {
  if (scope === null) return { data, outOfScope: 0, withoutNamespace: 0, shapeHidden: false };
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { data: null, outOfScope: 0, withoutNamespace: 0, shapeHidden: true };
  }
  const shape = data as { resultType?: string; result?: unknown; [key: string]: unknown };
  const extraFields = Object.keys(shape).some((key) => key !== 'resultType' && key !== 'result');
  if (shape.resultType === 'scalar' || shape.resultType === 'string') {
    return {
      data: { resultType: shape.resultType, result: null },
      outOfScope: 0,
      withoutNamespace: 1,
      shapeHidden: extraFields,
    };
  }
  if ((shape.resultType !== 'matrix' && shape.resultType !== 'vector') || !Array.isArray(shape.result)) {
    return { data: null, outOfScope: 0, withoutNamespace: 0, shapeHidden: true };
  }
  const { kept, outOfScope, withoutNamespace, shapeHidden } = filterLabelled(
    shape.result,
    scope,
    (item) => (item as { metric?: Record<string, unknown> }).metric,
  );
  return {
    data: { resultType: shape.resultType, result: kept },
    outOfScope,
    withoutNamespace,
    shapeHidden: shapeHidden > 0 || extraFields,
  };
}

function filterSeriesItems(
  items: unknown[],
  scope: NamespaceScope,
): { kept: unknown[]; outOfScope: number; withoutNamespace: number; shapeHidden: number } {
  let outOfScope = 0;
  let withoutNamespace = 0;
  let shapeHidden = 0;
  const kept = items.filter((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      shapeHidden += 1;
      return false;
    }
    const namespace = (item as Record<string, unknown>).namespace;
    if (typeof namespace !== 'string') {
      withoutNamespace += 1;
      return false;
    }
    if (!matchesScope(namespace, scope)) {
      outOfScope += 1;
      return false;
    }
    return true;
  });
  return { kept, outOfScope, withoutNamespace, shapeHidden };
}

export function filterSeriesList(data: unknown, scope: NamespaceScope): SeriesFilterResult {
  if (scope === null) return { data, outOfScope: 0, withoutNamespace: 0, shapeHidden: false };
  if (!Array.isArray(data)) {
    return { data: null, outOfScope: 0, withoutNamespace: 0, shapeHidden: true };
  }
  const { kept, outOfScope, withoutNamespace, shapeHidden } = filterSeriesItems(data, scope);
  return { data: kept, outOfScope, withoutNamespace, shapeHidden: shapeHidden > 0 };
}

export interface ValuesFilterResult {
  data: unknown;
  outOfScope: number;
  shapeHidden: boolean;
}

export function filterNamespaceValues(data: unknown, scope: NamespaceScope): ValuesFilterResult {
  if (scope === null) return { data, outOfScope: 0, shapeHidden: false };
  if (!Array.isArray(data)) return { data: null, outOfScope: 0, shapeHidden: true };
  let outOfScope = 0;
  let shapeHidden = 0;
  const kept = data.filter((item) => {
    if (typeof item !== 'string') {
      shapeHidden += 1;
      return false;
    }
    if (!matchesScope(item, scope)) {
      outOfScope += 1;
      return false;
    }
    return true;
  });
  return { data: kept, outOfScope, shapeHidden: shapeHidden > 0 };
}

export interface HiddenValuesResult {
  data: unknown;
  hidden: number;
  shapeHidden: boolean;
}

export function hideOtherLabelValues(data: unknown, scope: NamespaceScope): HiddenValuesResult {
  if (scope === null) return { data, hidden: 0, shapeHidden: false };
  if (!Array.isArray(data)) return { data: null, hidden: 0, shapeHidden: true };
  return { data: [], hidden: data.length, shapeHidden: false };
}
