import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runK8sCommand } from '../src/commands/k8s.ts';
import { resolveResource } from '../src/k8s/discovery.ts';
import { resolveKubeconfig } from '../src/k8s/kubeconfig.ts';
import { K8sHttpError, K8sSession, type K8sSessionLike } from '../src/k8s/session.ts';
import type { Profile } from '../src/profile.ts';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'tt-stand-kubeconfig-'));
}

function profileFixture(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'default',
    path: 'C:/fictional/profiles/default/profile.json',
    grafana: null,
    kubernetes: { kubeconfig: 'C:\\fictional\\kubeconfig.yaml', context: null },
    namespaceScope: null,
    repositoryRoots: [],
    ...overrides,
  };
}

test('каталог с одним kubeconfig-файлом разрешается в этот файл', () => {
  const root = temporaryDirectory();
  try {
    const directory = join(root, 'configs');
    mkdirSync(directory);
    const expected = join(directory, 'fictional-cluster.yaml');
    writeFileSync(expected, 'apiVersion: v1\nkind: Config\n', 'utf8');
    writeFileSync(join(directory, 'readme.txt'), 'не kubeconfig', 'utf8');

    const resolved = resolveKubeconfig(directory, undefined, join(root, 'unused'));
    assert.equal(resolved.path, expected);
    assert.equal(resolved.source, 'config');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('каталог с несколькими kubeconfig-файлами перечисляет кандидатов и требует выбор', () => {
  const root = temporaryDirectory();
  try {
    const first = join(root, 'fictional-a.yaml');
    const second = join(root, 'fictional-b.yml');
    writeFileSync(first, 'apiVersion: v1\nkind: Config\n', 'utf8');
    writeFileSync(second, 'apiVersion: v1\nkind: Config\n', 'utf8');

    assert.throws(
      () => resolveKubeconfig(root, undefined, join(root, 'unused')),
      (error: Error & { errorClass?: string; partialPayload?: unknown }) => {
        assert.equal(error.errorClass, 'kubeconfig_ambiguous');
        assert.deepEqual((error.partialPayload as { candidates: string[] }).candidates, [
          first,
          second,
        ]);
        assert.match(error.message, /kubernetes\.kubeconfig/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function multiContextKubeconfig(dir: string): string {
  const path = join(dir, 'kubeconfig.yaml');
  writeFileSync(
    path,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '  - name: fictional-cluster-a',
      '    cluster:',
      '      server: https://fictional-a.example.invalid',
      '  - name: fictional-cluster-b',
      '    cluster:',
      '      server: https://fictional-b.example.invalid',
      'users:',
      '  - name: fictional-user-a',
      '    user: {}',
      '  - name: fictional-user-b',
      '    user: {}',
      'contexts:',
      '  - name: fictional-context-a',
      '    context:',
      '      cluster: fictional-cluster-a',
      '      user: fictional-user-a',
      '      namespace: stand-a',
      '  - name: fictional-context-b',
      '    context:',
      '      cluster: fictional-cluster-b',
      '      user: fictional-user-b',
      'current-context: fictional-context-a',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

test('контекст, заданный профилем, применяется и назван источником profile', () => {
  const root = temporaryDirectory();
  try {
    const path = multiContextKubeconfig(root);
    const session = new K8sSession(path, 'fictional-context-b');
    assert.equal(session.metadata.context, 'fictional-context-b');
    assert.equal(session.metadata.contextSource, 'profile');
    assert.equal(session.metadata.cluster, 'fictional-cluster-b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('без контекста в профиле берётся действующий контекст kubeconfig', () => {
  const root = temporaryDirectory();
  try {
    const path = multiContextKubeconfig(root);
    const session = new K8sSession(path, null);
    assert.equal(session.metadata.context, 'fictional-context-a');
    assert.equal(session.metadata.contextSource, 'kubeconfig');
    assert.equal(session.metadata.defaultNamespace, 'stand-a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('несуществующий контекст профиля даёт kube_context_missing с перечнем имён', () => {
  const root = temporaryDirectory();
  try {
    const path = multiContextKubeconfig(root);
    assert.throws(
      () => new K8sSession(path, 'нет-такого'),
      (error: Error & { errorClass?: string }) =>
        error.errorClass === 'kube_context_missing' &&
        /fictional-context-a/.test(error.message) &&
        /fictional-context-b/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('профиль без доступа к кластеру отказывает profile_incomplete', async () => {
  const response = await runK8sCommand(
    profileFixture({ kubernetes: null }),
    { action: 'pods', namespace: null },
    () => {
      throw new Error('к кластеру обращаться не должны');
    },
  );
  assert.equal(response.ok, false);
  assert.equal(response.errorClass, 'profile_incomplete');
  assert.match(response.error ?? '', /default/);
});

test('запрошенный namespace вне области отвергается без обращения к кластеру', async () => {
  let sessionCreated = false;
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'pods', namespace: 'prod-1' },
    () => {
      sessionCreated = true;
      throw new Error('не должно вызываться');
    },
  );
  assert.equal(sessionCreated, false);
  assert.equal(response.errorClass, 'namespace_out_of_scope');
  assert.match(response.error ?? '', /prod-1/);
  assert.match(response.error ?? '', /default/);
  assert.deepEqual((response.echo as Record<string, unknown>).namespaceScope, ['stand-*']);
});

function listSession(items: unknown[]): K8sSessionLike {
  return {
    metadata: {
      kubeconfig: 'C:\\fictional\\kubeconfig.yaml',
      kubeconfigSource: 'config',
      context: 'fictional-context',
      contextSource: 'kubeconfig',
      cluster: 'fictional-cluster',
      defaultNamespace: 'fictional-ns',
    },
    lastRequest: null,
    async getJson(path: string) {
      (this as { lastRequest: string | null }).lastRequest = `GET ${path}`;
      if (path === '/api') return { versions: ['v1'] };
      if (path === '/api/v1') return { resources: [{ name: 'pods', namespaced: true, kind: 'Pod' }] };
      if (path === '/apis') return { groups: [] };
      return { items };
    },
    async getText() {
      throw new Error('не ожидался текстовый запрос');
    },
  };
}

test('запрошенный namespace в области — команда выполняется, эхо называет профиль и область', async () => {
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'pods', namespace: 'stand-1' },
    () => listSession([]),
  );
  assert.equal(response.ok, true);
  const echo = response.echo as Record<string, unknown>;
  assert.equal(echo.profile, 'default');
  assert.deepEqual(echo.namespaceScope, ['stand-*']);
  assert.equal(echo.namespace, 'stand-1');
});

test('отсутствие лога предыдущего запуска возвращается отдельным честным исходом', async () => {
  const session: K8sSessionLike = {
    metadata: {
      kubeconfig: 'C:\\fictional\\kubeconfig.yaml',
      kubeconfigSource: 'config',
      context: 'fictional-context',
      contextSource: 'kubeconfig',
      cluster: 'fictional-cluster',
      defaultNamespace: 'fictional-ns',
    },
    lastRequest: null,
    async getJson() {
      throw new Error('не ожидался JSON-запрос');
    },
    async getText(path: string) {
      (this as { lastRequest: string | null }).lastRequest = `GET ${path}`;
      throw new K8sHttpError(
        400,
        'Bad Request',
        JSON.stringify({
          reason: 'BadRequest',
          message: 'previous terminated container "app" in pod "fictional-pod" not found',
        }),
      );
    },
  };

  const response = await runK8sCommand(
    profileFixture(),
    {
      action: 'log',
      pod: 'fictional-pod',
      namespace: null,
      container: 'app',
      previous: true,
    },
    () => session,
  );

  assert.equal(response.ok, false);
  assert.equal(response.errorClass, 'previous_log_unavailable');
  assert.deepEqual(response.summary, { logAvailable: false, previous: true });
  assert.deepEqual(response.data, {
    pod: 'fictional-pod',
    previous: true,
    logAvailable: false,
  });
  assert.equal((response.echo as Record<string, unknown>).context, 'fictional-context');
  assert.equal((response.echo as Record<string, unknown>).namespace, 'fictional-ns');
  assert.equal((response.echo as Record<string, unknown>).previous, true);
});

function historySession(items: unknown[]): K8sSessionLike {
  return {
    metadata: {
      kubeconfig: 'C:\fictionalkubeconfig.yaml',
      kubeconfigSource: 'config',
      context: 'fictional-context',
      contextSource: 'kubeconfig',
      cluster: 'fictional-cluster',
      defaultNamespace: 'fictional-ns',
    },
    lastRequest: null,
    async getJson(path: string) {
      (this as { lastRequest: string | null }).lastRequest = `GET ${path}`;
      if (path === '/api') return { versions: [] };
      if (path === '/apis') {
        return { groups: [{ preferredVersion: { groupVersion: 'apps/v1' } }] };
      }
      if (path === '/apis/apps/v1') {
        return {
          resources: [
            {
              name: 'replicasets',
              singularName: 'replicaset',
              namespaced: true,
              kind: 'ReplicaSet',
              shortNames: ['rs'],
            },
            {
              name: 'deployments',
              singularName: 'deployment',
              namespaced: true,
              kind: 'Deployment',
              shortNames: ['deploy'],
            },
          ],
        };
      }
      if (path.includes('/deployments/')) {
        return { metadata: { uid: 'uid-fictional-api' } };
      }
      return { items };
    },
    async getText() {
      throw new Error('не ожидался текстовый запрос');
    },
  };
}

function revision(
  name: string,
  rev: string,
  created: string,
  image: string,
  replicas: number,
  owner = 'uid-fictional-api',
) {
  return {
    metadata: {
      name,
      creationTimestamp: created,
      annotations: { 'deployment.kubernetes.io/revision': rev },
      ownerReferences: [{ kind: 'Deployment', uid: owner, controller: true }],
    },
    spec: { replicas, template: { spec: { containers: [{ image }] } } },
  };
}

test('история деплоев возвращает ревизии по возрастанию и смены образа', async () => {
  const session = historySession([
    revision('fictional-api-b', '2', '2026-02-02T00:00:00Z', 'fictional-api:2.0.0', 1),
    revision('fictional-api-a', '1', '2026-01-01T00:00:00Z', 'fictional-api:1.0.0', 0),
    revision('other-api-x', '7', '2026-03-03T00:00:00Z', 'other-api:7.0.0', 1, 'uid-other-api'),
  ]);
  const response = await runK8sCommand(
    profileFixture(),
    { action: 'history', workload: 'fictional-api', namespace: null },
    () => session,
  );

  assert.equal(response.ok, true);
  const revisions = response.data as Array<Record<string, unknown>>;
  assert.equal(revisions.length, 2, 'чужая рабочая нагрузка не должна попадать в историю');
  assert.deepEqual(
    revisions.map((r) => r.revision),
    ['1', '2'],
  );
  assert.equal((response.summary as Record<string, unknown>).revisionCount, 2);
  assert.equal(
    ((response.summary as Record<string, unknown>).imageChanges as unknown[]).length,
    2,
    'обе ревизии несут разные образы',
  );
  assert.ok(revisions[0]?.replicaSet, 'исходный объект ревизии должен остаться');
});

test('отсутствие ревизий — честный неполный ответ, а не отказ', async () => {
  const response = await runK8sCommand(
    profileFixture(),
    { action: 'history', workload: 'fictional-api', namespace: null },
    () => historySession([]),
  );

  assert.equal(response.ok, true);
  assert.equal(response.incomplete, true);
  assert.equal((response.data as unknown[]).length, 0);
  assert.match(response.incompleteReasons.join(' '), /история выкаток недоступна/);
});

function discoverySession(routes: Record<string, unknown>, failing: Record<string, number> = {}) {
  return {
    metadata: {
      kubeconfig: 'k',
      kubeconfigSource: 'config',
      context: 'c',
      contextSource: 'kubeconfig',
      cluster: 'x',
      defaultNamespace: 'n',
    },
    lastRequest: null as string | null,
    async getJson(path: string): Promise<unknown> {
      const status = failing[path];
      if (status !== undefined) throw new K8sHttpError(status, 'Forbidden', 'нет прав');
      return routes[path] ?? {};
    },
    async getText(): Promise<string> {
      return '';
    },
  };
}

const DEPLOYMENT = {
  name: 'deployments',
  singularName: 'deployment',
  namespaced: true,
  kind: 'Deployment',
  shortNames: ['deploy'],
};

test('вид, отданный в двух версиях группы, читается через основную', async () => {
  const session = discoverySession({
    '/api': { versions: ['v1'] },
    '/api/v1': { resources: [] },
    '/apis': {
      groups: [
        {
          preferredVersion: { groupVersion: 'apps/v1' },
          versions: [{ groupVersion: 'apps/v1beta1' }, { groupVersion: 'apps/v1' }],
        },
      ],
    },
    '/apis/apps/v1': { resources: [DEPLOYMENT] },
    '/apis/apps/v1beta1': { resources: [DEPLOYMENT] },
    '/apis/apps/v1/namespaces/n/deployments': { items: [] },
  });
  const resolved = await resolveResource(session, 'deployments');
  assert.equal(resolved.resource.groupVersion, 'apps/v1');
  assert.deepEqual(resolved.unreadable, []);
});

test('одинаковое имя в разных группах остаётся неоднозначным', async () => {
  const session = discoverySession({
    '/api': { versions: ['v1'] },
    '/api/v1': {
      resources: [{ name: 'events', namespaced: true, kind: 'Event', shortNames: ['ev'] }],
    },
    '/apis': { groups: [{ preferredVersion: { groupVersion: 'events.k8s.io/v1' }, versions: [] }] },
    '/apis/events.k8s.io/v1': {
      resources: [{ name: 'events', namespaced: true, kind: 'Event', shortNames: ['ev'] }],
    },
  });
  await assert.rejects(
    () => resolveResource(session, 'ev'),
    (error: Error & { errorClass?: string }) => error.errorClass === 'k8s_resource_ambiguous',
  );
});

test('недоступная группа названа, а не проглочена', async () => {
  const session = discoverySession(
    {
      '/api': { versions: ['v1'] },
      '/api/v1': { resources: [DEPLOYMENT] },
      '/apis': { groups: [{ preferredVersion: { groupVersion: 'apps/v1' }, versions: [] }] },
    },
    { '/apis/apps/v1': 403 },
  );
  const resolved = await resolveResource(session, 'deployments');
  assert.equal(resolved.unreadable.length, 1);
  assert.match(resolved.unreadable[0] as string, /apps\/v1/);
});

test('ненайденный вид при недоступной группе не выдаётся за отсутствие вида', async () => {
  const session = discoverySession(
    {
      '/api': { versions: ['v1'] },
      '/api/v1': { resources: [] },
      '/apis': { groups: [{ preferredVersion: { groupVersion: 'apps/v1' }, versions: [] }] },
    },
    { '/apis/apps/v1': 403 },
  );
  await assert.rejects(
    () => resolveResource(session, 'deployments'),
    (error: Error & { errorClass?: string }) => error.errorClass === 'k8s_upstream_error',
  );
});
