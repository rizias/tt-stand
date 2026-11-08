import http from 'node:http';
import https from 'node:https';
import { KubeConfig } from '@kubernetes/client-node';
import { ToolError } from '../errors.ts';
import { type KubeconfigSource, resolveKubeconfig } from './kubeconfig.ts';

export interface K8sMetadata {
  kubeconfig: string;
  kubeconfigSource: KubeconfigSource;
  context: string;
  contextSource: 'profile' | 'kubeconfig';
  cluster: string;
  defaultNamespace: string;
}

function httpErrorMessage(status: number, statusText: string, safeBody: string | null): string {
  if (safeBody === null || [403, 404].includes(status)) return `Kubernetes ответил HTTP ${status}.`;
  const description = statusText ? ` ${statusText}` : '';
  const detail = safeBody ? `: ${safeBody}` : '.';
  return `Kubernetes ответил HTTP ${status}${description}${detail}`;
}

export class K8sHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly safeBody: string | null;

  constructor(
    status: number,
    statusText: string,
    body: string,
    safeBody: string | null = status === 401 ? null : body,
  ) {
    super(httpErrorMessage(status, statusText, safeBody));
    this.name = 'K8sHttpError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.safeBody = safeBody;
  }
}

function credentialTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value, value.replace(/^(?:Bearer|Basic)\s+/iu, '')];
  if (Buffer.isBuffer(value)) return [value.toString('utf8')];
  if (Array.isArray(value)) return value.flatMap(credentialTexts);
  return [];
}

function safeErrorBody(
  body: string,
  statusText: string,
  options: https.RequestOptions,
  user: ReturnType<KubeConfig['getCurrentUser']>,
): string | null {
  const headers = Object.entries(options.headers ?? {})
    .filter(([name]) => /authorization|token|secret|api.?key|password/iu.test(name))
    .flatMap(([, value]) => credentialTexts(value));
  const secrets = [
    ...credentialTexts(user?.token),
    ...credentialTexts(user?.password),
    ...credentialTexts(user?.keyData),
    ...credentialTexts(options.auth),
    ...credentialTexts(options.key),
    ...credentialTexts(options.pfx),
    ...credentialTexts(options.passphrase),
    ...headers,
  ];
  const responseText = `${statusText}\n${body}`;
  return secrets.some((secret) => {
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    return secret.length > 0 && (responseText.includes(secret) || responseText.includes(jsonEscaped));
  })
    ? null
    : body;
}

interface HttpResult {
  body: string;
}

export interface K8sSessionLike {
  readonly metadata: K8sMetadata;
  readonly lastRequest: string | null;
  getJson(path: string): Promise<unknown>;
  getText(path: string): Promise<string>;
}

export class K8sSession implements K8sSessionLike {
  readonly metadata: K8sMetadata;
  lastRequest: string | null = null;
  private readonly kubeConfig: KubeConfig;
  private readonly server: string;

  constructor(configured: string | null, contextName: string | null = null) {
    const resolved = resolveKubeconfig(configured);
    const kubeConfig = new KubeConfig();
    try {
      kubeConfig.loadFromFile(resolved.path);
    } catch {
      throw new ToolError('kubeconfig_invalid', `Kubeconfig ${resolved.path} не загружен. Проверьте формат файла.`);
    }
    const requestedContext = contextName ?? kubeConfig.getCurrentContext();
    const context = requestedContext ? kubeConfig.getContextObject(requestedContext) : null;
    if (!requestedContext || !context) {
      if (contextName !== null) {
        const known = kubeConfig.getContexts().map((item) => item.name);
        throw new ToolError(
          'kube_context_missing',
          `Контекст «${contextName}» не найден в kubeconfig ${resolved.path}. Имеющиеся контексты: ${known.length > 0 ? known.join(', ') : '(нет ни одного)'}.`,
          null,
          { requestedContext: contextName, contexts: known },
        );
      }
      throw new ToolError('kube_context_missing', `В kubeconfig ${resolved.path} не задан действующий контекст.`);
    }
    kubeConfig.setCurrentContext(requestedContext);
    const cluster = kubeConfig.getCurrentCluster();
    if (!cluster) {
      throw new ToolError(
        'kube_context_missing',
        `В kubeconfig ${resolved.path} у контекста «${requestedContext}» не найден его кластер.`,
      );
    }
    this.kubeConfig = kubeConfig;
    this.server = cluster.server.replace(/\/+$/, '');
    this.metadata = {
      kubeconfig: resolved.path,
      kubeconfigSource: resolved.source,
      context: requestedContext,
      contextSource: contextName !== null ? 'profile' : 'kubeconfig',
      cluster: context.cluster,
      defaultNamespace: context.namespace ?? 'default',
    };
  }

  async getJson(path: string): Promise<unknown> {
    const result = await this.request(path, 'application/json');
    try {
      return JSON.parse(result.body) as unknown;
    } catch {
      throw new ToolError('k8s_upstream_error', `Ответ Kubernetes на ${this.lastRequest} не разобран как JSON.`);
    }
  }

  async getText(path: string): Promise<string> {
    return (await this.request(path, 'text/plain, */*')).body;
  }

  private async request(path: string, accept: string): Promise<HttpResult> {
    this.lastRequest = `GET ${path}`;
    const url = new URL(path, `${this.server}/`);
    const options: https.RequestOptions = {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: { Accept: accept },
    };
    try {
      await this.kubeConfig.applyToHTTPSOptions(options);
    } catch {
      throw new ToolError('k8s_upstream_error', 'Не удалось применить учётные данные kubeconfig.');
    }
    const currentUser = this.kubeConfig.getCurrentUser();

    return await new Promise<HttpResult>((resolve, reject) => {
      const request = (url.protocol === 'http:' ? http : https).request(options, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('aborted', () => {
          request.destroy();
          reject(new ToolError('k8s_upstream_error', `Ответ на ${this.lastRequest} оборван до конца передачи.`));
        });
        response.on('error', () => {
          request.destroy();
          reject(new ToolError('k8s_upstream_error', `Чтение ответа на ${this.lastRequest} не удалось.`));
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          const statusText = response.statusMessage ?? '';
          if (status < 200 || status >= 300) {
            reject(new K8sHttpError(status, statusText, body, safeErrorBody(body, statusText, options, currentUser)));
            return;
          }
          resolve({ body });
        });
      });
      request.on('error', () => {
        reject(new ToolError('k8s_upstream_error', `Запрос ${this.lastRequest} не выполнен.`));
      });
      request.end();
    });
  }
}
