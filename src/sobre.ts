const english = {
  title: 'About Impacto',
  intro: 'Impacto is a side-view 2D game made for a roleplay community. Build vehicles in the Workshop and play in a persistent online field.',
  locale: 'en_US',
  imageAlt: 'Mountains and forest in Impacto',
  language: 'Language',
  play: 'Play',
  source: 'Open source',
  github: 'Repository on GitHub',
  code: 'Code',
  assets: 'Art and audio',
  trademark: 'Trademark',
  brandRule: '“Impacto” is reserved. Use your own fork name.',
  contribute: 'How to contribute',
  security: 'Report a security issue',
  hosting: 'Download and host a server',
  requirements: 'You need Docker with Compose and a domain with HTTPS.',
  download: 'Clone the repository or',
  zip: 'download the ZIP',
  openFolder: 'In the project folder, copy the example file.',
  address: 'Set your HTTPS domain in',
  start: 'and start the server.',
  hostingGuide: 'Hosting guide',
  recovery: 'Field backup and recovery',
  directory: 'List your server',
  register: 'Request registration in the',
  discord: 'community Discord',
  configure: 'and configure the',
  key: 'variables with the key you receive.',
  directoryGuide: 'Registration instructions',
  serverList: 'View the server list',
};

const spanish: typeof english = {
  title: 'Acerca de Impacto',
  intro: 'Impacto es un juego 2D con vista lateral creado para una comunidad de rol. Arma vehículos en el Taller y juega en un campo persistente en línea.',
  locale: 'es_419',
  imageAlt: 'Montañas y bosque de Impacto',
  language: 'Idioma',
  play: 'Jugar',
  source: 'Código abierto',
  github: 'Repositorio en GitHub',
  code: 'Código',
  assets: 'Arte y audio',
  trademark: 'Marca',
  brandRule: '«Impacto» está reservado. Usa otro nombre para tu fork.',
  contribute: 'Cómo contribuir',
  security: 'Reportar una falla de seguridad',
  hosting: 'Descargar y alojar un servidor',
  requirements: 'Necesitas Docker con Compose y un dominio con HTTPS.',
  download: 'Clona el repositorio o',
  zip: 'descarga el ZIP',
  openFolder: 'En la carpeta del proyecto, copia el archivo de ejemplo.',
  address: 'Configura tu dominio HTTPS en',
  start: 'e inicia el servidor.',
  hostingGuide: 'Guía de alojamiento',
  recovery: 'Copia de seguridad y recuperación del campo',
  directory: 'Aparecer en la lista de servidores',
  register: 'Solicita el registro en el',
  discord: 'Discord de la comunidad',
  configure: 'y configura las variables',
  key: 'con la clave que recibas.',
  directoryGuide: 'Instrucciones de registro',
  serverList: 'Ver la lista de servidores',
};

const requested = new URLSearchParams(location.search).get('lang');
const language = requested === 'en' || requested === 'es' ? requested : 'pt-BR';
document.documentElement.lang = language;

if (language !== 'pt-BR') {
  const copy: Readonly<Record<string, string>> = language === 'en' ? english : spanish;
  for (const element of document.querySelectorAll<HTMLElement>('[data-copy]')) {
    const text = copy[element.dataset.copy ?? ''];
    if (!text) continue;
    if (element instanceof HTMLMetaElement) element.content = text;
    else if (element.hasAttribute('aria-label')) element.setAttribute('aria-label', text);
    else element.textContent = text;
  }
}

const languages = document.querySelector<HTMLElement>('.languages')!;
languages.querySelector(`[hreflang="${language}"]`)?.setAttribute('aria-current', 'true');
languages.hidden = false;
