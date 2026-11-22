import type { Headline, Lang, SectionCopy } from "../landing/copy";
import type { ChapterCommand } from "../landing/chapters/section";

/*
 * The words of the turno-browser page (/browser), in English and Spanish, and every command it
 * shows. Commands and the lines a tool prints are the same in both languages, so they live in
 * CMD and PRINTS: check each against `turno-browser --help` and the package's source before the
 * page ships.
 */

/** Every command on the page, as typed. */
export const CMD = {
  install: "npm install --global turno-browser",
  init: "turno-browser init",
  add: "turno-browser add school",
  login: "turno-browser login school",
  set: "turno-browser set school --tabs-max 12 --tabs-park 10m",
  vaultAdd: "turno-browser vault add school campus --url https://campus.example.edu/login --username me --totp",
  /** The same command as it reads under the picture, where the whole line does not fit. */
  vaultAddShort: "turno-browser vault add school campus ...",
  export: "turno-browser export school --out school.session",
  sharing: "turno-browser set school --sharing tabs",
  replay: "turno-browser replay school sign-in",
  live: "turno-browser live school",
  setup: "turno-browser setup claude-code",
  doSnapshot: "turno-browser do school snapshot",
  doctor: "turno-browser doctor",
  act: "turno-browser set school --act",
  captcha:
    "turno-browser set school --captcha-provider task-api --captcha-endpoint https://solver.example.com --captcha-key keychain:captcha-solver",
  humanize: "turno-browser set school --humanize light",
  readMode: "turno-browser set school --engine lightpanda",
  attach: "turno-browser set school --attach auto",
  camoufox: "turno-browser set school --engine camoufox",
  record: "turno-browser record school --flows --traces --screenshots",
  userAgent: "turno-browser set school --user-agent coherent",
  lighter: "turno-browser set school --block-trackers true --block-types image,media --cache",
  withTurnoInstall: "npm install --global turno-cli turno-browser",
  withTurnoAdd: "turno identity add browser:school",
} as const;

/** The tools an agent calls, by their MCP names. */
export const TOOL = {
  navigate: "browser_navigate",
  tabs: "browser_tabs",
  login: "browser_login",
} as const;

/** Where an identity lives on disk, and the site the examples sign in to. */
export const IDENTITY_PATH = "~/.local/share/turno/browser/identities/school";
export const SITE = "campus.example.edu";

/** What the commands and tools print, word for word. */
export const PRINTS = {
  added: `identity "school" ready at ${IDENTITY_PATH}`,
  next: "Next: turno-browser login school (sign in to your sites by hand once; the cookies stay in the profile)",
  saved: `Saved. Sites you opened: ${SITE}. The agent starts with the same cookies on them.`,
  opening: `Opening Chrome for identity "school". Sign in to your sites, then close the window to save the session.`,
  capped: "closed the least recently used tab (https://docs.example.com/guide): more than 8 were open",
  parked: "parked a tab unused for 5 minutes on about:blank (https://docs.example.com/api); using it again loads that page",
  closed: "closed a tab unused for 15 minutes (https://docs.example.com/api)",
  filled: `Filled the username, password and one-time code of "campus" from the vault of identity "school" on https://${SITE}. The values are hidden as [vault: ...] in every result.`,
  notSubmitted: "Nothing was submitted: click the sign-in button yourself (it is in the snapshot below).",
} as const;

/** What the reader pastes into a coding agent so it sets turno-browser up for them. */
const PROMPT = {
  en: "Set up turno-browser for me. Run `npm install --global turno-browser`. Ask me what to call the identity, then run `turno-browser init --identity <name> --agent <agent>` with your own agent name (for example claude-code) and run the command it prints. In your session it skips the sign-in, so tell me to run `turno-browser login <name>` myself: I sign in by hand. The docs are at https://turno.wimo.dev/llms.txt.",
  es: "Configura turno-browser por mí. Corre `npm install --global turno-browser`. Pregúntame cómo llamar a la identidad, luego corre `turno-browser init --identity <nombre> --agent <agente>` con el nombre de tu agente (por ejemplo claude-code) y corre el comando que imprime. En tu sesión se salta el inicio de sesión, así que dime que corra yo mismo `turno-browser login <nombre>`: inicio sesión a mano. La documentación está en https://turno.wimo.dev/llms.txt.",
} as const;

export const CHAPTER_IDS = ["identities", "tabs", "vault"] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

/** A chapter of this page: the home page's section, with commands that say how each is entered. */
export interface BrowserChapter extends SectionCopy {
  commands: ChapterCommand[];
}

/** The pictures of the opt-in features, by id. */
export const OPT_IN_IDS = ["live", "sharing", "act", "captcha", "humanize", "read", "attach", "camoufox", "record", "network", "lighter"] as const;
export type OptInId = (typeof OPT_IN_IDS)[number];

export interface Feature {
  title: string;
  text: string;
  /** The command or tool that goes with it, when one does. */
  run?: string;
  more: { text: string; href: string };
}

export interface OptIn extends Feature {
  id: OptInId;
  run: string;
  /** The few words the feature's picture shows, when it shows any. */
  words?: string[];
}

export interface Path {
  title: string;
  text: string;
  commands: { run: string; note: string }[];
  more?: { text: string; href: string };
}

export interface BrowserCopy {
  hero: {
    eyebrow: string;
    headline: Headline;
    /** The second sentence of the line, under the headline. */
    hook: string;
    lead: string;
    docs: string;
    figure: string;
    /** A prompt the reader pastes into their coding agent, and the button that copies it. */
    prompt: { label: string; copied: string; text: string };
    /** The second site of the hero's picture, and its page. */
    later: string;
  };
  pains: { title: string; items: { text: string; to: ChapterId }[] };
  chapters: Record<ChapterId, BrowserChapter>;
  pictures: {
    list: string;
    identities: {
      figure: string;
      you: string;
      agent: string;
      onDisk: string;
      none: string;
      notYet: string;
      byHand: string;
      signedIn: string;
      kept: string;
      arrived: string;
      page: string;
    };
    tabs: {
      figure: string;
      cap: string;
      current: string;
      running: string;
      parked: string;
      later5: string;
      later15: string;
      chromeClosed: string;
      onDisk: string;
      again: string;
      written: string;
      idle: string;
    };
    vault: {
      figure: string;
      keychain: string;
      page: string;
      model: string;
      nothing: string;
      hidden: string;
      username: string;
      password: string;
      code: string;
      stored: string;
      signIn: string;
      notPart: string;
    };
  };
  /** The words of the two small tags: on from the start, and off until turned on. */
  tags: { on: string; optIn: string };
  facts: { title: string; text: string }[];
  included: { label: string; headline: Headline; items: Feature[] };
  optIn: { label: string; headline: Headline; lead: string; items: OptIn[] };
  layers: {
    label: string;
    headline: Headline;
    lead: string;
    figure: string;
    rows: { name: string; items: string[] }[];
    beside: string;
    more: { text: string; href: string };
  };
  setup: { label: string; headline: Headline; alone: Path; withTurno: Path };
  use: { label: string; text: string; more: { text: string; href: string } };
  start: { label: string; headline: Headline; text: string; docs: string; home: string };
}

/** The docs of turno-browser: one page per subject. */
const DOCS = "/docs/browser";

const en: BrowserCopy = {
  hero: {
    eyebrow: "turno-browser · Open source · Apache-2.0 · macOS and Linux",
    headline: ["A browser your agents use with ", "your accounts", "."],
    hook: "It stays light on your machine, and the model never sees your passwords.",
    lead: "An MCP server for Claude Code, Codex, Cursor, Copilot CLI and Gemini CLI. It drives the Google Chrome you already have, with one persistent profile per identity.",
    docs: "Read the docs",
    figure: "A Chrome window of the identity school: signed in, with two pages running and three parked, and a password field whose value is hidden.",
    prompt: {
      label: "Copy a prompt for your agent",
      copied: "Copied. Paste it into your agent.",
      text: PROMPT.en,
    },
    later: "library.example.org",
  },
  pains: {
    title: "Start from your problem",
    items: [
      { text: "My agent opens a browser that is not signed in", to: "identities" },
      { text: "A browser left open eats my machine", to: "tabs" },
      { text: "I do not want a model to see my passwords", to: "vault" },
    ],
  },
  chapters: {
    identities: {
      tab: "identities",
      label: "one profile per identity",
      headline: ["Signed in ", "before the agent arrives", "."],
      lead: "Each identity is a real Chrome profile on your machine. You sign in by hand once and the cookies stay there. The agent opens that same browser afterwards and starts where you left off.",
      commands: [
        { prompt: "$", run: CMD.add, note: "A new identity with its own persistent Chrome profile." },
        { prompt: "$", run: CMD.login, note: "Opens its Chrome. Sign in by hand once, then close the window." },
        { prompt: "tool", run: TOOL.navigate, note: "The agent opens the site in that profile, already signed in.", copyable: false },
      ],
      aside: "The profile holds live cookies. Treat its folder as credentials.",
      more: { text: "Identities and settings", href: `${DOCS}/identities` },
      rest: "no identity yet",
    },
    tabs: {
      tab: "tabs",
      label: "a browser that cleans up",
      headline: ["Left open for hours, it ", "stays light", "."],
      lead: "An agent that browses for an hour leaves dozens of pages behind. turno-browser caps them, parks the ones nobody uses and closes Chrome when no agent is calling it. The next call opens it again with the same profile.",
      commands: [
        { prompt: "tool", run: TOOL.tabs, note: "The agent opens a ninth page. The least recently used one closes, never its current tab.", copyable: false },
        { prompt: "…", run: "5 minutes unused", note: "A page nobody uses goes to a blank page and stops running. It loads again when the agent needs it.", copyable: false },
        { prompt: "…", run: "15 minutes without a call", note: "Chrome closes. The next call opens it again, with the same profile and cookies.", copyable: false },
        { prompt: "$", run: CMD.set, note: "Every limit is a setting of the identity." },
      ],
      aside: "By default: 8 pages, parked after 5 minutes, closed after 15.",
      more: { text: "Tabs and lifecycle", href: `${DOCS}/tabs#tabs` },
      rest: "eight pages open",
    },
    vault: {
      tab: "vault",
      label: "passwords stay out of the model",
      headline: ["The model ", "never sees", " your passwords."],
      lead: "An identity can keep a username, a password and a one-time code secret per site in your system keychain. The agent asks to sign in by the site's name. The tool fills the form, only on that site's own addresses, and hides the values from every later result.",
      commands: [
        { prompt: "$", run: CMD.vaultAdd, note: "The password and the one-time secret are asked with hidden prompts." },
        { prompt: "tool", run: TOOL.login, note: "The agent names the site. The tool fills the username, the password and the current code.", copyable: false },
      ],
      aside: "A password or a one-time code you type yourself stays out too: a snapshot shows [sensitive field]. The tool does not submit the form unless you turn that on for the identity.",
      more: { text: "Credential vault", href: `${DOCS}/vault` },
      rest: "nothing stored yet",
    },
  },
  pictures: {
    list: "Steps: choose one to run it in the picture",
    identities: {
      figure: "The Chrome profile of the identity school, first empty, then signed in by hand, then opened by an agent. Choose a step to run it here.",
      you: "you",
      agent: "agent",
      onDisk: "profile on disk",
      none: "no identity yet",
      notYet: "not signed in yet",
      byHand: "you sign in by hand",
      signedIn: "signed in",
      kept: "cookies kept",
      arrived: "the page opens signed in: the cookies were already in the profile",
      page: "My courses",
    },
    tabs: {
      figure: "The pages open in one identity's Chrome, and what happens to them over time. Choose a step to run it here.",
      cap: "at most",
      current: "the agent's tab",
      running: "running",
      parked: "parked",
      later5: "5 min later",
      later15: "15 min later",
      chromeClosed: "Chrome closed",
      onDisk: "profile and cookies on disk",
      again: "the next call opens Chrome again with the same profile, still signed in",
      written: "written to the identity's settings: at most 12 pages, parked after 10 minutes",
      idle: "15 minutes without a tool call: Chrome closes",
    },
    vault: {
      figure: "A sign-in page, the system keychain that holds its credentials, and what the model sees. Choose a step to run it here.",
      keychain: "system keychain",
      page: "the page",
      model: "what the model sees",
      nothing: "nothing yet",
      hidden: "hidden",
      username: "username",
      password: "password",
      code: "one-time code",
      stored: "kept in the system keychain, never in a file",
      signIn: "Sign in",
      notPart: "The model is not part of this step.",
    },
  },
  tags: { on: "on", optIn: "opt in" },
  facts: [
    { title: "On your machine", text: "No cloud browser and no bill per hour." },
    { title: "The Chrome you have", text: "It drives the Google Chrome on your machine and downloads no browser." },
    { title: "No account, no API key", text: "Install it and it works." },
    { title: "Free and open source", text: "Apache-2.0." },
  ],
  included: {
    label: "on from the start",
    headline: ["Already ", "working", " when you install it."],
    items: [
      {
        title: "See where the agent is",
        text: "When you can see the browser, a cursor with the agent's name glides to each element it acts on, with a ring on the target and a badge on the page. The model never sees it.",
        more: { text: "The agent cursor", href: `${DOCS}/agent-cursor` },
      },
      {
        title: "Fewer round trips, clearer errors",
        text: "`browser_batch` runs up to 20 actions in one call and returns one line per action. A click that fails says which element covers the target, or that it is hidden or disabled, and what to try next.",
        run: "browser_batch",
        more: { text: "Actions", href: `${DOCS}/actions#actions` },
      },
      {
        title: "Record once, replay later",
        text: "An agent saves what it did on a site as a flow and runs it again later without working the page out.",
        run: CMD.replay,
        more: { text: "Flows", href: `${DOCS}/flows#flows-record-and-replay` },
      },
      {
        title: "Take a signed-in session to another machine",
        text: "Cookies, localStorage and IndexedDB in one file, encrypted with a passphrase you type. It expires, and it never holds vault credentials.",
        run: CMD.export,
        more: { text: "Moving a session", href: `${DOCS}/moving-a-session` },
      },
      {
        title: "Drive it from a shell",
        text: "`turno-browser do` runs one tool call from your terminal: open a page, read its tree, click a ref.",
        run: CMD.doSnapshot,
        more: { text: "From the shell", href: `${DOCS}/actions#from-the-shell` },
      },
      {
        title: "A doctor and a reputation log",
        text: "`doctor` checks Chrome and every identity, with a fix for each problem. The log counts the captchas and \"verify it's you\" pages each identity met, per site.",
        run: CMD.doctor,
        more: { text: "Doctor", href: `${DOCS}/identities#doctor` },
      },
    ],
  },
  optIn: {
    label: "opt in",
    headline: ["Off by default. ", "On when you say so", "."],
    lead: "Each of these is a setting of an identity. Nothing below runs until you turn it on, and each one turns off the same way.",
    items: [
      {
        id: "live",
        title: "Watch it work, and take the controls",
        text: "A live view of the agent's tab in your own browser. Pause, and your clicks and keys go to that tab. Resume, and the agent is told what changed.",
        run: CMD.live,
        more: { text: "Live view", href: `${DOCS}/live-view` },
        words: ["follow the agent", "pause", "resume"],
      },
      {
        id: "sharing",
        title: "Several agents, one browser",
        text: "Several agent sessions use one identity's Chrome at once. Each works in its own tabs, never in a tab another session holds.",
        run: CMD.sharing,
        more: { text: "Sharing a browser", href: `${DOCS}/sharing` },
        words: ["session"],
      },
      {
        id: "act",
        title: "Actions in plain words",
        text: "`browser_act` carries out a short instruction on the current tab, `browser_extract` reads data off the page as JSON, and `browser_observe` proposes the calls without running them. The model is yours to pick.",
        run: CMD.act,
        more: { text: "Natural language actions", href: `${DOCS}/natural-language-and-captchas#natural-language-actions` },
        words: ["accept the cookie banner, then open the second result"],
      },
      {
        id: "captcha",
        title: "Captcha solving",
        text: "`browser_solve_captcha` finds a reCAPTCHA v2, hCaptcha or Turnstile widget, sends its public site key and the page address to a solver service you configure, and puts the token back in the page.",
        run: CMD.captcha,
        more: { text: "Captcha solving", href: `${DOCS}/natural-language-and-captchas#captcha-solving` },
        words: ["your solver", "token"],
      },
      {
        id: "humanize",
        title: "Human-like input",
        text: "The pointer travels a curve to a point inside the target, the button stays down for a moment and text is typed key by key. Three levels: light, full and adaptive.",
        run: CMD.humanize,
        more: { text: "Human-like input", href: `${DOCS}/actions#human-like-input` },
      },
      {
        id: "read",
        title: "Read mode",
        text: "Runs the identity on Lightpanda, a headless browser that builds the page without laying it out or drawing it: for reading pages fast and with little memory.",
        run: CMD.readMode,
        more: { text: "Read mode", href: `${DOCS}/engines#read-mode-lightpanda` },
      },
      {
        id: "attach",
        title: "Attach to your own Chrome",
        text: "Connects to the Chrome you already have open instead of launching one, so the agent works in your real, signed-in browser. Chrome asks you to allow each connection.",
        run: CMD.attach,
        more: { text: "Attach", href: `${DOCS}/engines#attach-to-your-chrome` },
      },
      {
        id: "camoufox",
        title: "Camoufox",
        text: "Runs an identity on Camoufox, a Firefox build that sets what the browser reports inside the browser itself, on its own profile. You install it and keep it up to date.",
        run: CMD.camoufox,
        more: { text: "Camoufox", href: `${DOCS}/engines#camoufox` },
      },
      {
        id: "record",
        title: "Recordings and traces",
        text: "Every session's actions saved as a flow, a Playwright trace with DOM snapshots, network and a screencast, and a screenshot after each action.",
        run: CMD.record,
        more: { text: "Recordings and traces", href: `${DOCS}/flows#recordings-and-traces` },
      },
      {
        id: "network",
        title: "A proxy and a coherent user agent",
        text: "Sends an identity through an HTTP or SOCKS proxy, with its password in the system keychain, and builds the user agent from the Chrome you have installed, never from a typed string.",
        run: CMD.userAgent,
        more: { text: "Network and user agent", href: `${DOCS}/network#network-and-user-agent` },
      },
      {
        id: "lighter",
        title: "Lighter pages",
        text: "Blocks the trackers, images, media or fonts you name, and keeps images, fonts, stylesheets and scripts on disk for that identity only.",
        run: CMD.lighter,
        more: { text: "Blocking and the cache", href: `${DOCS}/network#blocking-and-the-resource-cache` },
      },
    ],
  },
  layers: {
    label: "where it sits",
    headline: ["The layer ", "above the driver", "."],
    lead: "A driver moves the browser. turno-browser decides which browser that is, whose session it carries, how long it stays open and what the model gets to see. It works next to browser-use, Stagehand and Browserbase, with Playwright underneath.",
    figure: "Four layers, top to bottom: your agents, turno-browser, the driver and your Chrome.",
    rows: [
      { name: "your agents", items: ["Claude Code", "Codex", "Cursor", "Copilot CLI", "Gemini CLI"] },
      { name: "turno-browser", items: ["identities", "vault", "tabs and lifecycle", "portable sessions", "shared tabs", "record and replay", "live view"] },
      { name: "the driver", items: ["Playwright"] },
      { name: "the browser", items: ["your Google Chrome"] },
    ],
    beside: "Each agent reaches it over MCP.",
    more: { text: "How it compares", href: `${DOCS}/alternatives` },
  },
  setup: {
    label: "two ways in",
    headline: ["On its own, or ", "with turno", "."],
    alone: {
      title: "On its own",
      text: "turno-browser is its own package. Install it, add an identity and point your agent at it.",
      commands: [
        { run: CMD.install, note: "The package and its command." },
        { run: CMD.init, note: "Asks a name for the identity, opens Chrome so you sign in by hand, and gives the identity to Claude Code, Codex, Cursor, Copilot CLI or Gemini CLI." },
      ],
      more: { text: "The same steps, one command at a time", href: `${DOCS}/get-started#add-an-identity` },
    },
    withTurno: {
      title: "With turno",
      text: "turno's gateway runs one browser server for every session of every agent, and stops it when nobody uses it.",
      commands: [
        { run: CMD.withTurnoInstall, note: "Both packages." },
        { run: CMD.withTurnoAdd, note: "The identity and its entry in the gateway." },
      ],
      more: { text: "What turno does", href: "/" },
    },
  },
  use: {
    label: "acceptable use",
    text: "Use it with your own accounts, on sites whose terms allow automated access by you, and at a human pace. Do not use it to get around access controls, paywalls or rate limits, to scrape at scale, or to access accounts that are not yours.",
    more: { text: "Read the full note", href: `${DOCS}/natural-language-and-captchas#acceptable-use` },
  },
  start: {
    label: "start",
    headline: ["Two commands, and ", "your agent is signed in", "."],
    text: "Install it. Then turno-browser init asks a name for the identity, opens Chrome so you sign in by hand, and gives it to your agent.",
    docs: "Read the docs",
    home: "See turno",
  },
};

const es: BrowserCopy = {
  hero: {
    eyebrow: "turno-browser · Código abierto · Apache-2.0 · macOS y Linux",
    headline: ["Un navegador que tus agentes usan con ", "tus cuentas", "."],
    hook: "No carga tu máquina, y el modelo nunca ve tus contraseñas.",
    lead: "Un servidor MCP para Claude Code, Codex, Cursor, Copilot CLI y Gemini CLI. Maneja el Google Chrome que ya tienes, con un perfil persistente por identidad.",
    docs: "Leer la documentación",
    figure: "Una ventana de Chrome de la identidad school: con sesión iniciada, dos páginas activas y tres en pausa, y un campo de contraseña con el valor oculto.",
    prompt: {
      label: "Copiar una instrucción para tu agente",
      copied: "Copiado. Pégalo en tu agente.",
      text: PROMPT.es,
    },
    later: "library.example.org",
  },
  pains: {
    title: "Empieza por tu problema",
    items: [
      { text: "Mi agente abre un navegador sin mi sesión", to: "identities" },
      { text: "Un navegador abierto se come mi máquina", to: "tabs" },
      { text: "No quiero que un modelo vea mis contraseñas", to: "vault" },
    ],
  },
  chapters: {
    identities: {
      tab: "identidades",
      label: "un perfil por identidad",
      headline: ["Con la sesión iniciada ", "antes de que llegue el agente", "."],
      lead: "Cada identidad es un perfil real de Chrome en tu máquina. Inicias sesión a mano una vez y las cookies se quedan ahí. Después el agente abre ese mismo navegador y sigue donde lo dejaste.",
      commands: [
        { prompt: "$", run: CMD.add, note: "Una identidad nueva con su propio perfil persistente de Chrome." },
        { prompt: "$", run: CMD.login, note: "Abre su Chrome. Inicia sesión a mano una vez y cierra la ventana." },
        { prompt: "tool", run: TOOL.navigate, note: "El agente abre el sitio en ese perfil, con la sesión ya iniciada.", copyable: false },
      ],
      aside: "El perfil guarda cookies vivas. Trata su carpeta como credenciales.",
      more: { text: "Identidades y ajustes", href: `${DOCS}/identities` },
      rest: "todavía no hay identidades",
    },
    tabs: {
      tab: "pestañas",
      label: "un navegador que limpia solo",
      headline: ["Abierto por horas, ", "sigue ligero", "."],
      lead: "Un agente que navega una hora deja decenas de páginas abiertas. turno-browser les pone un tope, pausa las que nadie usa y cierra Chrome cuando ningún agente lo llama. La siguiente llamada lo abre otra vez con el mismo perfil.",
      commands: [
        { prompt: "tool", run: TOOL.tabs, note: "El agente abre una novena página. Se cierra la que lleva más tiempo sin usarse, nunca su pestaña actual.", copyable: false },
        { prompt: "…", run: "5 minutos sin uso", note: "Una página que nadie usa pasa a una página en blanco y deja de correr. Se carga de nuevo cuando el agente la necesita.", copyable: false },
        { prompt: "…", run: "15 minutos sin llamadas", note: "Chrome se cierra. La siguiente llamada lo abre otra vez, con el mismo perfil y las mismas cookies.", copyable: false },
        { prompt: "$", run: CMD.set, note: "Cada límite es un ajuste de la identidad." },
      ],
      aside: "Por defecto: 8 páginas, en pausa a los 5 minutos, cerradas a los 15.",
      more: { text: "Pestañas y ciclo de vida", href: `${DOCS}/tabs#tabs` },
      rest: "ocho páginas abiertas",
    },
    vault: {
      tab: "bóveda",
      label: "las contraseñas no pasan por el modelo",
      headline: ["El modelo ", "nunca ve", " tus contraseñas."],
      lead: "Una identidad puede guardar un usuario, una contraseña y el secreto de un código de un solo uso por sitio en el llavero de tu sistema. El agente pide iniciar sesión por el nombre del sitio. La herramienta llena el formulario, solo en las direcciones de ese sitio, y oculta los valores en todos los resultados posteriores.",
      commands: [
        { prompt: "$", run: CMD.vaultAdd, note: "La contraseña y el secreto del código se piden sin mostrarse en pantalla." },
        { prompt: "tool", run: TOOL.login, note: "El agente nombra el sitio. La herramienta llena el usuario, la contraseña y el código vigente.", copyable: false },
      ],
      aside: "Una contraseña o un código que escribas tú tampoco llega al modelo: en el árbol de la página aparece [sensitive field]. La herramienta no envía el formulario a menos que lo actives para la identidad.",
      more: { text: "Bóveda de credenciales", href: `${DOCS}/vault` },
      rest: "todavía no hay nada guardado",
    },
  },
  pictures: {
    list: "Pasos: elige uno para correrlo en la imagen",
    identities: {
      figure: "El perfil de Chrome de la identidad school, primero vacío, luego con la sesión iniciada a mano y después abierto por un agente. Elige un paso para correrlo aquí.",
      you: "tú",
      agent: "agente",
      onDisk: "perfil en disco",
      none: "todavía no hay identidades",
      notYet: "sin sesión todavía",
      byHand: "inicias sesión a mano",
      signedIn: "sesión iniciada",
      kept: "cookies guardadas",
      arrived: "la página abre con la sesión iniciada: las cookies ya estaban en el perfil",
      page: "Mis cursos",
    },
    tabs: {
      figure: "Las páginas abiertas en el Chrome de una identidad y lo que pasa con ellas con el tiempo. Elige un paso para correrlo aquí.",
      cap: "máximo",
      current: "la pestaña del agente",
      running: "activas",
      parked: "en pausa",
      later5: "5 min después",
      later15: "15 min después",
      chromeClosed: "Chrome cerrado",
      onDisk: "perfil y cookies en disco",
      again: "la siguiente llamada abre Chrome otra vez con el mismo perfil, con la sesión iniciada",
      written: "guardado en los ajustes de la identidad: máximo 12 páginas, en pausa a los 10 minutos",
      idle: "15 minutos sin llamadas de herramientas: Chrome se cierra",
    },
    vault: {
      figure: "Una página de inicio de sesión, el llavero del sistema que guarda sus credenciales y lo que ve el modelo. Elige un paso para correrlo aquí.",
      keychain: "llavero del sistema",
      page: "la página",
      model: "lo que ve el modelo",
      nothing: "nada todavía",
      hidden: "oculto",
      username: "usuario",
      password: "contraseña",
      code: "código de un solo uso",
      stored: "guardado en el llavero del sistema, nunca en un archivo",
      signIn: "Iniciar sesión",
      notPart: "El modelo no participa en este paso.",
    },
  },
  tags: { on: "activo", optIn: "opcional" },
  facts: [
    { title: "En tu máquina", text: "Sin navegador en la nube ni cobro por hora." },
    { title: "El Chrome que ya tienes", text: "Maneja el Google Chrome de tu máquina y no descarga ningún navegador." },
    { title: "Sin cuenta ni API key", text: "Lo instalas y funciona." },
    { title: "Gratis y de código abierto", text: "Apache-2.0." },
  ],
  included: {
    label: "activo desde el inicio",
    headline: ["Ya ", "funciona", " cuando lo instalas."],
    items: [
      {
        title: "Mira dónde está el agente",
        text: "Cuando puedes ver el navegador, un cursor con el nombre del agente se desliza a cada elemento sobre el que actúa, con un anillo en el objetivo y una insignia en la página. El modelo nunca lo ve.",
        more: { text: "El cursor del agente", href: `${DOCS}/agent-cursor` },
      },
      {
        title: "Menos idas y vueltas, errores más claros",
        text: "`browser_batch` corre hasta 20 acciones en una llamada y devuelve una línea por acción. Un clic que falla dice qué elemento tapa el objetivo, o que está oculto o deshabilitado, y qué intentar después.",
        run: "browser_batch",
        more: { text: "Acciones", href: `${DOCS}/actions#actions` },
      },
      {
        title: "Graba una vez, repite después",
        text: "Un agente guarda lo que hizo en un sitio como un flujo y lo corre de nuevo sin tener que entender la página otra vez.",
        run: CMD.replay,
        more: { text: "Flujos", href: `${DOCS}/flows#flows-record-and-replay` },
      },
      {
        title: "Lleva una sesión iniciada a otra máquina",
        text: "Cookies, localStorage e IndexedDB en un archivo cifrado con una frase que tú escribes. Caduca, y nunca lleva las credenciales de la bóveda.",
        run: CMD.export,
        more: { text: "Mover una sesión", href: `${DOCS}/moving-a-session` },
      },
      {
        title: "Manéjalo desde la terminal",
        text: "`turno-browser do` corre una llamada de herramienta desde tu terminal: abre una página, lee su árbol, haz clic en una referencia.",
        run: CMD.doSnapshot,
        more: { text: "Desde la terminal", href: `${DOCS}/actions#from-the-shell` },
      },
      {
        title: "Un diagnóstico y un registro de reputación",
        text: "`doctor` revisa Chrome y cada identidad, con un arreglo para cada problema. El registro cuenta los captchas y las páginas de \"verifica que eres tú\" que encontró cada identidad, por sitio.",
        run: CMD.doctor,
        more: { text: "Diagnóstico", href: `${DOCS}/identities#doctor` },
      },
    ],
  },
  optIn: {
    label: "opcional",
    headline: ["Apagado por defecto. ", "Encendido cuando tú digas", "."],
    lead: "Cada una es un ajuste de una identidad. Nada de esto corre hasta que lo enciendes, y se apaga de la misma forma.",
    items: [
      {
        id: "live",
        title: "Míralo trabajar, y toma el control",
        text: "Una vista en vivo de la pestaña del agente en tu propio navegador. Pausa, y tus clics y teclas van a esa pestaña. Reanuda, y al agente se le dice qué cambió.",
        run: CMD.live,
        more: { text: "Vista en vivo", href: `${DOCS}/live-view` },
        words: ["seguir al agente", "pausar", "reanudar"],
      },
      {
        id: "sharing",
        title: "Varios agentes, un navegador",
        text: "Varias sesiones de agentes usan a la vez el Chrome de una identidad. Cada una trabaja en sus propias pestañas, nunca en una que tiene otra sesión.",
        run: CMD.sharing,
        more: { text: "Compartir un navegador", href: `${DOCS}/sharing` },
        words: ["sesión"],
      },
      {
        id: "act",
        title: "Acciones en lenguaje natural",
        text: "`browser_act` ejecuta una instrucción corta en la pestaña actual, `browser_extract` lee datos de la página como JSON y `browser_observe` propone las llamadas sin correrlas. El modelo lo eliges tú.",
        run: CMD.act,
        more: { text: "Acciones en lenguaje natural", href: `${DOCS}/natural-language-and-captchas#natural-language-actions` },
        words: ["acepta el aviso de cookies y abre el segundo resultado"],
      },
      {
        id: "captcha",
        title: "Resolución de captchas",
        text: "`browser_solve_captcha` encuentra un widget de reCAPTCHA v2, hCaptcha o Turnstile, envía su clave pública del sitio y la dirección de la página a un servicio que tú configuras, y pone el token de vuelta en la página.",
        run: CMD.captcha,
        more: { text: "Resolución de captchas", href: `${DOCS}/natural-language-and-captchas#captcha-solving` },
        words: ["tu servicio", "token"],
      },
      {
        id: "humanize",
        title: "Entrada como la de una persona",
        text: "El puntero recorre una curva hasta un punto dentro del objetivo, el botón se queda presionado un momento y el texto se escribe tecla por tecla. Tres niveles: light, full y adaptive.",
        run: CMD.humanize,
        more: { text: "Human-like input", href: `${DOCS}/actions#human-like-input` },
      },
      {
        id: "read",
        title: "Modo lectura",
        text: "Corre la identidad en Lightpanda, un navegador sin ventana que construye la página sin acomodarla ni dibujarla: para leer páginas rápido y con poca memoria.",
        run: CMD.readMode,
        more: { text: "Modo lectura", href: `${DOCS}/engines#read-mode-lightpanda` },
      },
      {
        id: "attach",
        title: "Conéctalo a tu propio Chrome",
        text: "Se conecta al Chrome que ya tienes abierto en lugar de abrir otro, así el agente trabaja en tu navegador real, con tus sesiones. Chrome te pide permitir cada conexión.",
        run: CMD.attach,
        more: { text: "Conectar", href: `${DOCS}/engines#attach-to-your-chrome` },
      },
      {
        id: "camoufox",
        title: "Camoufox",
        text: "Corre una identidad en Camoufox, una versión de Firefox que fija dentro del propio navegador lo que este reporta, en su propio perfil. Tú lo instalas y lo mantienes al día.",
        run: CMD.camoufox,
        more: { text: "Camoufox", href: `${DOCS}/engines#camoufox` },
      },
      {
        id: "record",
        title: "Grabaciones y trazas",
        text: "Las acciones de cada sesión guardadas como un flujo, una traza de Playwright con el DOM, la red y un video de pantalla, y una captura después de cada acción.",
        run: CMD.record,
        more: { text: "Grabaciones y trazas", href: `${DOCS}/flows#recordings-and-traces` },
      },
      {
        id: "network",
        title: "Un proxy y un user agent coherente",
        text: "Manda una identidad por un proxy HTTP o SOCKS, con su contraseña en el llavero del sistema, y arma el user agent a partir del Chrome que tienes instalado, nunca de un texto escrito a mano.",
        run: CMD.userAgent,
        more: { text: "Red y user agent", href: `${DOCS}/network#network-and-user-agent` },
      },
      {
        id: "lighter",
        title: "Páginas más ligeras",
        text: "Bloquea los rastreadores, imágenes, video o fuentes que indiques, y guarda imágenes, fuentes, hojas de estilo y scripts en disco solo para esa identidad.",
        run: CMD.lighter,
        more: { text: "Bloqueo y caché", href: `${DOCS}/network#blocking-and-the-resource-cache` },
      },
    ],
  },
  layers: {
    label: "dónde se ubica",
    headline: ["La capa ", "encima del driver", "."],
    lead: "Un driver mueve el navegador. turno-browser decide qué navegador es, de quién es la sesión que lleva, cuánto tiempo sigue abierto y qué alcanza a ver el modelo. Trabaja junto a browser-use, Stagehand y Browserbase, con Playwright debajo.",
    figure: "Cuatro capas, de arriba abajo: tus agentes, turno-browser, el driver y tu Chrome.",
    rows: [
      { name: "tus agentes", items: ["Claude Code", "Codex", "Cursor", "Copilot CLI", "Gemini CLI"] },
      { name: "turno-browser", items: ["identidades", "bóveda", "pestañas y ciclo de vida", "sesiones portables", "pestañas compartidas", "grabar y repetir", "vista en vivo"] },
      { name: "el driver", items: ["Playwright"] },
      { name: "el navegador", items: ["tu Google Chrome"] },
    ],
    beside: "Cada agente llega a él por MCP.",
    more: { text: "Cómo se compara", href: `${DOCS}/alternatives` },
  },
  setup: {
    label: "dos formas de empezar",
    headline: ["Solo, o ", "con turno", "."],
    alone: {
      title: "Solo",
      text: "turno-browser es su propio paquete. Instálalo, agrega una identidad y conecta tu agente.",
      commands: [
        { run: CMD.install, note: "El paquete y su comando." },
        { run: CMD.init, note: "Pregunta un nombre para la identidad, abre Chrome para que inicies sesión a mano y le da la identidad a Claude Code, Codex, Cursor, Copilot CLI o Gemini CLI." },
      ],
      more: { text: "Los mismos pasos, un comando a la vez", href: `${DOCS}/get-started#add-an-identity` },
    },
    withTurno: {
      title: "Con turno",
      text: "El gateway de turno corre un solo servidor de navegador para todas las sesiones de todos los agentes, y lo detiene cuando nadie lo usa.",
      commands: [
        { run: CMD.withTurnoInstall, note: "Los dos paquetes." },
        { run: CMD.withTurnoAdd, note: "La identidad y su entrada en el gateway." },
      ],
      more: { text: "Qué hace turno", href: "/" },
    },
  },
  use: {
    label: "uso aceptable",
    text: "Úsalo con tus propias cuentas, en sitios cuyos términos te permitan el acceso automatizado, y a ritmo humano. No lo uses para sortear controles de acceso, muros de pago o límites, para extraer datos a gran escala, ni para entrar a cuentas que no son tuyas.",
    more: { text: "Leer la nota completa", href: `${DOCS}/natural-language-and-captchas#acceptable-use` },
  },
  start: {
    label: "empezar",
    headline: ["Dos comandos, y ", "tu agente ya tiene tu sesión", "."],
    text: "Instálalo. Después turno-browser init pregunta un nombre para la identidad, abre Chrome para que inicies sesión a mano y se la da a tu agente.",
    docs: "Leer la documentación",
    home: "Ver turno",
  },
};

const COPY: Record<Lang, BrowserCopy> = { en, es };

export function browserCopy(lang: Lang): BrowserCopy {
  return COPY[lang];
}
