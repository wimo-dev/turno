import type { ActionKind, HumanCueKind, ScrollDirection } from "./live-effects.js";
import type { StageMode } from "./live-stage.js";
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
    /** Who took the controls by using the agent's own window (an automatic pause). */
    byWindow: string;
    /** Who paused: the side panel in the agent's window. */
    byPanel: string;
    /** Who paused: teach mode, while the person shows a flow. */
    byTeach: string;
    /** An automatic pause: `{by}`; `{s}`: seconds of no input before the agent goes on. */
    tookOver: string;
    /** The step timeline next to the picture. */
    steps: string;
    noSteps: string;
    /** `{action}`: a step as the timeline names it; `{n}`: failures in a row. */
    stuck: string;
    failed: string;
    notRun: string;
    waited: string;
    /** Timeline lines of the pauses. `{by}` as in `paused`; `{t}`: how long. */
    pausedEntry: string;
    stepEntry: string;
    tookOverEntry: string;
    resumedEntry: string;
    nothingChanged: string;
    /** What the timeline and the "Now" card call each tool; a tool missing here shows its own name. */
    actions: Record<string, string>;
    /** The stage over the picture, the state pill and the "Now" card. */
    stage: {
      now: string;
      /** The chip with the identity's name. `{id}`. */
      identity: string;
      /** Before the first step. */
      waiting: string;
      waitingHint: string;
      running: string;
      thinking: string;
      thinkingHint: string;
      /** A gap between two calls in the timeline. `{t}`: how long. */
      thought: string;
      idle: string;
      idleHint: string;
      done: string;
      /** `{n}`: steps; `{t}`: how long the run took. */
      doneHint: string;
      /** A typing step: `{n}` characters, never which. */
      typed: string;
      fromVault: string;
      scroll: Record<ScrollDirection, string>;
      /** `{name}`: the file. */
      download: string;
      /** The state pill while a step of this kind runs. */
      kinds: Record<ActionKind, string>;
      /** The card when the agent waits for the person, by what for. */
      human: Record<HumanCueKind, string>;
      humanHint: string;
      /** The card's button: ends the step and hands the browser back. */
      humanDone: string;
      takeOver: string;
      /** `{t}`: how long the person had the browser. */
      backAfter: string;
      looksStuck: string;
      /** `{code}`: a failure's stable code. */
      failedCode: string;
      failedPlain: string;
      /** A click the last-click rule left to the person: not a failure. */
      handed: string;
      /** `{what}`: the button or what the click does ("Pay $110.50"). */
      handedLine: string;
      handedPlain: string;
      /** The header's effects control, remembered per viewer. */
      effects: string;
      effectsLevel: Record<StageMode, string>;
      /** What each mode draws, as the button's tooltip. */
      effectsHint: Record<StageMode, string>;
      /** The header chip with the agent's name. */
      agentTitle: string;
      /** A step's tab is not the one shown. */
      otherTab: string;
    };
    /** The side panel in the agent's own Chrome window (`extension/panel.js`). */
    panel: {
      title: string;
      waitingHint: string;
      humanHint: string;
      takeOverHint: string;
      /** Next to "I am done" on a person step. */
      doneHint: string;
      openLive: string;
      openLiveHint: string;
      disconnected: string;
      /** The server's answer when no browser can show the live view. */
      noLiveWindow: string;
    };
    /** Teach mode (`teach.ts`): the person shows a flow once in the side panel's window. */
    teach: {
      button: string;
      buttonHint: string;
      namePrompt: string;
      /** What a flow name may hold. */
      nameHint: string;
      start: string;
      cancel: string;
      teaching: string;
      teachingHint: string;
      stop: string;
      review: string;
      reviewHint: string;
      save: string;
      discard: string;
      remove: string;
      rename: string;
      /** How a typed value is kept: a parameter with what was typed as its default. */
      param: string;
      fixed: string;
      sensitive: string;
      /** A value that is never kept (a password, a code, a file). */
      locked: string;
      /** "typed {n} characters" */
      chars: string;
      noSteps: string;
      /** {name} {n} */
      saved: string;
      savedHint: string;
      close: string;
      /** The server's answers. {name} */
      already: string;
      exists: string;
      /** {prefix} */
      autoName: string;
      /** {url} */
      badUrl: string;
      noBrowser: string;
      noEngine: string;
      none: string;
      /** Step words that the timeline has none for. */
      login: string;
      newTab: string;
      toTab: string;
      check: string;
      uncheck: string;
      upload: string;
      key: string;
    };
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
  /** The banner of a click turno left to the person (`last-click.ts`): its title and what the click does. */
  lastClick: {
    title: string;
    purchase: string;
    send: string;
    publish: string;
    delete: string;
    /** Under what the click does. */
    hint: string;
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
      resume: "Hand back",
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
        "Click, scroll and type on the picture to act on the page. Press Hand back when you are done; the agent is told what changed.",
      helpRunning:
        "Click, scroll or type on the picture to take the controls: the agent waits until you stop or press Hand back. Pause keeps them until you hand back (a call waits up to {s} s).",
      helpNoView: "Pause and resume still work: the agent's next call waits until you resume.",
      disconnected: "Disconnected: the server stopped or restarted. Open the view again with turno-browser live.",
      pauseFirst: "Pause first: your input goes to the page only while the agent waits.",
      busy: "A call that started before the pause is still running; try again when it ends.",
      noTab: "There is no tab to send it to.",
      noSuchTab: "no such tab (it may have closed)",
      hiddenInput: "This page holds a vault or sensitive value, so the view hides it; use the browser window for it.",
      denied: "This live view needs a fresh link. Run {command}: it opens one that works once.",
      byWindow: "you, in the browser window",
      byPanel: "the side panel",
      byTeach: "teach mode",
      tookOver:
        "You have the controls ({by}). The agent goes on {s} s after your last input, or when you press Hand back.",
      steps: "Steps",
      noSteps: "Each step of the agent shows up here.",
      stuck: "Looks stuck: {action} failed {n} times in a row.",
      failed: "failed",
      notRun: "not run: the page changed while you had it",
      waited: "after waiting for you",
      pausedEntry: "Paused ({by})",
      stepEntry: "Your turn",
      tookOverEntry: "You took the controls ({by})",
      resumedEntry: "Back to the agent after {t}",
      nothingChanged: "Nothing changed in the tabs.",
      actions: {
        browser_navigate: "Open",
        browser_navigate_back: "Go back",
        browser_click: "Click",
        browser_type: "Type into",
        browser_fill_form: "Fill",
        browser_select_option: "Choose in",
        browser_press_key: "Press",
        browser_hover: "Point at",
        browser_drag: "Drag",
        browser_snapshot: "Read the page",
        browser_take_screenshot: "Take a screenshot",
        browser_tabs: "Tabs:",
        browser_wait_for: "Wait",
        browser_file_upload: "Upload a file",
        browser_handle_dialog: "Answer a dialog",
        browser_evaluate: "Run a script",
        browser_close: "Close the tab",
        browser_resize: "Resize the window",
        browser_request_human: "Your turn:",
        browser_login: "Sign in",
        browser_batch: "Run",
        browser_replay: "Replay a flow",
        browser_act: "Do",
        browser_extract: "Read",
        browser_observe: "Look for",
        browser_solve_captcha: "Solve a captcha",
        browser_navigate_forward: "Go forward",
        browser_reload: "Reload",
        browser_read: "Read",
        browser_find: "Locate an element",
        browser_generate_locator: "Locate an element",
        browser_verify_element_visible: "Check an element",
        browser_verify_list_visible: "Check a list",
        browser_verify_text_visible: "Check a text",
        browser_verify_value: "Check a value",
        browser_mouse_click_xy: "Click at a point",
        browser_mouse_down: "Press the mouse button",
        browser_mouse_up: "Release the mouse button",
        browser_mouse_move_xy: "Move the pointer",
        browser_mouse_wheel: "Scroll",
        browser_mouse_drag_xy: "Drag",
        browser_press_sequentially: "Type into",
        browser_keydown: "Hold a key",
        browser_keyup: "Release a key",
        browser_check: "Check",
        browser_uncheck: "Uncheck",
        browser_drop: "Drop a file",
        browser_run_code_unsafe: "Run code",
      },
      stage: {
        now: "Now",
        identity: "identity: {id}",
        waiting: "Waiting for the agent",
        waitingHint: "Each action shows on the picture, in its own color, and in the steps below.",
        running: "Running",
        thinking: "Thinking",
        thinkingHint: "The model is deciding the next step.",
        thought: "Thought for {t}",
        idle: "Idle",
        idleHint: "The agent is not using the browser now.",
        done: "Done",
        doneHint: "{n} steps in {t}.",
        typed: "typed {n} characters",
        fromVault: "a value from the vault, never shown",
        scroll: { up: "up", down: "down", left: "left", right: "right" },
        download: "Downloaded {name}",
        kinds: {
          navigate: "Navigating",
          read: "Reading the page",
          locate: "Looking for an element",
          click: "Clicking",
          hover: "Pointing",
          type: "Typing",
          select: "Choosing",
          scroll: "Scrolling",
          drag: "Dragging",
          upload: "Uploading a file",
          download: "Downloading",
          dialog: "Answering a dialog",
          wait: "Waiting for the page",
          script: "Running a script",
          tabs: "Working with tabs",
          run: "Running steps",
          human: "Your turn",
          other: "Working",
        },
        human: {
          step: "Your turn",
          "last-click": "The last click is yours",
          passkey: "Use your passkey",
          captcha: "A captcha for you",
        },
        humanHint: "The agent stopped and waits. Act on the picture or in the browser window.",
        humanDone: "I am done",
        takeOver: "You have the controls",
        backAfter: "Back to the agent after {t}",
        looksStuck: "Looks stuck",
        failedCode: "Failed: {code}",
        failedPlain: "Failed",
        handed: "Handed to you",
        handedLine: "{what}: the last click is yours",
        handedPlain: "The last click is yours",
        effects: "Effects",
        effectsLevel: { full: "Full", balanced: "Balanced", calm: "Calm" },
        effectsHint: {
          full: "Every effect, and a field of pixels around the window",
          balanced: "Pixels only where the agent acts, and nothing drawn between actions",
          calm: "Plain boxes and ripples in the colors of each action, no pixels",
        },
        agentTitle: "The agent",
        otherTab: "in another tab",
      },
      panel: {
        title: "turno: what the agent does",
        waitingHint: "Each step of the agent shows here, as it happens.",
        humanHint: "The agent stopped and waits for you. Do it on the page.",
        takeOverHint:
          "You are using the page. The agent goes on a few seconds after you stop, or when you press Hand back.",
        doneHint: "when you have finished on the page",
        openLive: "Live view",
        openLiveHint: "Open the live view in a window of its own",
        disconnected: "Disconnected from turno-browser. It connects again when the agent's server runs.",
        noLiveWindow: "No Chromium browser was found to show the live view; run turno-browser live <id> instead.",
      },
      teach: {
        button: "Teach a flow",
        buttonHint: "Show the agent a task once, in this window; it is saved as a flow the agent can run again",
        namePrompt: "Name of the flow",
        nameHint: "Lowercase letters, digits, - and _, for example submit-timesheet",
        start: "Start",
        cancel: "Cancel",
        teaching: "Teaching {name}",
        teachingHint:
          "Do the task in this window as usual. Each click, field and key shows below. The agent waits until you save.",
        stop: "Stop",
        review: "Review {name}",
        reviewHint:
          "Rename a step, choose how each value is kept, drop the steps you do not want, then save. Values you typed are never shown here.",
        save: "Save flow",
        discard: "Discard",
        remove: "Remove step",
        rename: "Name of the step",
        param: "Ask each run, typed value as default",
        fixed: "Always this value",
        sensitive: "Ask each run, keep no value",
        locked: "Never kept: asked at each run",
        chars: "typed {n} characters",
        noSteps: "No steps yet. Click, type or open a page in this window.",
        saved: "Saved {name} with {n} steps",
        savedHint: "The agent can run it with browser_replay, and you with turno-browser replay.",
        close: "Close",
        already: "Teach mode already shows flow {name}.",
        exists: "A flow named {name} exists; pick another name.",
        autoName: "Names that start with {prefix} are kept for the identity's own recordings.",
        badUrl: "{url} is not an http or https address.",
        noBrowser: "The browser is not running; turno-browser teach <id> starts it.",
        noEngine: "Teach mode needs turno's own Chrome: not attach mode, Lightpanda or Camoufox.",
        none: "Teach mode is not on.",
        login: "Sign in to",
        newTab: "Open a new tab",
        toTab: "Go to tab",
        check: "Check",
        uncheck: "Uncheck",
        upload: "Upload a file, given at each run",
        key: "Press",
      },
    },
    step: {
      title: "Your turn",
      done: "Done",
      hintDone: "The agent is waiting for you. Press Done when you have finished.",
      hintAuto: "The agent is waiting for you and goes on by itself once this step is done.",
    },
    lastClick: {
      title: "The last click is yours",
      purchase: "This click places the order or makes the payment.",
      send: "This click sends it in your name.",
      publish: "This click publishes it in your name.",
      delete: "This click deletes it for good.",
      hint: "Check it, then click it yourself if it is right. The agent goes on once you have.",
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
      resume: "Devolver el control",
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
      noView: "En este modo la página no se puede ver aquí. Pausar y Devolver el control siguen funcionando.",
      hidden: "Oculta: esta página tiene una contraseña u otro dato privado. Se verá otra vez cuando cambie de página.",
      notStarted: "Aún no hay nada que ver. Aparecerá cuando el agente abra el navegador.",
      helpPaused:
        "Haz clic, desplázate y escribe sobre la imagen para usar la página. Cuando termines, presiona Devolver el control y el agente sabrá qué cambió.",
      helpRunning:
        "Haz clic, desplázate o escribe sobre la imagen para tomar el control: el agente espera hasta que te detengas o presiones Devolver el control. Pausar te deja el control hasta que lo devuelvas (cada acción espera hasta {s} s).",
      helpNoView:
        "Pausar y Devolver el control siguen funcionando: el agente espera hasta que le devuelvas el control.",
      disconnected: "Se perdió la conexión. Abre la vista en vivo otra vez.",
      pauseFirst: "Primero presiona Pausar: lo que hagas llega a la página solo mientras el agente espera.",
      busy: "El agente está terminando algo que empezó antes de la pausa. Intenta otra vez en un momento.",
      noTab: "No hay ninguna pestaña abierta.",
      noSuchTab: "Esa pestaña ya no está; quizá se cerró.",
      hiddenInput:
        "Esta página tiene una contraseña u otro dato privado, por eso aquí no se ve. Usa la ventana del navegador.",
      denied: "Este enlace ya no sirve. Pide uno nuevo con {command}: cada enlace funciona una sola vez.",
      byWindow: "tú, en la ventana del navegador",
      byPanel: "el panel lateral",
      byTeach: "el modo enseñar",
      tookOver:
        "Tú tienes el control ({by}). El agente sigue {s} s después de lo último que hagas, o cuando presiones Devolver el control.",
      steps: "Pasos",
      noSteps: "Aquí aparece cada paso del agente.",
      stuck: "Parece atorado: {action} falló {n} veces seguidas.",
      failed: "falló",
      notRun: "no se hizo: la página cambió mientras la usabas",
      waited: "después de esperarte",
      pausedEntry: "En pausa ({by})",
      stepEntry: "Tu turno",
      tookOverEntry: "Tomaste el control ({by})",
      resumedEntry: "De vuelta al agente tras {t}",
      nothingChanged: "Nada cambió en las pestañas.",
      actions: {
        browser_navigate: "Abrir",
        browser_navigate_back: "Volver",
        browser_click: "Clic en",
        browser_type: "Escribir en",
        browser_fill_form: "Llenar",
        browser_select_option: "Elegir en",
        browser_press_key: "Presionar",
        browser_hover: "Señalar",
        browser_drag: "Arrastrar",
        browser_snapshot: "Leer la página",
        browser_take_screenshot: "Tomar una captura",
        browser_tabs: "Pestañas:",
        browser_wait_for: "Esperar",
        browser_file_upload: "Subir un archivo",
        browser_handle_dialog: "Responder un diálogo",
        browser_evaluate: "Ejecutar un script",
        browser_close: "Cerrar la pestaña",
        browser_resize: "Cambiar el tamaño",
        browser_request_human: "Tu turno:",
        browser_login: "Iniciar sesión",
        browser_batch: "Ejecutar",
        browser_replay: "Repetir un flujo",
        browser_act: "Hacer",
        browser_extract: "Leer",
        browser_observe: "Buscar",
        browser_solve_captcha: "Resolver un captcha",
        browser_navigate_forward: "Avanzar",
        browser_reload: "Recargar",
        browser_read: "Leer",
        browser_find: "Localizar un elemento",
        browser_generate_locator: "Localizar un elemento",
        browser_verify_element_visible: "Comprobar un elemento",
        browser_verify_list_visible: "Comprobar una lista",
        browser_verify_text_visible: "Comprobar un texto",
        browser_verify_value: "Comprobar un valor",
        browser_mouse_click_xy: "Clic en un punto",
        browser_mouse_down: "Presionar el botón del mouse",
        browser_mouse_up: "Soltar el botón del mouse",
        browser_mouse_move_xy: "Mover el puntero",
        browser_mouse_wheel: "Desplazar",
        browser_mouse_drag_xy: "Arrastrar",
        browser_press_sequentially: "Escribir en",
        browser_keydown: "Mantener una tecla",
        browser_keyup: "Soltar una tecla",
        browser_check: "Marcar",
        browser_uncheck: "Desmarcar",
        browser_drop: "Soltar un archivo",
        browser_run_code_unsafe: "Ejecutar código",
      },
      stage: {
        now: "Ahora",
        identity: "identidad: {id}",
        waiting: "Esperando al agente",
        waitingHint: "Cada acción aparece sobre la imagen, con su color, y en los pasos de abajo.",
        running: "En curso",
        thinking: "Pensando",
        thinkingHint: "El modelo decide el siguiente paso.",
        thought: "Pensó {t}",
        idle: "En espera",
        idleHint: "El agente no está usando el navegador.",
        done: "Listo",
        doneHint: "{n} pasos en {t}.",
        typed: "escribió {n} caracteres",
        fromVault: "un valor de la bóveda, nunca visible",
        scroll: { up: "hacia arriba", down: "hacia abajo", left: "a la izquierda", right: "a la derecha" },
        download: "Descargó {name}",
        kinds: {
          navigate: "Navegando",
          read: "Leyendo la página",
          locate: "Buscando un elemento",
          click: "Haciendo clic",
          hover: "Señalando",
          type: "Escribiendo",
          select: "Eligiendo",
          scroll: "Desplazando",
          drag: "Arrastrando",
          upload: "Subiendo un archivo",
          download: "Descargando",
          dialog: "Respondiendo un diálogo",
          wait: "Esperando a la página",
          script: "Ejecutando un script",
          tabs: "Usando las pestañas",
          run: "Ejecutando pasos",
          human: "Tu turno",
          other: "Trabajando",
        },
        human: {
          step: "Tu turno",
          "last-click": "El último clic es tuyo",
          passkey: "Usa tu passkey",
          captcha: "Un captcha para ti",
        },
        humanHint: "El agente se detuvo y te espera. Actúa sobre la imagen o en la ventana del navegador.",
        humanDone: "Ya terminé",
        takeOver: "Tú tienes el control",
        backAfter: "De vuelta al agente tras {t}",
        looksStuck: "Parece atorado",
        failedCode: "Falló: {code}",
        failedPlain: "Falló",
        handed: "En tus manos",
        handedLine: "{what}: el último clic es tuyo",
        handedPlain: "El último clic es tuyo",
        effects: "Efectos",
        effectsLevel: { full: "Completos", balanced: "Equilibrados", calm: "Tranquilos" },
        effectsHint: {
          full: "Todos los efectos, y un campo de píxeles alrededor de la ventana",
          balanced: "Píxeles solo donde actúa el agente, y nada entre acciones",
          calm: "Recuadros y ondas simples en el color de cada acción, sin píxeles",
        },
        agentTitle: "El agente",
        otherTab: "en otra pestaña",
      },
      panel: {
        title: "turno: lo que hace el agente",
        waitingHint: "Cada paso del agente aparece aquí, mientras ocurre.",
        humanHint: "El agente se detuvo y te espera. Hazlo en la página.",
        takeOverHint:
          "Estás usando la página. El agente sigue unos segundos después de que pares, o cuando presiones Devolver el control.",
        doneHint: "cuando termines en la página",
        openLive: "Vista en vivo",
        openLiveHint: "Abre la vista en vivo en una ventana aparte",
        disconnected:
          "Sin conexión con turno-browser. Vuelve a conectarse cuando el servidor del agente esté en marcha.",
        noLiveWindow:
          "No se encontró un navegador Chromium para mostrar la vista en vivo; usa turno-browser live <id> en su lugar.",
      },
      teach: {
        button: "Enseñar un flujo",
        buttonHint:
          "Muéstrale al agente una tarea una vez, en esta ventana; se guarda como un flujo que el agente puede repetir",
        namePrompt: "Nombre del flujo",
        nameHint: "Minúsculas, dígitos, - y _, por ejemplo enviar-horas",
        start: "Empezar",
        cancel: "Cancelar",
        teaching: "Enseñando {name}",
        teachingHint:
          "Haz la tarea en esta ventana como siempre. Cada clic, campo y tecla aparece abajo. El agente espera hasta que guardes.",
        stop: "Terminar",
        review: "Revisa {name}",
        reviewHint:
          "Cambia el nombre de un paso, elige cómo se guarda cada valor, quita los pasos que sobran y guarda. Lo que escribiste nunca se muestra aquí.",
        save: "Guardar flujo",
        discard: "Descartar",
        remove: "Quitar paso",
        rename: "Nombre del paso",
        param: "Preguntar cada vez, con lo escrito como valor inicial",
        fixed: "Siempre este valor",
        sensitive: "Preguntar cada vez, sin guardar el valor",
        locked: "Nunca se guarda: se pide en cada ejecución",
        chars: "{n} caracteres escritos",
        noSteps: "Aún no hay pasos. Haz clic, escribe o abre una página en esta ventana.",
        saved: "Se guardó {name} con {n} pasos",
        savedHint: "El agente lo repite con browser_replay, y tú con turno-browser replay.",
        close: "Cerrar",
        already: "El modo enseñar ya muestra el flujo {name}.",
        exists: "Ya existe un flujo llamado {name}; elige otro nombre.",
        autoName: "Los nombres que empiezan con {prefix} son para las grabaciones de la identidad.",
        badUrl: "{url} no es una dirección http o https.",
        noBrowser: "El navegador no está abierto; turno-browser teach <id> lo abre.",
        noEngine: "El modo enseñar necesita el Chrome de turno: no el modo attach, Lightpanda ni Camoufox.",
        none: "El modo enseñar no está activo.",
        login: "Iniciar sesión en",
        newTab: "Abrir una pestaña nueva",
        toTab: "Ir a la pestaña",
        check: "Marcar",
        uncheck: "Desmarcar",
        upload: "Subir un archivo, que se pide en cada ejecución",
        key: "Presionar",
      },
    },
    step: {
      title: "Tu turno",
      done: "Listo",
      hintDone: "El agente te está esperando. Presiona Listo cuando termines.",
      hintAuto: "El agente te está esperando y sigue solo cuando termines este paso.",
    },
    lastClick: {
      title: "El último clic es tuyo",
      purchase: "Este clic hace el pedido o el pago.",
      send: "Este clic lo envía a tu nombre.",
      publish: "Este clic lo publica a tu nombre.",
      delete: "Este clic lo borra para siempre.",
      hint: "Revísalo y, si está bien, haz clic tú. El agente sigue cuando lo hagas.",
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
export function uiLocale(settings: Pick<IdentitySettings, "locale" | "languages"> | undefined): UiLocale {
  const tag = (settings?.locale || undefined) ?? settings?.languages?.[0];
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
