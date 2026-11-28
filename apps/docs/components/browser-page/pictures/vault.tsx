"use client";

import { useEffect } from "react";
import type { PictureProps } from "../../landing/chapters/section";
import { usePhase } from "../../landing/chapters/stage";
import { browserCopy, CMD, PRINTS, SITE, TOOL } from "../copy";
import { Field, Shot, Window } from "./parts";
import s from "./pictures.module.css";

/*
 * The credential vault. `vault add` keeps a username, a password and a TOTP secret per site in
 * the OS secret store, asked with hidden prompts. An agent then calls `browser_login` with the
 * site's name on its sign-in page: the tool fills the fields, only on the origins the site was
 * stored with, and what the model gets back names the fields and never the values. In a snapshot
 * a password or one-time code field reads `[sensitive field]`, whoever filled it; the username
 * the vault filled reads `[vault: ...]`. The tool then submits the form, unless the identity's
 * `vault submit` says `confirm`.
 */

/** The phases of each step and how many beats each holds. */
const BEATS: Record<number, number[]> = {
  0: [4, 3, 3, 3, 1],
  1: [4, 3, 3, 3, 1],
};

const DOTS = "••••••••";
const CODE = "••••••";

export default function VaultPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = browserCopy(lang).pictures.vault;
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* The line under the picture. */
  const call = `${TOOL.login} { site: "campus" }`;
  let prompt = "$";
  let cmd: string = CMD.vaultAddShort;
  let result: string | undefined;
  if (chosen === 0) {
    if (p >= 3) result = t.stored;
  } else {
    prompt = "tool";
    cmd = call;
    if (p >= 4) result = PRINTS.submitted;
  }
  useEffect(() => {
    if (run > 0) say({ prompt, cmd, result });
  }, [run, prompt, cmd, result, say]);

  /* What each step draws: the keychain fills on `vault add`; the form fills on `browser_login`. */
  const stored = chosen === 1 ? 3 : Math.min(p, 3);
  const filled = chosen === 1 ? Math.min(p, 3) : 0;
  const called = chosen === 1;
  const replied = chosen === 1 && p >= 4;

  return (
    <Shot drawn={drawn} armed={armed}>
      <div className={s.vault}>
        <div className={s.vaultLeft}>
          <div className={s.box}>
            <span className={s.boxLabel}>{t.keychain}</span>
            <div className={s.keychain}>
              {stored === 0 ? (
                <span className={s.quiet}>{t.nothing}</span>
              ) : (
                <span className={s.key}>school / campus</span>
              )}
              <span className={s.entry} data-off={stored < 1 || undefined}>
                <span>{t.username}</span>
                <span>me</span>
              </span>
              <span className={s.entry} data-off={stored < 2 || undefined}>
                <span>{t.password}</span>
                <span className={s.value}>{DOTS}</span>
              </span>
              <span className={s.entry} data-off={stored < 3 || undefined}>
                <span>{t.code}</span>
                <span className={s.value}>{CODE}</span>
              </span>
            </div>
          </div>

          <Window win="open" url={`${SITE}/login`}>
            <div className={`${s.page} ${s.pageForm}`}>
              <span className={s.form}>
                <Field name={t.username} value={filled >= 1 ? "me" : undefined} />
                <Field name={t.password} value={filled >= 2 ? DOTS : undefined} />
                <Field name={t.code} value={filled >= 3 ? CODE : undefined} />
                <span className={s.button}>{t.signIn}</span>
              </span>
            </div>
          </Window>
        </div>

        <div className={`${s.box} ${s.model}`}>
          <span className={s.boxLabel}>{t.model}</span>
          {called ? (
            <>
              <span className={s.call}>
                <span>tool </span>
                {call}
              </span>
              {replied ? (
                <>
                  <span className={s.reply}>
                    <Vaulted text={PRINTS.filled} />
                  </span>
                  <span className={s.reply}>
                    - textbox "{t.username}": <b>[vault: ...]</b>
                    <br />- textbox "{t.password}": <b>[sensitive field]</b>
                    <br />- textbox "{t.code}": <b>[sensitive field]</b>
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <span className={s.quiet}>{t.notPart}</span>
          )}
        </div>
      </div>
    </Shot>
  );
}

/** A printed line with its `[vault: ...]` mark in turno's blue: the part that stays hidden. */
function Vaulted({ text }: { text: string }) {
  const mark = "[vault: ...]";
  const at = text.indexOf(mark);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b>{mark}</b>
      {text.slice(at + mark.length)}
    </>
  );
}
