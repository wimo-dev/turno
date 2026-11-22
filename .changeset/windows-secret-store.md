---
"turno-core": minor
"turno-browser": patch
---

A secret store on Windows: each item (a vault credential or a `keychain:` secret) is a file in `%LOCALAPPDATA%\turno\secrets` encrypted with DPAPI for the current user, through Windows PowerShell 5.1 with the value on stdin, never in a command line. It needs no admin rights and no native module, has no size limit (Credential Manager caps an item at 2560 bytes), and checking whether an item exists only looks at the file. `turno-browser doctor` now names the secret store in use, and on Windows its folder.
