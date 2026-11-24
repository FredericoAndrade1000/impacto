import { configureLanguage } from './i18n.ts';
import { localizePage } from './localize-page.ts';
configureLanguage({ languages: navigator.languages ?? [navigator.language], search: location.search });
localizePage();
await import('./replay-viewer.ts');
