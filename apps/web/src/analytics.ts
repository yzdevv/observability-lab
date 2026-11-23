// Optional page analytics with Jejak (self-hosted, cookieless). Enabled only when the build sets
// VITE_JEJAK_SITE; the host routes /j.js and /e to the Jejak collector (on the homelab: a
// Cloudflare tunnel path route). Custom events come from data-jejak-* attributes on clicked
// elements, e.g. the send button.
export function loadAnalytics() {
  const site = import.meta.env.VITE_JEJAK_SITE as string | undefined;
  if (!site) return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = '/j.js';
  script.dataset.site = site;
  script.dataset.outbound = '';
  document.head.appendChild(script);
}
