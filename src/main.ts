import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { mountGitLabPanel } from './controller.js';

// Connect the sandboxed page to OpenChamber only when its panel root is present.
const root = document.querySelector<HTMLElement>('#app');
if (root) {
  const host = connectHost();

  // Apply live host theme values before the panel renders its first ready state.
  const unsubscribeTheme = host.onReady((context) => applyHostReady(context, document.documentElement));
  const panel = mountGitLabPanel(host, root);

  // Release theme, panel, and host listeners when the iframe leaves the page.
  window.addEventListener('pagehide', () => {
    panel.destroy();
    unsubscribeTheme();
    host.dispose();
  }, { once: true });
}
