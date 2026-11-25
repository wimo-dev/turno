---
"turno-browser": minor
---

What a page reads about the browser is now what the same Chrome shows without turno on this computer. The color scheme, reduced motion and contrast follow the system instead of Playwright's light default. A headless Chrome reports the computer's primary display and the window Chrome would open on it (1200x852 on a 1512x982 MacBook screen) instead of a 1280x720 page on an 800x600 screen; a viewport, device or `--window-size` you set still wins. An identity's time zone and locale are set when Chrome starts (`TZ` and `LANG` of its process, `--lang`, `--accept-lang`), so workers read the same values as their page, and without a locale in identity.json Chrome reads the system's language itself, as it does for a person (on macOS that is `es-419` for a Mexican Spanish system, not `es-MX`).

The passkey watch no longer adds a script and a binding to every page: it wraps `navigator.credentials` only on a sign-in page while the agent acts on it, and puts Chrome's own methods back 3 seconds later, so a page reads native methods at load. With human-like input off, a click lands at a point inside its element instead of the exact center, at no cost in time. An identity that names no browser runs Google Chrome from ~/Applications too.
