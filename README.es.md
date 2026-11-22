<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="turno" width="168" height="56">
  </picture>
</p>

<p align="center">
  <b>Cambia de cuenta. Conserva todo lo demás.</b>
</p>

<p align="center">
  <a href="https://turno.wimo.dev/es"><b>turno.wimo.dev</b></a> · <a href="https://turno.wimo.dev/es/docs">Documentación</a> · <a href="https://turno.wimo.dev/docs/releases">Versiones</a> · <a href="README.md">English</a> · Español
</p>

**¿Cambias de cuenta? La conversación sigue.** La misma sesión continúa en tu otra cuenta, con
todo su contexto, sus servidores MCP con la sesión ya iniciada y un perfil de navegador que
conserva sus inicios de sesión. turno es para quien usa una cuenta de trabajo y una personal con
sus agentes de código.

- **Tu conversación.** Una sesión de Claude Code que empezó con una cuenta sigue con otra, o se
  bifurca en una segunda: `turno session handoff trabajo` imprime el comando.
- **Tus sesiones de MCP.** Un gateway local inicia sesión en cada servidor remoto con OAuth una
  vez por cuenta (`turno mcp login <servidor>`), y todas las sesiones de agente de esa cuenta
  llegan a él a través del gateway.
- **Tu sesión del navegador.** Un perfil real de Chrome por identidad que conserva sus inicios
  de sesión (el paquete aparte `turno-browser`), y enlaces de claude.ai que abren con la cuenta
  de la sesión (`turno open`).
- **Tu control.** Tres skills del plugin de Claude Code mueven trabajo entre cuentas desde dentro
  de una sesión: `/switch-account`, `/fork-session` y `/copy-artifact`.
- **La cuenta correcta, sola.** Cada carpeta de proyecto tiene su cuenta, en Claude Code, Codex,
  Copilot CLI y Cursor CLI.
- **Fácil de probar, fácil de deshacer.** `npx turno-cli demo` corre en un HOME desechable, y
  `turno undo` regresa cada archivo que un comando cambió.

El mismo gateway arranca cada servidor MCP una sola vez y lo comparte entre sesiones; el ahorro
de memoria medido está en [BENCHMARKS.md](BENCHMARKS.md). En
[turno.wimo.dev](https://turno.wimo.dev/es) está la historia completa, con una imagen de cada
parte que puedes probar.

![turno demo: dos perfiles, un gateway, la status line, el selector y turno doctor, en un HOME desechable](docs/assets/demo.gif)

## Instalación

```sh
# pruébalo primero, en un HOME desechable; no toca tu configuración
npx turno-cli demo
```

Luego instálalo con el gestor de paquetes que ya usas (macOS o Linux, Node 22.11 o más nuevo):

```sh
npm install --global turno-cli
pnpm add --global turno-cli
bun add --global turno-cli
# yarn 1 (classic); yarn 2 y posteriores no instalan global
yarn global add turno-cli
brew tap wimo-dev/turno && brew trust wimo-dev/turno && brew install turno
```

El paquete de npm se llama `turno-cli`; el comando que instala es `turno`, y `turno upgrade` lo
actualiza después con la misma herramienta. `npx turno-cli`, `pnpm dlx turno-cli` y
`bunx turno-cli` lo ejecutan una vez sin instalarlo. No ejecuta scripts de instalación, y npm y
Homebrew instalan exactamente las versiones de dependencias que se probaron, desde su
`npm-shrinkwrap.json` (pnpm, bun y yarn resuelven por su cuenta las dependencias de sus
dependencias). CI lo instala de todas estas formas en macOS y Linux. Nada sale de tu máquina: no
hay cuenta, ni telemetría, ni proxy del tráfico con el modelo.

## Inicio rápido

```sh
# encuentra tus agentes, perfiles, carpetas y servidores MCP, muestra el diff,
# arranca el gateway y apunta cada perfil a él
turno init
# inicia sesión una vez por perfil (/login)
claude-trabajo
# Claude Code, con la cuenta de esta carpeta
cd ~/code/acme && turno auto
# dónde estás: esta carpeta, cuentas, gateway y qué sigue
turno
```

`turno init` pregunta antes de adoptar cualquier cosa y escribe todo como un solo cambio, así
que un solo `turno undo <stamp>` lo revierte. El gateway corre como servicio de sesión (launchd
en macOS, systemd --user en Linux); `turno init --no-start` lo deja para después
(`turno mcp daemon start` y luego `turno mcp sync`). Paso a paso:

```sh
# ~/.claude-trabajo y el comando claude-trabajo
turno profile add trabajo --color violet
turno profile add personal
# inicia sesión una vez por perfil (/login)
claude-trabajo
# esta carpeta y todo lo que tiene adentro
turno profile assign ~/code/acme trabajo
# carpetas sin regla
turno config set default personal
# mcp.toml a partir de los servidores que ya tienes
turno mcp import --move-secrets --write
# el gateway, y cada perfil apuntando a él
turno mcp daemon start && turno mcp sync
# Claude Code con la cuenta del trabajo
cd ~/code/acme && turno auto
```

Los perfiles de Codex, Copilot y Cursor son iguales, con `--agent codex|copilot|cursor`. Los
lanzadores van en `~/.local/bin`; si no está en tu `PATH`, `turno profile add` te da la línea
que hay que agregar y mientras tanto funciona `turno trabajo`. `turno auto` nunca cambia de
cuenta en silencio: si falta el perfil o `config.toml` tiene un error, se detiene y te dice el
comando que lo arregla.

Una regla de carpeta también puede elegir qué servidores MCP ven las sesiones de esa carpeta:

```toml
[[projects]]
path = "~/code/oss"
mcp_deny = ["mail"]     # aquí las sesiones ven todos los servidores MCP menos mail
```

Los detalles de cada agente están en [docs/agents.md](docs/agents.md), los del gateway en
[docs/mcp.md](docs/mcp.md), y la referencia completa de comandos y configuración, en el
[README en inglés](README.md#reference).

## Un navegador por identidad

```sh
# paquete aparte, no se instala con turno
npm install --global turno-browser
# una identidad y su entrada en mcp.toml
turno identity add browser:escuela
# inicia sesión a mano una vez; las cookies se conservan
turno identity login browser:escuela
```

`turno-browser` es su propio servidor MCP. Maneja el Chrome que ya tienes instalado, con
ventana, con un perfil persistente por identidad y sin inyectar scripts, así que un agente
trabaja dentro de las sesiones que tú iniciaste a mano.

- **Limpia lo que deja.** Mantiene 8 pestañas como máximo, pausa una pestaña sin uso a los 5
  minutos y la cierra a los 15. Chrome se cierra tras 15 minutos sin llamadas y vuelve a abrir en
  la siguiente; cuando el agente termina, Chrome se cierra con él.
- **Menos idas y vueltas.** `browser_batch` corre hasta 20 acciones en una sola llamada, y una
  acción que falla dice qué elemento tapa el objetivo, o si está oculto, deshabilitado o ya no
  existe.
- **Credenciales que el agente nunca ve.** `turno browser vault add` guarda usuario, contraseña
  y un secreto TOTP opcional por sitio en el almacén de secretos del sistema, y la herramienta
  `browser_login` los escribe en la página de inicio de sesión de ese sitio. Una contraseña o
  un código de un solo uso nunca regresa al agente, lo escriba quien lo escriba.
- **Sesiones que se pueden mover.** `turno browser export <id> --out <archivo>` escribe las
  cookies y el almacenamiento de una identidad en un archivo cifrado con una frase, con
  vencimiento, y `turno browser import <archivo>` lo lee en otra máquina. La bóveda de
  credenciales nunca sale.
- **Páginas más ligeras, si quieres.** Por identidad y apagado por defecto: bloquear
  rastreadores, imágenes, video o fuentes, y guardar recursos estáticos en una caché en disco.

Úsalo con tus propias cuentas, en sitios cuyos términos te permitan el acceso automatizado, y a
ritmo humano. No lo uses para sortear controles de acceso, muros de pago o límites, para extraer
datos a gran escala, ni para entrar a cuentas que no son tuyas. La resolución de captchas y las
acciones en lenguaje natural vienen apagadas y se activan por identidad; las dos envían contenido
de la página a un tercero que tú eliges, y resolver captchas puede incumplir los términos de un
sitio. Más detalle en
[Identidades del navegador](https://turno.wimo.dev/es/docs/browser/identities).

## Preguntas frecuentes

**¿Está permitido usar varias cuentas?** Depende de tu plan, no de turno. turno ejecuta la CLI
oficial de cada proveedor sin modificarla, y cada cuenta inicia sesión con el login del propio
proveedor en su propia carpeta. El uso pensado es separar cuentas de trabajo y personales. No lo
uses para sortear límites de uso ni salvaguardas; lee [Vendor terms](README.md#vendor-terms).

**¿Dónde quedan mis credenciales?** Donde cada agente las guarda, dentro de la carpeta del perfil
(o en el Llavero, si el agente lo usa). turno nunca lee, copia ni reenvía tokens de sesión. Los
secretos MCP que mueves con `--move-secrets` y los tokens OAuth de servidores MCP remotos van al
Llavero de macOS o al Secret Service de Linux. Qué guarda turno y dónde: [SECURITY.md](SECURITY.md).

**¿turno ve mis prompts?** No. Lanza el agente y se hace a un lado. Solo las llamadas a
herramientas MCP pasan por `mcpd`, en `127.0.0.1` y con un token por perfil.

**¿Pueden usar turno los scripts y los agentes?** Sí. turno solo pregunta cuando hay una
persona en una terminal: con `--no-input` (o `TURNO_NO_INPUT=1`), cuando stdin no es una
terminal y dentro de una sesión de agente de Claude Code, Codex, Copilot CLI o Cursor nunca
pregunta. Un comando que necesitaría preguntar termina con código 2 y nombra la opción que lo
responde, por ejemplo `turno: init needs an answer; pass --yes (or run it in a terminal)`.
`TURNO_NO_INPUT=0` te deja responder en la terminal de un editor que define la variable de un
agente. Un comando que necesita un perfil y no lo recibe (`turno profile assign`, `turno run`,
`turno session handoff`, `turno limit set`) muestra una lista para elegir en una terminal
(flechas o j/k, escribir para filtrar, Enter, Esc para cancelar); `turno run` muestra primero
`auto`, con el perfil que le toca a esta carpeta (`auto (work)`). Fuera de una terminal termina
con código 2 y lista los perfiles: `pass a profile: personal, work`.

**¿Cómo lo deshago?** Cada comando que escribe guarda una copia de lo que cambia:
`turno undo --list` las muestra y `turno undo <stamp>` las restaura (las copias de más de 30
días se borran, conservando las 10 más recientes). Para quitar turno, `turno uninstall
--dry-run` muestra lo que turno configuró (servicio, lanzadores, entradas MCP, status line,
configuración) y `turno uninstall` lo quita; después, `npm uninstall --global turno-cli`. Las
carpetas de los perfiles, que guardan tus credenciales y tu historial, se quedan hasta que tú
las borres. `turno uninstall --purge` también borra el estado y las cachés de turno (copias,
registros, uso, servidores MCP instalados), y después `turno undo` ya no tiene qué restaurar.

## Contribuir

Las preguntas en español son bienvenidas en
[Discussions](https://github.com/wimo-dev/turno/discussions), en la categoría Español.
Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un pull request.
Licencia Apache 2.0.

## Documentación

[turno.wimo.dev](https://turno.wimo.dev/es) es el sitio: una portada que cuenta la historia en
ocho partes y la [documentación](https://turno.wimo.dev/es/docs), con guías por problema,
conceptos, la referencia generada desde el código y una página de solución por cada hallazgo de
`turno doctor`. Los primeros pasos y las preguntas frecuentes están en español; las demás
páginas avisan cuando siguen en inglés.
