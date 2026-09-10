import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runK8sCommand } from '../src/commands/k8s.ts';
import type { K8sSessionLike } from '../src/k8s/session.ts';
import type { Profile } from '../src/profile.ts';

function profileFixture(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'default',
    path: 'C:/fictional/profiles/default/profile.json',
    grafana: null,
    kubernetes: { kubeconfig: 'C:\\fictional\\kubeconfig.yaml', context: null },
    namespaceScope: null,
    repositoryRoots: [],
    journalDirectory: 'C:/fictional/profiles/default/journal',
    ...overrides,
  };
}

function sessionFixture(defaultNamespace: string): K8sSessionLike {
  return {
    metadata: {
      kubeconfig: 'C:\\fictional\\kubeconfig.yaml',
      kubeconfigSource: 'config',
      context: 'fictional-context',
      contextSource: 'kubeconfig',
      cluster: 'fictional-cluster',
      defaultNamespace,
    },
    lastRequest: null,
    async getJson(path: string) {
      (this as { lastRequest: string | null }).lastRequest = `GET ${path}`;
      if (path === '/api') return { versions: ['v1'] };
      if (path === '/api/v1') {
        return {
          resources: [
            { name: 'pods', namespaced: true, kind: 'Pod' },
            { name: 'nodes', namespaced: false, kind: 'Node' },
          ],
        };
      }
      if (path === '/apis') return { groups: [] };
      return { items: [] };
    },
    async getText() {
      throw new Error('не ожидался текстовый запрос');
    },
  };
}

test('namespace из умолчания вне области отвергается, а не выдаётся', async () => {
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'pods', namespace: null },
    () => sessionFixture('prod-1'),
  );
  assert.equal(response.ok, false);
  assert.equal(response.errorClass, 'namespace_out_of_scope');
  assert.match(response.error ?? '', /prod-1/u);
});

test('namespace из умолчания внутри области выполняется', async () => {
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'pods', namespace: null },
    () => sessionFixture('stand-a'),
  );
  assert.equal(response.ok, true);
  assert.equal((response.echo as Record<string, unknown>).namespace, 'stand-a');
});

test('отказ называет умолчание как источник имени namespace', async () => {
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'pods', namespace: null },
    () => sessionFixture('prod-1'),
  );
  assert.match(response.error ?? '', /умолчания настроек доступа к кластеру/u);
});

test('отказ называет параметр команды как источник имени namespace', async () => {
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'pods', namespace: 'prod-1' },
    () => sessionFixture('stand-a'),
  );
  assert.match(response.error ?? '', /задан параметром команды/u);
});

test('ресурс уровня кластера областью не ограничивается', async () => {
  const response = await runK8sCommand(
    profileFixture({ namespaceScope: ['stand-*'] }),
    { action: 'get', resource: 'nodes', namespace: null, name: null },
    () => sessionFixture('prod-1'),
  );
  assert.equal(response.ok, true);
  assert.equal(response.errorClass, null);
});
