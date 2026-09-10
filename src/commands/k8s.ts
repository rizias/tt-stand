import { INCOMPLETENESS_REASONS } from '../errors.ts';
import { runAction } from '../k8s/actions.ts';
import { classifyK8sError, type K8sCommand } from '../k8s/errors.ts';
import { K8sSession, type K8sSessionLike } from '../k8s/session.ts';
import { baseEcho, itemCount } from '../k8s/shape.ts';
import { requireKubernetes, type Profile } from '../profile.ts';
import type { Echo, ToolResponse } from '../response.ts';
import { assertInScope, NAMESPACE_SOURCES } from '../scope.ts';

function failureEcho(
  echo: Echo & Record<string, unknown>,
  command: K8sCommand,
  session: K8sSessionLike | null,
): void {
  if (session) echo.request = session.lastRequest;
  const fallbackNamespace = session?.metadata.defaultNamespace ?? null;

  if (command.action === 'get') {
    Object.assign(echo, {
      namespace: command.namespace,
      resource: command.resource,
      name: command.name,
    });
    return;
  }
  if (command.action === 'log') {
    Object.assign(echo, {
      namespace: command.namespace ?? fallbackNamespace,
      resource: 'pods/log',
      name: command.pod,
      container: command.container,
      previous: command.previous,
    });
    return;
  }
  Object.assign(echo, {
    namespace: command.namespace ?? fallbackNamespace,
    resource: command.action,
  });
}

export async function runK8sCommand(
  profile: Profile,
  command: K8sCommand,
  makeSession: (configured: string | null, context: string | null) => K8sSessionLike = (
    configured,
    context,
  ) => new K8sSession(configured, context),
): Promise<ToolResponse> {
  const commandName = `k8s ${command.action}`;
  const echo = baseEcho(commandName) as Echo & Record<string, unknown>;
  echo.profile = profile.name;
  echo.namespaceScope = profile.namespaceScope;
  let session: K8sSessionLike | null = null;

  try {
    const source =
      command.namespace === null
        ? NAMESPACE_SOURCES.contextDefault
        : NAMESPACE_SOURCES.argument;
    if (command.namespace !== null) {
      assertInScope(command.namespace, profile.namespaceScope, profile.name, source);
    }
    const kubernetes = requireKubernetes(profile);
    session = makeSession(kubernetes.kubeconfig, kubernetes.context);
    Object.assign(echo, session.metadata);

    const outcome = await runAction(session, command, (namespace) => {
      assertInScope(namespace, profile.namespaceScope, profile.name, source);
    });
    Object.assign(echo, outcome.echoPatch);
    echo.recordsReturned = Array.isArray(outcome.data)
      ? outcome.data.length
      : itemCount(outcome.data);
    if (outcome.unreadable.length > 0) echo.unavailableSources = outcome.unreadable;

    const reasons: string[] = [];
    if (outcome.historyEmpty) reasons.push(INCOMPLETENESS_REASONS.historyEmpty);
    if (outcome.unreadable.length > 0) reasons.push(INCOMPLETENESS_REASONS.discoveryIncomplete);

    return {
      ok: true,
      command: commandName,
      data: outcome.data,
      summary: outcome.summary,
      echo,
      incomplete: reasons.length > 0,
      incompleteReasons: reasons,
      errorClass: null,
      error: null,
    };
  } catch (cause) {
    const error = classifyK8sError(cause, {
      podName: command.action === 'log' ? command.pod : undefined,
      previous: command.action === 'log' ? command.previous : undefined,
    });
    failureEcho(echo, command, session);

    return {
      ok: false,
      command: commandName,
      data: error.partialPayload ?? null,
      summary:
        error.errorClass === 'previous_log_unavailable'
          ? { logAvailable: false, previous: true }
          : null,
      echo,
      incomplete: true,
      incompleteReasons: [INCOMPLETENESS_REASONS.k8sCommandFailed],
      errorClass: error.errorClass,
      error: error.message,
    };
  }
}
