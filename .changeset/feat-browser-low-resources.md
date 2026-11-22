---
"turno-browser": minor
"turno-core": minor
---

A low-resource preset for machines short of memory: `turno-browser set <id> --resources low` (identity.json `"resources": "low"`, or `turno-browser-mcp --resources low`) keeps at most 2 tabs open, parks an unused tab after 2 minutes, closes Chrome after 5 minutes without a tool call and the background server after 5 minutes without a request, turns off Chrome's back/forward cache so a parked tab frees its memory at once, and adds a short note to tool results while the system reports memory pressure. A key set on its own (`--tabs-max`, `TURNO_BROWSER_IDLE`, `--background-idle`) still wins over the preset. `turno-browser doctor` shows the memory pressure. The memory pressure probe mcpd uses moved to `turno-core/memory`, so turno-browser reads the same level.
