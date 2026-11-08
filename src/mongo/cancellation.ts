export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
