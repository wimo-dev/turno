---
"turno-browser": minor
---

`browser_batch` checks each step and says why it stopped. An action can carry `expect`: text the page must show after it, text that must be gone, a part of the URL, or the value its target must hold (a field's text, the selected option's label, `"true"` for a checked box), waited for up to `timeout` ms (default 5000). The first action that fails, or whose check does not hold, stops the batch; its error starts with a stable code (the `ELEMENT_*` codes of a diagnosed element, and `INVALID_ACTION`, `TIMEOUT`, `REFUSED`, `CHECK_FAILED`, `ERROR`), its line in the batch says the code, and the result carries a snapshot of the page at the failure, so the agent needs no extra call to see where it stands.
