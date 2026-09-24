import { connectHost } from '@openchamber/sdk';
import { mountGitLabPanel } from './controller.js';

// Connect the sandboxed page to OpenChamber only when its panel root is present.
const root = document.querySelector<HTMLElement>('#app');
if (root) {
  const host = connectHost();
  const panel = mountGitLabPanel(host, root);

  // Release host listeners and panel events when the iframe leaves the page.
  window.addEventListener('pagehide', () => {
    panel.destroy();
    host.dispose();
  }, { once: true });
}
