import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProfile, requireGrafana, requireKubernetes } from '../src/profile.ts';
import { normalizePath } from '../src/paths.ts';

const PATH = 'C:/fictional/profiles/broken/profile.json';
const CREDENTIALS_DEFAULT = 'C:/fictional/profiles/broken/credentials.json';

test('неверный тип grafana.timeoutSeconds называет профиль и поле', () => {
  assert.throws(
    () =>
      parseProfile({ grafana: { timeoutSeconds: 'быстро' } }, 'broken', PATH, CREDENTIALS_DEFAULT),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'config_invalid' &&
      /broken/.test(error.message) &&
      /grafana\.timeoutSeconds/.test(error.message),
  );
});

test('нулевой и отрицательный таймаут отвергаются', () => {
  assert.throws(
    () => parseProfile({ grafana: { timeoutSeconds: 0 } }, 'broken', PATH, CREDENTIALS_DEFAULT),
    (error: Error & { errorClass?: string }) => error.errorClass === 'config_invalid',
  );
});

test('repositoryRoots не списком строк называет профиль и поле', () => {
  assert.throws(
    () => parseProfile({ repositoryRoots: 'не список' }, 'broken', PATH, CREDENTIALS_DEFAULT),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'config_invalid' &&
      /broken/.test(error.message) &&
      /repositoryRoots/.test(error.message),
  );
});

test('kubernetes.context не строкой называет профиль и поле', () => {
  assert.throws(
    () =>
      parseProfile({ kubernetes: { context: 7 } }, 'broken', PATH, CREDENTIALS_DEFAULT),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'config_invalid' &&
      /broken/.test(error.message) &&
      /kubernetes\.context/.test(error.message),
  );
});

test('без раздела grafana профиль пригоден, но requireGrafana отказывает', () => {
  const profile = parseProfile({ kubernetes: { kubeconfig: 'k' } }, 'k8s-only', PATH, CREDENTIALS_DEFAULT);
  assert.equal(profile.grafana, null);
  assert.throws(
    () => requireGrafana(profile),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'profile_incomplete' && /k8s-only/.test(error.message),
  );
});

test('без раздела kubernetes профиль пригоден, но requireKubernetes отказывает', () => {
  const profile = parseProfile({ grafana: { baseUrl: 'https://g.example.invalid' } }, 'grafana-only', PATH, CREDENTIALS_DEFAULT);
  assert.equal(profile.kubernetes, null);
  assert.throws(
    () => requireKubernetes(profile),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'profile_incomplete' && /grafana-only/.test(error.message),
  );
});

test('заданный раздел kubernetes не подменяется отсутствующим grafana', () => {
  const profile = parseProfile({ kubernetes: { kubeconfig: 'k' } }, 'k8s-only', PATH, CREDENTIALS_DEFAULT);
  const kubernetes = requireKubernetes(profile);
  assert.equal(kubernetes.kubeconfig, normalizePath('k'));
  assert.equal(profile.grafana, null, 'доступ другого раздела не должен появляться');
});

test('пустой перечень namespaceScope в профиле даёт config_invalid с именем профиля и поля', () => {
  assert.throws(
    () => parseProfile({ namespaceScope: [] }, 'broken', PATH, CREDENTIALS_DEFAULT),
    (error: Error & { errorClass?: string }) =>
      error.errorClass === 'config_invalid' &&
      /broken/.test(error.message) &&
      /namespaceScope/.test(error.message),
  );
});

test('credentialsFile по умолчанию лежит в каталоге профиля', () => {
  const profile = parseProfile({ grafana: {} }, 'full', PATH, CREDENTIALS_DEFAULT);
  assert.equal(profile.grafana?.credentialsFile, CREDENTIALS_DEFAULT);
});
