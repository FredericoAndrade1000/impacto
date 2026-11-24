import { configureLanguage, tr } from './i18n.ts';
import { localizePage } from './localize-page.ts';

configureLanguage({ search: location.search, languages: navigator.languages ?? [navigator.language] });
localizePage();
try {
  // Use Pixi's static uniform and particle code under the production script policy.
  if (import.meta.env.PROD) await import('pixi.js/unsafe-eval');
  await import('./main.ts');
}
catch (error) {
  console.error(error);
  const loading = document.getElementById('loading-text');
  if (loading) loading.textContent = tr('O jogo não carregou. Recarregue a página.');
}
