import Link from "next/link";
import "../landing/landing.css";
import { asLang, type Headline, landingCopy } from "../landing/copy";
import { CopyCommand } from "../landing/kit";
import { localePath } from "@/lib/layout.shared";
import { BrowserChapters } from "./chapters";
import { browserCopy, CMD, type Path } from "./copy";
import { CopyPrompt } from "./copy-prompt";
import { Included, OptIns } from "./features";
import { HeroPicture } from "./pictures/hero";
import s from "./page.module.css";

/**
 * The turno-browser page: the line and the install command, the three problems it starts from
 * (each a chapter with a picture, as on the home page), what else comes with it, where it sits
 * next to other tools, the two ways to set it up, and its acceptable use.
 */
export function BrowserPage({ lang: given }: { lang: string }) {
  const lang = asLang(given);
  const t = browserCopy(lang);
  const shared = landingCopy(lang);
  const labels = { copyLabel: shared.rail.copy, copiedLabel: shared.rail.copied };

  return (
    <main className="t-site flex-1">
      <section id="hero" className={s.hero} aria-labelledby="hero-title">
        <div className={`t-wrap ${s.heroGrid}`}>
          <div className={s.heroText}>
            <p className="t-label">{t.hero.eyebrow}</p>
            <h1 id="hero-title" className={`t-h1 ${s.h1}`}>
              <Marked parts={t.hero.headline} />
            </h1>
            <p className={s.hook}>{t.hero.hook}</p>
            <p className="t-lead">{t.hero.lead}</p>
            <div className={s.heroActions}>
              <span className={s.two}>
                <CopyCommand run={CMD.install} {...labels} />
                <CopyCommand run={CMD.init} {...labels} />
              </span>
              <CopyPrompt {...t.hero.prompt} />
              <Link href={localePath(lang, "/docs/browser")} className={s.link}>
                {t.hero.docs} <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
          <HeroPicture lang={lang} />
        </div>
        <div className={`t-wrap ${s.factsWrap}`}>
          <ul className={s.facts}>
            {t.facts.map((fact) => (
              <li key={fact.title} className={s.fact}>
                <span className={s.factTitle}>{fact.title}</span>
                <span className={s.factText}>{fact.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className={`t-wrap ${s.start}`}>
        <p className="t-label">{t.pains.title}</p>
        <nav className={s.pains} aria-label={t.pains.title}>
          {t.pains.items.map((pain) => (
            <a key={pain.to} href={`#${pain.to}`} className={`t-swap ${s.pain}`}>
              <span>{pain.text}</span>
              <span aria-hidden className="font-mono text-xs">
                ↓
              </span>
            </a>
          ))}
        </nav>
      </div>

      <BrowserChapters lang={lang} />

      <section id="included" className={`t-section ${s.section}`} aria-labelledby="included-title">
        <div className="t-wrap">
          <p className="t-label">{t.included.label}</p>
          <h2 id="included-title" className={`t-h2 ${s.h2}`}>
            <Marked parts={t.included.headline} />
          </h2>
          <Included t={t} lang={lang} labels={labels} />
        </div>
      </section>

      <section id="opt-in" className={`t-section ${s.section}`} aria-labelledby="opt-in-title">
        <div className="t-wrap">
          <p className="t-label">{t.optIn.label}</p>
          <h2 id="opt-in-title" className={`t-h2 ${s.h2}`}>
            <Marked parts={t.optIn.headline} />
          </h2>
          <p className={`t-lead ${s.lead}`}>{t.optIn.lead}</p>
          <Link href={localePath(lang, t.optIn.more.href)} className={s.link}>
            {t.optIn.more.text} <span aria-hidden>→</span>
          </Link>
          <OptIns t={t} lang={lang} labels={labels} />
        </div>
      </section>

      <section id="layers" className={`t-section ${s.section}`} aria-labelledby="layers-title">
        <div className={`t-wrap ${s.split}`}>
          <div>
            <p className="t-label">{t.layers.label}</p>
            <h2 id="layers-title" className={`t-h2 ${s.h2}`}>
              <Marked parts={t.layers.headline} />
            </h2>
            <p className={`t-lead ${s.lead}`}>{t.layers.lead}</p>
            <Link href={localePath(lang, t.layers.more.href)} className={s.link}>
              {t.layers.more.text} <span aria-hidden>→</span>
            </Link>
          </div>
          <div className={s.layers} role="img" aria-label={t.layers.figure}>
            {t.layers.rows.map((row, index) => (
              <div key={row.name} className={s.layer} data-own={index === 1 || undefined}>
                <span className={s.layerName}>{row.name}</span>
                <span className={s.layerItems}>
                  {row.items.map((item) => (
                    <span key={item} className={s.chip}>
                      {item}
                    </span>
                  ))}
                </span>
                {index === 0 ? <span className={s.beside}>{t.layers.beside}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="setup" className={`t-section ${s.section}`} aria-labelledby="setup-title">
        <div className="t-wrap">
          <p className="t-label">{t.setup.label}</p>
          <h2 id="setup-title" className={`t-h2 ${s.h2}`}>
            <Marked parts={t.setup.headline} />
          </h2>
          <div className={s.paths}>
            <Way path={t.setup.alone} lang={lang} labels={labels} />
            <Way path={t.setup.withTurno} lang={lang} labels={labels} />
          </div>
        </div>
      </section>

      <section id="use" className={`t-section ${s.use}`} aria-labelledby="use-title">
        <div className={`t-wrap ${s.useGrid}`}>
          <p id="use-title" className="t-label">
            {t.use.label}
          </p>
          <div>
            <p className={s.useText}>{t.use.text}</p>
            <Link href={localePath(lang, t.use.more.href)} className={s.link}>
              {t.use.more.text} <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>

      <section id="start" className={`t-section ${s.section}`} aria-labelledby="start-title">
        <div className={`t-wrap ${s.end}`}>
          <p className="t-label">{t.start.label}</p>
          <h2 id="start-title" className={`t-h1 ${s.endTitle}`}>
            <Marked parts={t.start.headline} />
          </h2>
          <p className="t-lead">{t.start.text}</p>
          <div className={s.heroActions}>
            <span className={s.two}>
              <CopyCommand run={CMD.install} {...labels} />
              <CopyCommand run={CMD.init} {...labels} />
            </span>
            <CopyPrompt {...t.hero.prompt} />
            <Link href={localePath(lang, "/docs/browser")} className={s.link}>
              {t.start.docs} <span aria-hidden>→</span>
            </Link>
            <Link href={localePath(lang, "/")} prefetch={false} className={s.link}>
              {t.start.home} <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>

      <footer className="t-section">
        <div className="t-wrap t-foot">
          <div className="flex flex-col gap-4 text-xs leading-relaxed text-fd-muted-foreground md:flex-row md:items-end md:justify-between">
            <p className="max-w-xl">{shared.footer.disclaimer}</p>
            <p className="font-mono">
              {shared.footer.madeBy}{" "}
              <a href="https://wimo.dev" className="text-fd-foreground underline underline-offset-4">
                {shared.footer.site}
              </a>
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}

/** A headline with the words that carry the idea in turno's blue. */
function Marked({ parts }: { parts: Headline }) {
  return (
    <>
      {parts[0]}
      <span className="t-mark">{parts[1]}</span>
      {parts[2]}
    </>
  );
}

/** One way to set it up: what it is, then its commands in order. */
function Way({ path, lang, labels }: { path: Path; lang: string; labels: { copyLabel: string; copiedLabel: string } }) {
  return (
    <article className={s.way}>
      <h3 className={s.cardTitle}>{path.title}</h3>
      <p className={s.cardText}>{path.text}</p>
      <ol className={s.steps}>
        {path.commands.map((command) => (
          <li key={command.run}>
            <CopyCommand run={command.run} {...labels} />
            <p className={s.stepNote}>{command.note}</p>
          </li>
        ))}
      </ol>
      {path.more ? (
        <Link href={localePath(lang, path.more.href)} prefetch={false} className={s.link}>
          {path.more.text} <span aria-hidden>→</span>
        </Link>
      ) : null}
    </article>
  );
}
