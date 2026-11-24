export function readHttpsOrigins(input = ''): ReadonlySet<string> {
  return new Set(input.trim() ? input.split(',').map(entry => {
    const url = new URL(entry.trim());
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error('Informe apenas origens HTTPS separadas por vírgula.');
    return url.origin;
  }) : []);
}
