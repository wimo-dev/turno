import type { IdentitySettings } from "./settings.js";

/**
 * Every text a person sees in the browser, by language: the live view page, the person step's
 * banner, the agent cursor's badge and the welcome page of a login. CLI output, tool
 * descriptions and tool results stay in English: agents and developers read them.
 *
 * The language follows the identity's `locale` (else its first `languages` entry): any Spanish
 * tag (es, es-MX, es-419) gives Spanish, anything else English. The locale already says which
 * language the person reads, and it sets Chrome's own language too, so one setting decides both.
 *
 * `{name}`-style placeholders are filled where the text is shown. Each table must have every key
 * of `UiStrings`: a missing or extra key is a type error.
 */

export type UiLocale = "en" | "es";

export interface UiStrings {
  /** The live view page (`live-page.ts`). */
  live: {
    title: string;
    heading: string;
    connecting: string;
    pause: string;
    resume: string;
    tabs: string;
    frameAlt: string;
    /** `{by}`: one of `byView`, `byStep`, or the CLI command that paused. */
    paused: string;
    byView: string;
    byStep: string;
    waitingOne: string;
    /** `{n}`: how many calls wait. */
    waitingMany: string;
    stillRunning: string;
    yourControls: string;
    working: string;
    idle: string;
    noBrowser: string;
    follow: string;
    blank: string;
    /** `{reason}`: why this engine shows no pixels, as the server says it (in English). */
    noView: string;
    hidden: string;
    notStarted: string;
    helpPaused: string;
    /** `{s}`: how many seconds one call waits. */
    helpRunning: string;
    helpNoView: string;
    disconnected: string;
    pauseFirst: string;
    /** The server's answers to the page's input and tab picks (`live-server.ts`). */
    busy: string;
    noTab: string;
    noSuchTab: string;
    hiddenInput: string;
    /** The page a browser without the view's cookie gets. `{command}`: the command that opens a new link. */
    denied: string;
  };
  /** The person step's banner (`human-step.ts`). */
  step: {
    title: string;
    done: string;
    /** Under the instruction, with a Done button. */
    hintDone: string;
    /** Under the instruction, without one (the step ends by itself). */
    hintAuto: string;
  };
  /** The banner of a page's passkey prompt (`passkey.ts`), in place of the step's title and hint. */
  passkey: {
    title: string;
    instruction: string;
    /** Under the instruction, with a Done button. */
    hint: string;
  };
  /** The agent cursor (`agent-cursor.ts`). */
  cursor: {
    /** The name of an agent that sent none. */
    agent: string;
    working: string;
    /** `{name}`: the agent's name. */
    workingAs: string;
    paused: string;
  };
  /** The page a login opens without --url (`login.ts`). `{id}`: the identity; `{command}`: the login command. */
  welcome: {
    title: string;
    identity: string;
    heading: string;
    steps: [string, string, string];
    next: string;
  };
}

export const UI_STRINGS: Record<UiLocale, UiStrings> = {
  en: {
    live: {
      title: "turno live view",
      heading: "turno live",
      connecting: "Connecting...",
      pause: "Pause",
      resume: "Resume",
      tabs: "Tabs",
      frameAlt: "The agent's tab",
      paused: "Paused ({by}). ",
      byView: "the live view",
      byStep: "your turn",
      waitingOne: "1 agent call is waiting. ",
      waitingMany: "{n} agent calls are waiting. ",
      stillRunning: "A call that started before the pause is still running.",
      yourControls: "You have the controls.",
      working: "The agent is working.",
      idle: "The agent is idle.",
      noBrowser: " The browser is not running.",
      follow: "Follow the agent",
      blank: "(blank)",
      noView: "{reason}",
      hidden: "Hidden: this page holds a vault or sensitive value. It shows again after the page navigates.",
      notStarted: "Nothing to show until the agent opens the browser.",
      helpPaused:
        "Click, scroll and type on the picture to act on the page. Resume when you are done; the agent is told what changed.",
      helpRunning: "Pause to take the controls: the agent's next call waits until you resume (up to {s} s per call).",
      helpNoView: "Pause and resume still work: the agent's next call waits until you resume.",
      disconnected: "Disconnected: the server stopped or restarted. Open the view again with turno-browser live.",
      pauseFirst: "Pause first: your input goes to the page only while the agent waits.",
      busy: "A call that started before the pause is still running; try again when it ends.",
      noTab: "There is no tab to send it to.",
      noSuchTab: "no such tab (it may have closed)",
      hiddenInput: "This page holds a vault or sensitive value, so the view hides it; use the browser window for it.",
      denied: "This live view needs a fresh link. Run {command}: it opens one that works once.",
    },
    step: {
      title: "Your turn",
      done: "Done",
      hintDone: "The agent is waiting for you. Press Done when you have finished.",
      hintAuto: "The agent is waiting for you and goes on by itself once this step is done.",
    },
    passkey: {
      title: "Use your passkey",
      instruction: "This page asks for your passkey.",
      hint: "Confirm with Touch ID, your phone or your security key in Chrome's passkey window. If no such window shows, press Done.",
    },
    cursor: {
      agent: "Agent",
      working: "turno · agent at work",
      workingAs: "turno · {name} at work",
      paused: "paused · you have the controls",
    },
    welcome: {
      title: "Sign in: {id}",
      identity: "identity",
      heading: "This is the Chrome your agent will use.",
      steps: [
        "Type the address of a site your agent needs in the bar above, and sign in as you always do.",
        "Do the same for every site it needs, in this window or in new tabs.",
        "Close the window when you are done. The cookies stay in this profile, and the agent starts signed in.",
      ],
      next: "Next time you can open a site directly: {command}",
    },
  },
  es: {
    live: {
      title: "turno en vivo",
      heading: "turno en vivo",
      connecting: "Conectando...",
      pause: "Pausar",
      resume: "Reanudar",
      tabs: "Pestañas",
      frameAlt: "La pestaña del agente",
      paused: "En pausa ({by}). ",
      byView: "vista en vivo",
      byStep: "tu turno",
      waitingOne: "1 acción del agente está en espera. ",
      waitingMany: "{n} acciones del agente están en espera. ",
      stillRunning: "El agente está terminando algo que empezó antes de la pausa.",
      yourControls: "Tú tienes el control.",
      working: "El agente está trabajando.",
      idle: "El agente no está haciendo nada.",
      noBrowser: " El navegador no está abierto.",
      follow: "Seguir al agente",
      blank: "(en blanco)",
      noView: "En este modo la página no se puede ver aquí. Pausar y Reanudar siguen funcionando.",
      hidden: "Oculta: esta página tiene una contraseña u otro dato privado. Se verá otra vez cuando cambie de página.",
      notStarted: "Aún no hay nada que ver. Aparecerá cuando el agente abra el navegador.",
      helpPaused:
        "Haz clic, desplázate y escribe sobre la imagen para usar la página. Cuando termines, presiona Reanudar y el agente sabrá qué cambió.",
      helpRunning:
        "Presiona Pausar para tomar el control: el agente espera hasta que presiones Reanudar (hasta {s} s).",
      helpNoView: "Pausar y Reanudar siguen funcionando: el agente espera hasta que presiones Reanudar.",
      disconnected: "Se perdió la conexión. Abre la vista en vivo otra vez.",
      pauseFirst: "Primero presiona Pausar: lo que hagas llega a la página solo mientras el agente espera.",
      busy: "El agente está terminando algo que empezó antes de la pausa. Intenta otra vez en un momento.",
      noTab: "No hay ninguna pestaña abierta.",
      noSuchTab: "Esa pestaña ya no está; quizá se cerró.",
      hiddenInput:
        "Esta página tiene una contraseña u otro dato privado, por eso aquí no se ve. Usa la ventana del navegador.",
      denied: "Este enlace ya no sirve. Pide uno nuevo con {command}: cada enlace funciona una sola vez.",
    },
    step: {
      title: "Tu turno",
      done: "Listo",
      hintDone: "El agente te está esperando. Presiona Listo cuando termines.",
      hintAuto: "El agente te está esperando y sigue solo cuando termines este paso.",
    },
    passkey: {
      title: "Usa tu passkey",
      instruction: "Esta página te pide tu passkey.",
      hint: "Confirma con Touch ID, tu teléfono o tu llave de seguridad en la ventana de Chrome. Si no aparece esa ventana, presiona Listo.",
    },
    cursor: {
      agent: "Agente",
      working: "turno · agente trabajando",
      workingAs: "turno · {name} trabajando",
      paused: "En pausa · tú tienes el control",
    },
    welcome: {
      title: "Inicia sesión: {id}",
      identity: "identidad",
      heading: "Este es el Chrome que va a usar tu agente.",
      steps: [
        "Escribe en la barra de arriba la dirección de un sitio que tu agente necesita e inicia sesión como siempre.",
        "Haz lo mismo con cada sitio que necesite, en esta ventana o en pestañas nuevas.",
        "Cuando termines, cierra la ventana. Tus sesiones quedan guardadas en este perfil y el agente empieza con ellas.",
      ],
      next: "La próxima vez puedes abrir un sitio directamente: {command}",
    },
  },
};

/** The language of what the person sees, from the identity's `locale`, else its first language. */
export function uiLocale(
  settings: Pick<IdentitySettings, "locale" | "languages"> | undefined,
  /** The locale the defaults resolved (the system's), for an identity.json without one. */
  fallback?: string,
): UiLocale {
  const tag = (settings?.locale || undefined) ?? settings?.languages?.[0] ?? fallback;
  return tag?.split("-")[0]?.toLowerCase() === "es" ? "es" : "en";
}

/** The strings of a language. */
export function uiStrings(locale: UiLocale = "en"): UiStrings {
  return UI_STRINGS[locale];
}

/** Fills `{key}` placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}
