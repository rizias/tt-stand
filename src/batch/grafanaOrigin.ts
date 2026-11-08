export function publicGrafanaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}
