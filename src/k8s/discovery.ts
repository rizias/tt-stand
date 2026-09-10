import { ToolError } from '../errors.ts';
import type { K8sSessionLike } from './session.ts';

interface ApiResource {
  name: string;
  singularName?: string;
  namespaced: boolean;
  kind: string;
  shortNames?: string[];
  verbs?: string[];
}

interface DiscoveredResource extends ApiResource {
  group: string;
  version: string;
  groupVersion: string;
  preferred: boolean;
}

export interface Discovery {
  resources: DiscoveredResource[];
  unreadable: string[];
}

interface ApiResourceList {
  groupVersion?: string;
  resources?: ApiResource[];
}

function resourceList(value: unknown): ApiResourceList {
  return typeof value === 'object' && value !== null ? (value as ApiResourceList) : {};
}

function splitGroupVersion(groupVersion: string): { group: string; version: string } {
  const slash = groupVersion.indexOf('/');
  return slash === -1
    ? { group: '', version: groupVersion }
    : { group: groupVersion.slice(0, slash), version: groupVersion.slice(slash + 1) };
}

function topLevel(list: ApiResourceList): ApiResource[] {
  return (list.resources ?? []).filter((resource) => !resource.name.includes('/'));
}

async function coreResources(session: K8sSessionLike, into: Discovery): Promise<void> {
  const core = (await session.getJson('/api')) as { versions?: string[] };
  const versions = core.versions ?? [];
  for (const version of versions) {
    let list: ApiResourceList;
    try {
      list = resourceList(await session.getJson(`/api/${encodeURIComponent(version)}`));
    } catch (cause) {
      into.unreadable.push(`${version}: ${(cause as Error).message}`);
      continue;
    }
    for (const resource of topLevel(list)) {
      into.resources.push({
        ...resource,
        group: '',
        version,
        groupVersion: version,
        preferred: version === versions[0],
      });
    }
  }
}

async function groupVersionResources(
  session: K8sSessionLike,
  groupVersion: string,
  preferred: boolean,
  into: Discovery,
): Promise<void> {
  let list: ApiResourceList;
  try {
    list = resourceList(
      await session.getJson(`/apis/${groupVersion.split('/').map(encodeURIComponent).join('/')}`),
    );
  } catch (cause) {
    into.unreadable.push(`${groupVersion}: ${(cause as Error).message}`);
    return;
  }
  const parts = splitGroupVersion(groupVersion);
  for (const resource of topLevel(list)) {
    into.resources.push({ ...resource, ...parts, groupVersion, preferred });
  }
}

async function groupedResources(session: K8sSessionLike, into: Discovery): Promise<void> {
  const groups = (await session.getJson('/apis')) as {
    groups?: Array<{
      preferredVersion?: { groupVersion?: string };
      versions?: Array<{ groupVersion?: string }>;
    }>;
  };
  const advertised = (groups.groups ?? []).flatMap((item) => {
    const preferredVersion = item.preferredVersion?.groupVersion;
    return [preferredVersion, ...(item.versions ?? []).map((version) => version.groupVersion)]
      .filter((groupVersion): groupVersion is string => Boolean(groupVersion))
      .map((groupVersion) => ({ groupVersion, preferred: groupVersion === preferredVersion }));
  });

  const seen = new Set<string>();
  for (const { groupVersion, preferred } of advertised) {
    if (seen.has(groupVersion)) continue;
    seen.add(groupVersion);
    await groupVersionResources(session, groupVersion, preferred, into);
  }
}

async function discover(session: K8sSessionLike): Promise<Discovery> {
  const result: Discovery = { resources: [], unreadable: [] };
  await coreResources(session, result);
  await groupedResources(session, result);
  return result;
}

function resourceNames(resource: DiscoveredResource): string[] {
  return [
    resource.name,
    resource.singularName ?? '',
    ...(resource.shortNames ?? []),
    resource.group ? `${resource.name}.${resource.group}` : '',
    resource.group && resource.singularName ? `${resource.singularName}.${resource.group}` : '',
  ].filter((value) => value.length > 0);
}

function qualifiedName(resource: DiscoveredResource): string {
  return resource.group ? `${resource.name}.${resource.group}` : resource.name;
}

function pickVersion(sameKind: DiscoveredResource[]): DiscoveredResource {
  return sameKind.find((resource) => resource.preferred) ?? (sameKind[0] as DiscoveredResource);
}

function collapseVersions(candidates: DiscoveredResource[]): DiscoveredResource[] {
  const byKind = new Map<string, DiscoveredResource[]>();
  for (const resource of candidates) {
    const key = qualifiedName(resource);
    byKind.set(key, [...(byKind.get(key) ?? []), resource]);
  }
  return [...byKind.values()].map(pickVersion);
}

export interface ResolvedResource {
  resource: DiscoveredResource;
  candidates: DiscoveredResource[];
  unreadable: string[];
}

export async function resolveResource(
  session: K8sSessionLike,
  requested: string,
): Promise<ResolvedResource> {
  const { resources, unreadable } = await discover(session);
  const candidates = resources.filter((resource) => resourceNames(resource).includes(requested));

  if (candidates.length === 0) {
    if (unreadable.length > 0) {
      throw new ToolError(
        'k8s_upstream_error',
        `Ресурс «${requested}» среди прочитанного не найден, но состав кластера прочитан не полностью: ${unreadable.join('; ')}. Отсутствие ресурса не установлено.`,
        { unreadable },
      );
    }
    throw new ToolError(
      'k8s_resource_not_found',
      `Ресурс «${requested}» не найден через Kubernetes discovery ни по имени, ни по сокращению.`,
    );
  }

  const exactQualified = candidates.filter((resource) =>
    resource.group
      ? requested === `${resource.name}.${resource.group}` ||
        requested === `${resource.singularName}.${resource.group}`
      : requested === resource.name || requested === resource.singularName,
  );
  const pool = collapseVersions(exactQualified.length > 0 ? exactQualified : candidates);

  if (pool.length > 1) {
    const names = pool.map(qualifiedName);
    throw new ToolError(
      'k8s_resource_ambiguous',
      `Имя «${requested}» соответствует нескольким ресурсам: ${names.join(', ')}. Укажите полное имя resource.group.`,
      { candidates: names, howToSelect: 'Укажите ресурс как resource.group.' },
    );
  }
  return { resource: pool[0] as DiscoveredResource, candidates, unreadable };
}

export function resourcePath(
  resource: DiscoveredResource,
  namespace: string | null,
  name: string | null,
): string {
  const prefix = resource.group
    ? `/apis/${encodeURIComponent(resource.group)}/${encodeURIComponent(resource.version)}`
    : `/api/${encodeURIComponent(resource.version)}`;
  const scope = resource.namespaced ? `/namespaces/${encodeURIComponent(namespace as string)}` : '';
  const item = name === null ? '' : `/${encodeURIComponent(name)}`;
  return `${prefix}${scope}/${encodeURIComponent(resource.name)}${item}`;
}
