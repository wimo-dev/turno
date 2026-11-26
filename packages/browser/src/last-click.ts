import type { Page } from "patchright-core";

/**
 * "The last click is yours": a click of the agent that would buy, send, publish or delete is
 * left to the person. The host refuses it before it runs and tells the agent to ask the person
 * with `browser_request_human` and `requireHumanClick`; that step's banner then says what the
 * click does (the total of an order, who a message goes to).
 *
 * The detection is conservative on purpose: a false positive stops a harmless click and asks the
 * person for nothing, so a button counts only when its accessible name says the act outright
 * ("Place order", "Pay $95.50", "Send", "Publish", "Delete account") and, for the names that are
 * also used for harmless steps ("Buy now", "Send", "Post", "Delete"), the page agrees: a checkout
 * with an amount, a message being written, a dialog that warns the act cannot be undone. Steps on
 * the way there ("Add to cart", "Proceed to checkout", "Send code", "Remove") never count.
 * `test/last-click.test.ts` measures it on fixtures of both kinds.
 *
 * What it does not see: a click through a script tool, a key press that submits a form, and a
 * natural language action that finds the button itself only when it clicks through the stock
 * click tool (it does). An identity turns it off with `lastClick: false`.
 */

export type LastClickKind = "purchase" | "send" | "publish" | "delete";

/** What the page says about the element the agent is about to click, read in the page. */
export interface ClickTarget {
  /** The ARIA role, explicit or implied by the tag ("button", "link", "menuitem"...). */
  role: string;
  /** The accessible name, roughly: aria-label, aria-labelledby, the text, the value, the title. */
  name: string;
  /** Inside a dialog (`dialog`, `role=dialog`, `role=alertdialog`, `aria-modal`). */
  inDialog: boolean;
  /** The text of that dialog, else of the element's form, clipped. */
  scopeText: string;
  /** The visible text of the page, clipped. */
  pageText: string;
  /** The address's path. */
  path: string;
  /** A message is being written next to it: a filled textarea or editable region in its form or dialog. */
  compose: boolean;
  /** The values of the recipient fields in its form or dialog (To, Recipient, Para...). */
  recipients: string[];
}

/** A click the person makes, with what it does in a few words. */
export interface LastClick {
  kind: LastClickKind;
  /** What the page says the click leads to: "Total: $95.50", "To: alice@example.com". */
  consequence: string[];
}

const CLICKABLE = new Set(["button", "link", "menuitem", "menuitemradio", "option", "tab"]);

/** Says the act outright: no context needed. */
const PURCHASE = [
  /^(place|submit|confirm|complete|finish)( (my|your|the|this))? (order|purchase|payment|booking|reservation)\b/,
  /^(confirm|complete|authorize|review) and (pay|place( (my|your|the))? order|buy)\b/,
  /^pay( now| securely)? \S*\d[\d.,]*\S*$/,
  /^(buy|purchase|order|pay) (now )?for \S*\d/,
  /^(realizar|confirmar|completar|finalizar|hacer)( (el|mi|tu|la))? (pedido|compra|pago|reserva|orden)\b/,
  /^pagar( ahora)? \S*\d[\d.,]*\S*$/,
  /^confirmar y pagar\b/,
];
/** Also the name of a step on the way: only on a checkout page with an amount. */
const PURCHASE_WEAK = [
  /^(buy|purchase|buy it|order)( now)?$/,
  /^pay( now| securely)?$/,
  /^pagar( ahora)?$/,
  /^(book|reserve|subscribe|donate)( now)?$/,
  /^(start|confirm) (my |your )?subscription$/,
  /^comprar( ahora| ya)?$/,
  /^(reservar|suscribirse|suscribirme|donar)( ahora)?$/,
];
const SEND = [
  /^(send|send now|send message|send email|send e-mail|send mail|send reply|reply|reply all|forward)$/,
  /^(enviar|enviar ahora|enviar mensaje|enviar correo|responder|responder a todos|reenviar)$/,
];
/** Money leaving: says the act outright. */
const TRANSFER = [
  /^(send|transfer|confirm transfer|send money|send payment)( now)?( \S*\d[\d.,]*\S*)?$/,
  /^(transferir|confirmar transferencia|enviar dinero)( ahora)?$/,
];
const PUBLISH = [/^(publish|publish now|go live|make public|publicar|publicar ahora|hacer público)$/];
/** Also the name of a harmless button: only next to a message being written. */
const PUBLISH_WEAK = [/^(post|post now|post reply|tweet|reply|share post|publicar respuesta)$/];
const DELETE = [
  /^((permanently|forever) delete|delete (permanently|forever))\b/,
  /^(delete|close|remove) (my |your |this |the )?(account|repository|organization|workspace|project|profile)\b/,
  /^(eliminar|borrar) (definitivamente|permanentemente|para siempre)$/,
  /^(eliminar|borrar|cerrar) (mi |tu |la |esta )?(cuenta|perfil|organización|proyecto)\b/,
];
/** Also the name of a harmless button: only where the page warns it cannot be undone. */
const DELETE_WEAK = [
  /^(delete|delete all|empty trash|eliminar|borrar|eliminar todo|vaciar papelera)$/,
  /^(yes, )?delete( it)?$/,
];

/** Never the act itself, whatever the page says around it. */
const NEVER =
  /\b(add to (cart|bag|basket)|proceed to|continue to|go to (checkout|cart)|view (cart|order)|code|link|otp|verification|invite|again|feedback|draft|preview|cancel|back|edit|save|search|añadir|agregar al carrito|ir a|continuar|código|enlace|borrador|guardar|cancelar)\b/;

const IRREVERSIBLE =
  /(can ?not be undone|can't be undone|cannot be recovered|permanently|irreversible|will be lost|no se puede deshacer|permanentemente|definitivamente|no se podrá recuperar)/;
const CHECKOUT_PATH = /(checkout|payment|billing|cart|basket|order|pago|carrito|pedido|compra)/;
const CHECKOUT_TEXT =
  /(payment method|card number|billing address|order summary|shipping address|método de pago|forma de pago|resumen del pedido|dirección de envío|tarjeta)/;
const MONEY =
  /(?:US\$|MX\$|R\$|[$€£¥₹])\s?\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\b\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?\s?(?:USD|MXN|EUR|GBP|€)\b/;
/** "Total", not "Subtotal": the last one on a checkout is the amount charged. */
const TOTAL = new RegExp(
  `(?<![a-z])(order total|total due|total to pay|grand total|amount due|total|importe total|total a pagar|monto|importe|amount)\\b[^\\d$€£¥₹]{0,30}(${MONEY.source})`,
  "gi",
);

function normal(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[\u200b-\u200f\u202a-\u202e]/g, "")
      // "Send (⌘Enter)": the shortcut is not part of the act.
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[.!…:]+$/, "")
      .trim()
  );
}

const any = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

/** The amount the act charges or sends: in the button's name, else the page's last total. */
function amount(target: ClickTarget): string | undefined {
  const own = MONEY.exec(target.name)?.[0];
  if (own) return own.trim();
  for (const text of [target.scopeText, target.pageText]) {
    const totals = [...text.replace(/\s+/g, " ").matchAll(TOTAL)];
    const last = totals.at(-1)?.[2];
    if (last) return last.trim();
  }
  return undefined;
}

/** The first sentence of a dialog, which names what goes: "Delete the repository acme/site?". */
function firstSentence(text: string): string | undefined {
  const line = text
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l.length > 8);
  if (!line) return undefined;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** The kind of act a click would be, or undefined when it is not one turno leaves to the person. */
export function classifyClick(target: ClickTarget): LastClick | undefined {
  if (!CLICKABLE.has(target.role)) return undefined;
  const name = normal(target.name);
  if (!name || name.length > 60 || NEVER.test(name)) return undefined;
  const scope = target.scopeText.toLowerCase();
  const page = target.pageText.toLowerCase();
  const money = amount(target);
  const checkout =
    !!money && (CHECKOUT_PATH.test(target.path.toLowerCase()) || CHECKOUT_TEXT.test(page) || CHECKOUT_TEXT.test(scope));
  const withAmount = (kind: LastClickKind, label: string): LastClick => ({
    kind,
    consequence: money ? [`${label}: ${money}`] : [],
  });

  if (any(PURCHASE, name) || (any(PURCHASE_WEAK, name) && checkout)) return withAmount("purchase", "Total");
  if (
    any(TRANSFER, name) &&
    money &&
    /(recipient|beneficiary|transfer|to account|destinatario|beneficiario|transferencia)/.test(`${scope} ${page}`)
  )
    return withAmount("send", "Amount");
  if (any(SEND, name) && (target.compose || target.recipients.length > 0)) {
    const to = target.recipients.filter(Boolean).slice(0, 3);
    return { kind: "send", consequence: to.length ? [`To: ${to.join(", ")}`] : [] };
  }
  if (any(PUBLISH, name) || (any(PUBLISH_WEAK, name) && target.compose)) return { kind: "publish", consequence: [] };
  // A "Delete account" button that opens the confirmation is a step on the way: only the
  // confirmation's own button, or one on a page that warns, is the act.
  const warned = IRREVERSIBLE.test(scope) || (!target.inDialog && IRREVERSIBLE.test(page));
  if ((any(DELETE, name) && (target.inDialog || warned)) || (any(DELETE_WEAK, name) && target.inDialog && warned)) {
    const what = target.inDialog ? firstSentence(target.scopeText) : undefined;
    return { kind: "delete", consequence: what ? [what] : [] };
  }
  return undefined;
}

/** Reads the click target in the page (Playwright's utility world). Runs in the page. */
function readClickTarget(el: Element): ClickTarget {
  const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
  // What the person reads: the rendered text, without hidden parts or the contents of scripts.
  const shown = (n: Element): string =>
    // biome-ignore lint/performance/useDomNodeTextContent: the visible text is the point here
    (n as HTMLElement).innerText ?? n.textContent ?? "";
  const implicit = (e: Element): string => {
    const tag = e.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && e.hasAttribute("href")) return "link";
    if (tag === "input") {
      const type = ((e as HTMLInputElement).type || "").toLowerCase();
      return ["submit", "button", "reset", "image"].includes(type) ? "button" : type;
    }
    if (tag === "summary") return "button";
    return "";
  };
  const role = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0] || implicit(el);
  const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? (el.ownerDocument.getElementById(id)?.textContent ?? "") : ""))
    .join(" ")
    .trim();
  const name =
    el.getAttribute("aria-label")?.trim() ||
    labelledBy ||
    shown(el).trim() ||
    (el instanceof HTMLInputElement ? el.value : "") ||
    el.getAttribute("title")?.trim() ||
    el.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
    "";
  const dialog = el.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
  const scope = dialog ?? el.closest("form");
  const scopeText = scope ? clip(shown(scope), 2_000) : "";
  const body = el.ownerDocument.body;
  const pageText = body ? clip(shown(body), 6_000) : "";
  const root: ParentNode = scope ?? el.ownerDocument;
  const compose = [
    ...root.querySelectorAll('textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"]'),
  ].some((f) => ((f as HTMLTextAreaElement).value ?? shown(f)).trim().length > 0);
  const RECIPIENT = /^(to|recipients?|send to|para|destinatarios?|beneficiario)\b/i;
  const recipients: string[] = [];
  for (const input of root.querySelectorAll("input")) {
    const label =
      input.getAttribute("aria-label") ||
      input.labels?.[0]?.textContent ||
      input.getAttribute("name") ||
      input.getAttribute("placeholder") ||
      "";
    const value = input.value.trim();
    if (value && input.type !== "password" && input.type !== "hidden" && RECIPIENT.test(label.trim()))
      recipients.push(clip(value, 80));
  }
  return {
    role,
    name: clip(name.replace(/\s+/g, " "), 200),
    inDialog: !!dialog,
    scopeText,
    pageText,
    path: el.ownerDocument.location?.pathname ?? "",
    compose,
    recipients,
  };
}

const REF = /^(f\d+)?e\d+$/;

/** The element `browser_click` would click, read in the page; undefined when it is not found quickly. */
export async function clickTargetOf(page: Page, target: string): Promise<ClickTarget | undefined> {
  const locator = page.locator(REF.test(target) ? `aria-ref=${target}` : target).first();
  return await locator.evaluate(readClickTarget, undefined, { timeout: 2_000 }).catch(() => undefined);
}

const ACT: Record<LastClickKind, string> = {
  purchase: "buy (it places an order or makes a payment)",
  send: "send something in the person's name",
  publish: "publish something in the person's name",
  delete: "delete something that cannot be brought back",
};

/** What the agent reads instead of the click: why, and the person step to ask for. */
export function lastClickRefusal(o: {
  click: LastClick;
  target: string;
  element?: string | undefined;
  identity?: string | undefined;
}): string {
  const what = [...o.click.consequence].join("; ");
  const call = {
    instruction: `${o.element ?? "Click the button"}${what ? ` (${what})` : ""}: check it and click it yourself if it is right.`,
    target: o.target,
    ...(o.element ? { element: o.element } : {}),
    requireHumanClick: true,
    until: { urlChanges: true },
  };
  const off = o.identity
    ? ` The person can turn this off with turno-browser set ${o.identity} --last-click false.`
    : "";
  return [
    `This click would ${ACT[o.click.kind]}${what ? ` (${what})` : ""}, and the last click of such an act is the person's: it was not made.`,
    `Fill in everything else, then call browser_request_human with ${JSON.stringify(call)}. The banner shows the person what the click does, and the result says whether their own click landed on it.${off}`,
  ].join("\n");
}
