import Link from "next/link";
import { CopyCommand } from "../landing/kit";
import { localePath } from "@/lib/layout.shared";
import type { BrowserCopy, Feature, OptInState } from "./copy";
import { Glyph } from "./pictures/glyphs";
import s from "./page.module.css";

interface Labels {
  copyLabel: string;
  copiedLabel: string;
}

/** Text with `code` between backticks set in mono. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        // Parts of one fixed sentence: their order never changes.
        index % 2 === 1 ? <code key={index}>{part}</code> : part,
      )}
    </>
  );
}

function Run({ run, labels }: { run: string; labels: Labels }) {
  // A tool is something an agent calls, not a line to copy into a shell.
  if (!run.includes(" ")) {
    return (
      <p className={s.tool}>
        <span>tool</span> {run}
      </p>
    );
  }
  return <CopyCommand run={run} {...labels} />;
}

function Body({ feature, lang, labels }: { feature: Feature; lang: string; labels: Labels }) {
  return (
    <>
      <p className={s.cardText}>
        <Inline text={feature.text} />
      </p>
      <div className={s.cardFoot}>
        {feature.run ? <Run run={feature.run} labels={labels} /> : null}
        <Link href={localePath(lang, feature.more.href)} className={s.link}>
          {feature.more.text} <span aria-hidden>→</span>
        </Link>
      </div>
    </>
  );
}

/** What works from the first run: six things, each with the small tag that says so. */
export function Included({ t, lang, labels }: { t: BrowserCopy; lang: string; labels: Labels }) {
  return (
    <div className={s.included}>
      {t.included.items.map((feature) => (
        <article key={feature.title} className={s.item}>
          <div className={s.itemHead}>
            <h3 className={s.itemTitle}>{feature.title}</h3>
            <span className={s.tag} data-kind="on">
              {t.tags.on}
            </span>
          </div>
          <Body feature={feature} lang={lang} labels={labels} />
        </article>
      ))}
    </div>
  );
}

/** The words and the kind of a grid feature's tag: on by default, opt in, or on when something is there. */
function stateTag(state: OptInState, tags: BrowserCopy["tags"]): { kind: string; text: string } {
  if (state === "default") return { kind: "default", text: tags.byDefault };
  if (state === "opt") return { kind: "opt", text: tags.optIn };
  return { kind: "when", text: state.when };
}

/** The features of the grid: a picture each, the tag that says whether it is on, and how to use it. */
export function OptIns({ t, lang, labels }: { t: BrowserCopy; lang: string; labels: Labels }) {
  return (
    <div className={s.optIns}>
      {t.optIn.items.map((feature) => {
        const tag = stateTag(feature.state, t.tags);
        return (
          <article key={feature.id} className={s.optIn} data-id={feature.id}>
            <Glyph feature={feature} />
            <div className={s.optInBody}>
              <div className={s.itemHead}>
                <h3 className={s.cardTitle}>{feature.title}</h3>
                <span className={s.tag} data-kind={tag.kind}>
                  {tag.text}
                </span>
              </div>
              <Body feature={feature} lang={lang} labels={labels} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
