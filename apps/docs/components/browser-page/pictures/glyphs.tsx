import type { ReactNode } from "react";
import type { OptIn, OptInId } from "../copy";
import g from "./glyphs.module.css";

/*
 * One small picture per opt-in feature: hairlines and squares, the identity in its tone, turno
 * and the agent in blue. A picture shows the idea in one glance; the card's text says the rest.
 */

/** The picture of an opt-in feature. `words` are the few it shows, in the page's language. */
export function Glyph({ feature }: { feature: OptIn }) {
  const Picture = GLYPHS[feature.id];
  return (
    <div aria-hidden className={g.glyph} data-id={feature.id}>
      <Picture words={feature.words ?? []} />
    </div>
  );
}

type GlyphProps = { words: string[] };

/** The agent's tab as a picture, with the controls of the view under it. */
function Live({ words }: GlyphProps) {
  return (
    <div className={g.live}>
      <div className={g.screen}>
        <i />
        <i />
        <i />
        <span className={g.cursorAgent} />
        <span className={g.cursorYou} />
      </div>
      <div className={g.controls}>
        <span className={g.follow}>
          <b /> {words[0]}
        </span>
        <span className={g.key} data-on>
          {words[1]}
        </span>
        <span className={g.key}>{words[2]}</span>
      </div>
    </div>
  );
}

/** One strip of tabs, each held by one of three sessions. */
function Sharing({ words }: GlyphProps) {
  const holders = ["a", "a", "b", "c", "c", "b"];
  return (
    <div className={g.sharing}>
      <div className={g.tabs}>
        {holders.map((holder, index) => (
          // A fixed row of tabs: their order never changes.
          <span key={index} className={g.tab} data-holder={holder} />
        ))}
      </div>
      <div className={g.legend}>
        {["a", "b", "c"].map((holder) => (
          <span key={holder} data-holder={holder}>
            <b /> {words[0]} {holder}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The sites an identity may show, and one it may not. */
function Policy() {
  return (
    <div className={g.policy}>
      <span data-ok>
        <b>✓</b> example.com
      </span>
      <span data-ok>
        <b>✓</b> *.example.com
      </span>
      <span>
        <b>✕</b> elsewhere.test
      </span>
    </div>
  );
}

/** An instruction in plain words, and the calls it turns into. */
function Act({ words }: GlyphProps) {
  return (
    <div className={g.act}>
      <span className={g.said}>“{words[0]}”</span>
      <span className={g.call}>
        <i>→</i> browser_click
      </span>
      <span className={g.call}>
        <i>→</i> browser_click
      </span>
    </div>
  );
}

/** A captcha widget, and the token that comes back from the solver service. */
function Captcha({ words }: GlyphProps) {
  return (
    <div className={g.captcha}>
      <span className={g.widget}>
        <b>✓</b>
        <i />
      </span>
      <span className={g.wire}>
        <i>{words[1]}</i>
      </span>
      <span className={g.solver}>{words[0]}</span>
    </div>
  );
}

/** Two ways to a target: one straight jump, and the curve a hand would draw. */
function Humanize() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      <path d="M22 76 L196 28" className={g.dashed} />
      <path d="M22 76 C 70 86, 130 14, 198 30" className={g.ink} />
      <rect x="186" y="18" width="32" height="22" className={g.target} />
      <rect x="19" y="73" width="6" height="6" className={g.fill} />
      {[58, 96, 134, 166].map((x, index) => (
        <rect key={x} x={x} y={[70, 52, 36, 30][index]} width="3" height="3" className={g.fill} />
      ))}
    </svg>
  );
}

/** A page as a person sees it, and the same page as text only. */
function Read() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      <rect x="18" y="14" width="84" height="68" className={g.line} />
      <rect x="26" y="22" width="68" height="26" className={g.faint} />
      <path d="M26 58 H86 M26 66 H74 M26 74 H80" className={g.line} />
      <path d="M112 48 H128 M122 42 L128 48 L122 54" className={g.blue} />
      <rect x="138" y="14" width="84" height="68" className={g.ink} />
      <path d="M146 26 H206 M146 36 H194 M146 46 H210 M146 56 H186 M146 66 H202" className={g.ink} />
    </svg>
  );
}

/** Your own Chrome, already open, and the agent that connects to it. */
function Attach() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      <rect x="64" y="12" width="158" height="72" className={g.ink} />
      <path d="M64 30 H222" className={g.ink} />
      <rect x="72" y="18" width="34" height="12" className={g.ink} />
      <rect x="110" y="18" width="34" height="12" className={g.line} />
      <rect x="148" y="18" width="34" height="12" className={g.line} />
      <path d="M76 44 H150 M76 54 H132 M76 64 H142" className={g.line} />
      <rect x="14" y="40" width="16" height="16" className={g.blueFill} />
      <path d="M30 48 H64" className={g.blue} />
      <rect x="60" y="44" width="8" height="8" className={g.blueFill} />
    </svg>
  );
}

/** Another browser, on a profile of its own. */
function Camoufox() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      <rect x="18" y="20" width="92" height="60" className={g.line} />
      <path d="M18 34 H110" className={g.line} />
      <path d="M26 46 H92 M26 56 H78" className={g.line} />
      <path d="M118 50 H130" className={g.dashed} />
      <rect x="138" y="12" width="88" height="72" className={g.tone} />
      <path d="M138 28 H226" className={g.tone} />
      <circle cx="148" cy="20" r="3" className={g.toneFill} />
      <path d="M146 42 H212 M146 52 H196 M146 62 H206" className={g.ink} />
    </svg>
  );
}

/** A session as a timeline: a frame after each action, and a play head. */
function Record() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      {[20, 62, 104, 146, 188].map((x, index) => (
        <g key={x}>
          <rect x={x} y="14" width="32" height="24" className={index === 2 ? g.ink : g.line} />
          <path d={`M${x + 16} 38 V58`} className={g.line} />
        </g>
      ))}
      <path d="M12 62 H228" className={g.ink} />
      <path d="M120 54 V78" className={g.blue} />
      <rect x="116" y="76" width="8" height="8" className={g.blueFill} />
      {[36, 78, 162, 204].map((x) => (
        <rect key={x} x={x - 2} y="60" width="4" height="4" className={g.fill} />
      ))}
    </svg>
  );
}

/** The way out to a site, through a proxy of yours. */
function Network() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      <rect x="16" y="34" width="40" height="28" className={g.tone} />
      <path d="M56 48 H98" className={g.ink} />
      <rect x="98" y="30" width="44" height="36" className={g.dashedBox} />
      <path d="M108 48 H132 M126 42 L132 48 L126 54" className={g.blue} />
      <path d="M142 48 H184" className={g.ink} />
      <rect x="184" y="30" width="40" height="36" className={g.ink} />
      <path d="M192 42 H216 M192 52 H208" className={g.line} />
    </svg>
  );
}

/** A page's requests: some never leave, and what is kept stays on disk. */
function Lighter() {
  return (
    <svg viewBox="0 0 240 96" className={g.svg}>
      {[16, 30, 44, 58, 72].map((y, index) => {
        const blocked = index === 1 || index === 3;
        return (
          <g key={y}>
            <rect x="18" y={y} width={[120, 96, 132, 84, 110][index]} height="8" className={blocked ? g.faint : g.fill} />
            {blocked ? <path d={`M14 ${y + 4} H${[96, 84][index === 1 ? 0 : 1] + 26}`} className={g.strike} /> : null}
          </g>
        );
      })}
      <rect x="176" y="26" width="46" height="46" className={g.ink} />
      <path d="M186 26 V44 H212 V26 M186 58 H212" className={g.ink} />
    </svg>
  );
}

const GLYPHS: Record<OptInId, (props: GlyphProps) => ReactNode> = {
  live: Live,
  sharing: Sharing,
  policy: Policy,
  act: Act,
  captcha: Captcha,
  humanize: Humanize,
  read: Read,
  attach: Attach,
  camoufox: Camoufox,
  record: Record,
  network: Network,
  lighter: Lighter,
};
