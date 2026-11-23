---
"turno-browser": patch
---

A tool call whose navigation the policy takes back no longer waits until a timeout. The tab used to go back in history, and Chrome restored the page from its back/forward cache, for which Playwright sees no DOMContentLoaded or load: a `browser_navigate` whose redirect left the allowed domains could wait the full 60 s navigation timeout, which is also the MCP client's limit, so the call failed with "Request timed out", and a click on a refused link took about 15 s. The tab now loads its last allowed page again, and the call returns as soon as it shows.
