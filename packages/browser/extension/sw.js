// The panel's service worker. turno-browser-mcp puts the address of its live server and a code
// that works once here, over the DevTools protocol (`side-panel.ts`): never through a page, and
// never in a URL a site can see. The panel asks for them when it opens and trades the code for
// its own token. This extension has no content scripts, no host permissions and no web
// accessible resources, so no page can reach it or tell that it is there.

let offer = null;

/** Called by the host: the server's origin and a fresh one-use code. */
globalThis.turnoOffer = (next) => {
  offer = next && typeof next.server === "string" && typeof next.code === "string" ? next : null;
  return offer !== null;
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only this extension's own pages: it has no content scripts, so nothing else can send.
  if (sender.id !== chrome.runtime.id || !message || message.type !== "connect") return false;
  reply(offer);
  // A code works once: the next panel gets the next one the host offers.
  offer = null;
  return false;
});

// The toolbar button opens the panel again after the person closed it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
