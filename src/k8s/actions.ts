import { ToolError } from '../errors.ts';
import { resolveResource, resourcePath } from './discovery.ts';
import { classifyK8sError, type K8sCommand } from './errors.ts';
import type { K8sSessionLike } from './session.ts';
import { buildHistory, itemCount, summarizePods } from './shape.ts';

export type NamespaceGuard = (namespace: string) => void;

export interface ActionOutcome {
  data: unknown;
  summary: Record<string, unknown>;
  echoPatch: Record<string, unknown>;
  historyEmpty: boolean;
  unreadable: string[];
}

async function runGet(
  session: K8sSessionLike,
  command: Extract<K8sCommand, { action: 'get' }>,
  guard: NamespaceGuard,
): Promise<ActionOutcome> {
  const resolved = await resolveResource(session, command.resource);
  if (!resolved.resource.namespaced && command.namespace !== null) {
    throw new ToolError(
      'bad_request',
      `Ресурс ${resolved.resource.name} является кластерным: --namespace к нему неприменим.`,
    );
  }
  const namespace = resolved.resource.namespaced
    ? (command.namespace ?? session.metadata.defaultNamespace)
    : null;
  if (namespace !== null) guard(namespace);
  const data = await session.getJson(resourcePath(resolved.resource, namespace, command.name));
  const qualified = resolved.resource.group
    ? `${resolved.resource.name}.${resolved.resource.group}`
    : resolved.resource.name;

  return {
    data,
    summary: { resource: qualified, itemCount: itemCount(data) },
    echoPatch: {
      request: session.lastRequest,
      namespace,
      resource: qualified,
      requestedResource: command.resource,
      name: command.name,
      discoveryCandidates: resolved.candidates.map((resource) =>
        resource.group ? `${resource.name}.${resource.group}` : resource.name,
      ),
      resourceVersion: resolved.resource.groupVersion,
      discoveryVersions: resolved.candidates
        .filter((resource) => resource.name === resolved.resource.name)
        .map((resource) => resource.groupVersion),
    },
    historyEmpty: false,
    unreadable: resolved.unreadable,
  };
}

async function runLog(
  session: K8sSessionLike,
  command: Extract<K8sCommand, { action: 'log' }>,
  guard: NamespaceGuard,
): Promise<ActionOutcome> {
  const namespace = command.namespace ?? session.metadata.defaultNamespace;
  guard(namespace);
  const params = new URLSearchParams();
  if (command.container !== null) params.set('container', command.container);
  if (command.previous) params.set('previous', 'true');
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(command.pod)}/log${suffix}`;

  let log: string;
  try {
    log = await session.getText(path);
  } catch (cause) {
    throw classifyK8sError(cause, { podName: command.pod, previous: command.previous });
  }

  return {
    data: {
      pod: command.pod,
      namespace,
      container: command.container,
      previous: command.previous,
      log,
    },
    summary: { logAvailable: true, previous: command.previous },
    echoPatch: {
      request: session.lastRequest,
      namespace,
      resource: 'pods/log',
      name: command.pod,
      container: command.container,
      previous: command.previous,
    },
    historyEmpty: false,
    unreadable: [],
  };
}

async function workloadUid(
  session: K8sSessionLike,
  namespace: string,
  workload: string,
): Promise<string> {
  const resource = await resolveResource(session, 'deployments');
  try {
    const object = (await session.getJson(
      resourcePath(resource.resource, namespace, workload),
    )) as {
      metadata?: { uid?: string };
    };
    return String(object.metadata?.uid ?? '');
  } catch (cause) {
    throw classifyK8sError(cause, {});
  }
}

async function runHistory(
  session: K8sSessionLike,
  command: Extract<K8sCommand, { action: 'history' }>,
  guard: NamespaceGuard,
): Promise<ActionOutcome> {
  const namespace = command.namespace ?? session.metadata.defaultNamespace;
  guard(namespace);
  const uid = await workloadUid(session, namespace, command.workload);
  const resolved = await resolveResource(session, 'replicasets');
  const raw = await session.getJson(resourcePath(resolved.resource, namespace, null));
  const revisions = buildHistory(raw, uid);

  const imageChanges = revisions
    .map((revision, index) =>
      index === 0 ||
      JSON.stringify(revision.images) !== JSON.stringify(revisions[index - 1]?.images)
        ? { revision: revision.revision, createdAt: revision.createdAt, images: revision.images }
        : null,
    )
    .filter(Boolean);

  return {
    data: revisions,
    summary: { workload: command.workload, revisionCount: revisions.length, imageChanges },
    echoPatch: {
      request: session.lastRequest,
      namespace,
      resource: 'replicasets',
      name: command.workload,
      order: 'ревизии упорядочены по номеру ревизии на стороне инструмента',
    },
    historyEmpty: revisions.length === 0,
    unreadable: resolved.unreadable,
  };
}

async function runList(
  session: K8sSessionLike,
  command: Extract<K8sCommand, { action: 'events' | 'pods' }>,
  guard: NamespaceGuard,
): Promise<ActionOutcome> {
  const namespace = command.namespace ?? session.metadata.defaultNamespace;
  guard(namespace);
  const resourceName = command.action === 'events' ? 'events' : 'pods';
  const resolved = await resolveResource(session, resourceName);
  const raw = await session.getJson(resourcePath(resolved.resource, namespace, null));

  return {
    data: command.action === 'pods' ? summarizePods(raw) : raw,
    summary: { itemCount: itemCount(raw) },
    echoPatch: { request: session.lastRequest, namespace, resource: resourceName },
    historyEmpty: false,
    unreadable: resolved.unreadable,
  };
}

export async function runAction(
  session: K8sSessionLike,
  command: K8sCommand,
  guard: NamespaceGuard,
): Promise<ActionOutcome> {
  if (command.action === 'get') return await runGet(session, command, guard);
  if (command.action === 'log') return await runLog(session, command, guard);
  if (command.action === 'history') return await runHistory(session, command, guard);
  return await runList(session, command, guard);
}
