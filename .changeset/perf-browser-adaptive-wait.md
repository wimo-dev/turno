---
"turno-browser": patch
---

The wait after a click, key press or typed text now ends as soon as the page is done with the action: the requests it started have answered (or none started within 100 ms), a navigation has reached DOMContentLoaded, and nothing on the page changed for two animation frames, checked in an isolated world the page cannot see. Playwright's fixed wait (`settle`, 500 ms by default, twice when the action made requests) is now only the limit. On the local evaluation suite a click went from 617 ms to 169 ms at the median (1,151 to 367 ms at p95), and the form, shadow DOM and iframe tasks took about a quarter of the time. Camoufox and read mode keep Playwright's wait.

Action errors that name what is in the way start with a stable code (`ELEMENT_COVERED`, `ELEMENT_HIDDEN`, `ELEMENT_DISABLED`, `ELEMENT_READONLY`, `ELEMENT_GONE`, `ELEMENT_NOT_STABLE`), which JSON results carry as `code` with the covering element as `cover`, and a target below the fold under a full-page banner is named before the call instead of after the 5 second action timeout. A click that opens a `confirm()` or `alert()` dialog no longer hangs until the client's timeout, and a page that closes its own tab right after an action returns the tab now current instead of an error.
