---
"turno-browser": minor
---

The agent cursor's default (`cursor: "auto"`) is drawn by Chrome now, with nothing in the page: when the browser can be seen (a window, or the live view), Chrome highlights the element the agent acts on and shows a ripple for each click of the agent, painted above the page where no page script can see them. The highlight shows in the live view too and is hidden while the model's screenshot is taken. The named arrow, the ring and the badge drawn in the page are `cursor: "on"`, and the fallback when Chrome refuses the protocol calls. The reputation bench's probe page now reports elements no page script made under `<html>`.
