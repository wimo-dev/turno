---
"turno-browser": patch
---

Attach mode no longer fails with "DevToolsActivePort is not a port and a path" when it reads the file while Chrome is still writing it, for example right after Chrome starts with remote debugging on. It now reads the file again for up to 5 seconds while it is missing, empty or partial, and only then says what to do. `turno-browser doctor` still checks it once, without waiting.
