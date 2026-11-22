"use client";

import { useEffect, useRef, useState } from "react";
import type { Lang } from "../../landing/copy";
import { BEAT, useInView, useReducedMotion } from "../../landing/story";
import { browserCopy, SITE, TOOL } from "../copy";
import { AgentCursor, Field, Lines, Squares, Window } from "./parts";
import s from "./pictures.module.css";

/*
 * The hero's picture: the three promises in one window, played as three scenes in a loop. The
 * agent opens a site and is already signed in; five minutes later most of its pages are parked;
 * then it signs in to another site and the password is only a mark to it. The readouts under
 * the window are the three promises: the one on screen is lit. With reduced motion, and until
 * the picture is seen, it rests on a still of all three.
 */

const NAMES = ["mail", "docs", "wiki", "repo", "courses"];

/** How many of the oldest pages the second scene parks. */
const PARKED = 3;

/** Each scene: the beats before the window answers the call, and the beats it then holds. */
const ANSWER = 5;
const HOLD = 22;

export function HeroPicture({ lang }: { lang: Lang }) {
  const copy = browserCopy(lang);
  const t = copy.pictures;
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const seen = useInView(ref, 0.3);
  const live = seen && !reduced;

  // The scene on screen, and whether the window has answered its call yet.
  const [scene, setScene] = useState(0);
  const [answered, setAnswered] = useState(true);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!live) return;
    setStarted(true);
    setAnswered(false);
    const answer = setTimeout(() => setAnswered(true), ANSWER * BEAT);
    const next = setTimeout(() => setScene((current) => (current + 1) % 3), (ANSWER + HOLD) * BEAT);
    return () => {
      clearTimeout(answer);
      clearTimeout(next);
    };
  }, [live, scene]);

  // The still: every promise at once.
  const still = !started || reduced;
  const parked = still || scene >= 1 ? PARKED : 0;
  const second = !still && scene === 2;
  const filled = second && answered;
  const lit = still ? -1 : scene;

  const calls = [
    { prompt: "tool", text: `${TOOL.navigate} https://${SITE}/courses` },
    { prompt: "…", text: copy.chapters.tabs.commands[1]!.run },
    { prompt: "tool", text: `${TOOL.login} { site: "library" }` },
  ];
  const call = calls[still ? 0 : scene]!;

  return (
    <div ref={ref} className={s.heroShot} role="img" aria-label={copy.hero.figure}>
      <div className={s.frame}>
        <div className={s.inner}>
          <div className={s.heroCall} key={still ? "still" : scene}>
            <span className={s.heroPrompt}>{call.prompt}</span>
            <span>{call.text}</span>
          </div>
          <Window
            win="open"
            url={second ? `${copy.hero.later}/login` : `${SITE}/courses`}
            strip={
              <div className={s.stripWrap} style={{ paddingTop: 10 }}>
                <div className={s.strip}>
                  {NAMES.map((name, index) => {
                    const isParked = index < parked && !(scene === 1 && !answered && !still);
                    const current = index === NAMES.length - 1;
                    return (
                      <span key={name} className={s.tab} data-state={isParked ? "park" : "run"} data-current={current || undefined} style={{ gridColumn: "span 2" }}>
                        <i />
                        <span>{isParked ? "blank" : current && second ? "library" : name}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            }
          >
            {second ? (
              <div className={s.page}>
                <span className={s.form}>
                  <Field name={t.vault.username} value={filled ? "me" : undefined} />
                  <Field name={t.vault.password} value={filled ? "••••••••" : undefined} />
                  <Field name={t.vault.code} value={filled ? "••••••" : undefined} />
                </span>
                <AgentCursor at="field" />
              </div>
            ) : (
              <div className={s.page}>
                <span className={s.signed}>✓ {t.identities.signedIn}</span>
                <span className={s.heading}>{t.identities.page}</span>
                <Lines />
                <AgentCursor at="page" />
              </div>
            )}
            <div className={s.readouts} data-live={still ? undefined : true}>
              <span className={s.readout} data-on={lit === 0 || undefined}>
                <span className={s.signed}>
                  ✓ {t.identities.signedIn} <span className={s.quiet}>· {t.identities.kept}</span>
                </span>
                <span>{t.identities.onDisk}</span>
              </span>
              <span className={s.readout} data-on={lit === 1 || undefined}>
                <span className={s.meter}>
                  <span className={s.count}>
                    {t.tabs.running} <b>{NAMES.length - (scene === 1 && !answered && !still ? 0 : parked)}</b>
                    <Squares n={NAMES.length - (scene === 1 && !answered && !still ? 0 : parked)} kind="run" />
                  </span>
                  <span className={s.count}>
                    {t.tabs.parked} <b>{scene === 1 && !answered && !still ? 0 : parked}</b>
                    <Squares n={scene === 1 && !answered && !still ? 0 : parked} kind="park" />
                  </span>
                </span>
              </span>
              <span className={s.readout} data-on={lit === 2 || undefined}>
                <span>
                  {t.vault.password} <span className={s.vaulted}>[sensitive field]</span>
                </span>
                <span>{t.vault.model}</span>
              </span>
            </div>
          </Window>
        </div>
      </div>
    </div>
  );
}
