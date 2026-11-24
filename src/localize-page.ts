import { language, translate } from './i18n.ts';

// The static page is checked alongside the catalogue. Player content is never walked.
export function localizePage(root: Document = document): void {
  root.documentElement.lang = language();
  root.title = translate(root.title);
  if (language() === 'pt-BR') return;
  const walker = root.createTreeWalker(root.body, 4), nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest('script,style,svg,code,textarea') || !node.nodeValue) continue;
    const source = node.nodeValue.trim().replace(/\s+/g, ' ');
    node.nodeValue = node.nodeValue.replace(/\S[\s\S]*\S|\S/, translate(source));
  }
  for (const element of root.querySelectorAll('[title],[aria-label],[placeholder]')) for (const attr of ['title', 'aria-label', 'placeholder']) {
    const source = element.getAttribute(attr); if (source) element.setAttribute(attr, translate(source));
  }
}
