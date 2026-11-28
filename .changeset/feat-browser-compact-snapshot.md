---
"turno-browser": minor
"turno-cli": patch
---

Page snapshots are compact. Every element an agent can act on keeps its ref, and the text a reader needs stays, while wrappers without a name, the destination under a named link, separators, text that repeats a neighbouring button's name, refs on elements nobody acts on and runs of identical rows are left out. Measured with the new `pnpm bench:snapshot --public`: Hacker News 12,238 to 3,786 tokens, a GitHub repository page 18,879 to 7,721, Wikipedia search results 5,842 to 3,040, with every interactive ref kept and the same answers to fixed questions. A page still past about 15,000 tokens once compact (a long Wikipedia article: 128,673 tokens) comes back as a table of contents of its landmarks, headings and text fields with refs and sizes (849 tokens). The new `browser_read` tool reads one part by ref, the whole page compact, or with `full: true` the page as Playwright wrote it. `TURNO_BROWSER_SNAPSHOT=full` in the server's environment turns compaction off; `turno help environment` lists it.
