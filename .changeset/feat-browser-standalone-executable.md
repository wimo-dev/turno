---
"turno-browser": patch
---

turno-browser now also comes as a standalone executable for machines without Node or npm: one file per platform (macOS on Apple silicon and Intel, Linux x64, and an experimental Windows x64) on each GitHub release, with `SHA256SUMS` and build provenance attestations. The executable is both programs: `turno-browser <command>`, and `turno-browser mcp` for the MCP server. In it, `turno-browser setup` and `init` give the agent the executable itself (`<path>/turno-browser mcp --identity <id>`), and `status` and `doctor` recognize that entry in an agent's config. See [Install without Node](https://turno.wimo.dev/docs/browser/get-started#install-without-node).
