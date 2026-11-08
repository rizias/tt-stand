import type { LogRecord } from './grafana.ts';
import { parseHttpRecord } from './http.ts';

export const UNKNOWN_ENVIRONMENT = 'unknown';

export const NAMESPACE_FIELD = 'kubernetes.pod_namespace';

export interface LabelledRecord {
  environment: string;
  environmentSource: 'upstream' | 'namespace' | null;
  environmentValue: string | null;
  record: LogRecord;
}

export interface LabellingSummary {
  byEnvironment: Record<string, number>;
  unknownCount: number;
  unknownValues: string[];
}

export function readField(record: LogRecord, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

export function readUpstream(record: LogRecord): string | null {
  return readField(record, 'upstream') ?? parseHttpRecord(record)?.upstream ?? null;
}

export function namespaceFromUpstream(upstream: string, namespaces: readonly string[]): string | null {
  if (/^https?:\/\//iu.test(upstream)) return null;

  let matched: string | null = null;
  for (const namespace of namespaces) {
    const matchesBoundary = upstream === namespace || upstream.startsWith(`${namespace}-`);
    if (namespace.length > 0 && matchesBoundary && (matched === null || namespace.length > matched.length)) {
      matched = namespace;
    }
  }
  return matched;
}

export function resolvedNamespace(record: LabelledRecord, namespaces: readonly string[]): string | null {
  if (record.environmentSource === 'namespace') return record.environment;
  return record.environmentSource === 'upstream'
    ? namespaceFromUpstream(record.environmentValue ?? '', namespaces)
    : null;
}

export function hasIngressUpstream(records: readonly LogRecord[]): boolean {
  return records.some((record) => readField(record, NAMESPACE_FIELD) === null && readUpstream(record) !== null);
}

export function labelRecord(record: LogRecord, namespaces: readonly string[]): LabelledRecord {
  const namespace = readField(record, NAMESPACE_FIELD);
  if (namespace !== null) {
    return {
      environment: namespace,
      environmentSource: 'namespace',
      environmentValue: namespace,
      record,
    };
  }

  const upstream = readUpstream(record);
  if (upstream !== null) {
    const environment = namespaceFromUpstream(upstream, namespaces);
    return {
      environment: environment ?? UNKNOWN_ENVIRONMENT,
      environmentSource: 'upstream',
      environmentValue: upstream,
      record,
    };
  }

  return {
    environment: UNKNOWN_ENVIRONMENT,
    environmentSource: null,
    environmentValue: null,
    record,
  };
}

export function summarizeLabelled(
  labelled: readonly LabelledRecord[],
  namespaces: readonly string[] = [],
): LabellingSummary {
  const counts = new Map<string, number>();
  const unknownValues = new Set<string>();
  let unknownCount = 0;

  for (const item of labelled) {
    counts.set(item.environment, (counts.get(item.environment) ?? 0) + 1);
    if (resolvedNamespace(item, namespaces) === null) {
      unknownCount += 1;
      unknownValues.add(item.environmentValue ?? '(полей окружения в записи нет)');
    }
  }

  return {
    byEnvironment: Object.fromEntries(counts),
    unknownCount,
    unknownValues: [...unknownValues],
  };
}

export function labelRecords(
  records: LogRecord[],
  namespaces: readonly string[],
): { labelled: LabelledRecord[]; summary: LabellingSummary } {
  const labelled = records.map((record) => labelRecord(record, namespaces));
  return { labelled, summary: summarizeLabelled(labelled, namespaces) };
}
