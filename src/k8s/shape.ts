import { ECHO_CONSTANTS, type Echo } from '../response.ts';

export function baseEcho(command: string): Echo {
  return {
    command,
    query: null,
    request: null,
    start: null,
    end: null,
    limit: null,
    limitNote: ECHO_CONSTANTS.noLimit,
    datasource: null,
    datasourceNote: null,
    recordsReturned: 0,
    hitLimit: false,
    unparsableLines: 0,
    order: ECHO_CONSTANTS.order,
    unavailableSources: [],
    valueVariantsGenerated: ECHO_CONSTANTS.valueVariants,
    identifierPivotPerformed: ECHO_CONSTANTS.identifierPivot,
  };
}

export function itemCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 1;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : 1;
}

export function summarizePods(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.map((pod) => {
    const object = pod as {
      metadata?: Record<string, unknown>;
      spec?: Record<string, unknown[]>;
      status?: Record<string, unknown> & Record<string, unknown[]>;
    };
    const specContainers = [
      ...(object.spec?.initContainers ?? []).map((item: unknown) => ({ type: 'init', item })),
      ...(object.spec?.containers ?? []).map((item: unknown) => ({ type: 'container', item })),
      ...(object.spec?.ephemeralContainers ?? []).map((item: unknown) => ({
        type: 'ephemeral',
        item,
      })),
    ];
    const statuses = [
      ...(object.status?.initContainerStatuses ?? []),
      ...(object.status?.containerStatuses ?? []),
      ...(object.status?.ephemeralContainerStatuses ?? []),
    ] as Array<Record<string, unknown>>;
    const containers = specContainers.map(({ type, item }) => {
      const container = item as Record<string, unknown>;
      const status = statuses.find((candidate) => candidate.name === container.name);
      return {
        type,
        name: container.name ?? null,
        image: container.image ?? null,
        restartCount: status?.restartCount ?? 0,
        imageId: status?.imageID ?? null,
      };
    });
    return {
      name: object.metadata?.name ?? null,
      namespace: object.metadata?.namespace ?? null,
      restartCount: statuses.reduce(
        (sum, status) => sum + (typeof status.restartCount === 'number' ? status.restartCount : 0),
        0,
      ),
      startTime: object.status?.startTime ?? null,
      images: specContainers.map(({ item }) => (item as Record<string, unknown>).image ?? null),
      containers,
      pod,
    };
  });
}

interface DeployRevision {
  revision: string | null;
  createdAt: string | null;
  images: string[];
  replicas: number;
  name: string;
  replicaSet: unknown;
}

export function buildHistory(raw: unknown, workloadUid: string): DeployRevision[] {
  const items = (raw as { items?: unknown[] })?.items ?? [];
  const own = items.filter((item) => {
    const owners =
      (
        item as {
          metadata?: {
            ownerReferences?: Array<{ kind?: string; uid?: string; controller?: boolean }>;
          };
        }
      )?.metadata?.ownerReferences ?? [];
    return owners.some(
      (owner) => owner?.kind === 'Deployment' && owner?.uid === workloadUid && owner?.controller,
    );
  });
  return own
    .map((item) => {
      const meta = (item as { metadata?: Record<string, unknown> }).metadata ?? {};
      const annotations = (meta.annotations ?? {}) as Record<string, string>;
      const spec = (item as { spec?: Record<string, unknown> }).spec ?? {};
      const containers =
        (spec.template as { spec?: { containers?: Array<{ image?: string }> } })?.spec
          ?.containers ?? [];
      return {
        revision: annotations['deployment.kubernetes.io/revision'] ?? null,
        createdAt: (meta.creationTimestamp as string) ?? null,
        images: containers.map((container) => String(container.image ?? '')),
        replicas: Number(spec.replicas ?? 0),
        name: String(meta.name ?? ''),
        replicaSet: item,
      };
    })
    .sort((a, b) => Number(a.revision ?? 0) - Number(b.revision ?? 0));
}
