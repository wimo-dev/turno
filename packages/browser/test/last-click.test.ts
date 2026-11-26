import { type Browser, type Page, chromium } from "patchright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LastClickKind, classifyClick, clickTargetOf, lastClickRefusal } from "../src/last-click.js";
import { chromeEnv } from "../src/settings.js";
import { chromeUnavailable } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Which clicks turno leaves to the person, measured on pages of both kinds in a real Chrome
 * (headless): the acts themselves, and the harmless clicks that share their words. A false
 * positive stops a harmless click, so the negatives are the larger set and must all pass.
 */

interface Fixture {
  name: string;
  path: string;
  html: string;
  /** The element the agent clicks. */
  click: string;
  expect: LastClickKind | undefined;
  consequence?: string;
}

const CHECKOUT = `<h1>Checkout</h1><h2>Payment method</h2><p>Card ending 4242</p>
  <p>Subtotal $89.00</p><p>Shipping $6.50</p><p>Order total <b>$95.50</b></p>`;
const PRODUCT = `<h1>Trail shoes</h1><p>$89.00</p><p>Free returns</p>`;

const POSITIVE: Fixture[] = [
  {
    name: "place order",
    path: "/checkout",
    html: `${CHECKOUT}<button>Place order</button>`,
    click: "button",
    expect: "purchase",
    consequence: "Total: $95.50",
  },
  {
    name: "pay with amount",
    path: "/pay",
    html: `${CHECKOUT}<button>Pay $95.50</button>`,
    click: "button",
    expect: "purchase",
    consequence: "Total: $95.50",
  },
  {
    name: "submit input",
    path: "/checkout",
    html: `<form>${CHECKOUT}<input type="submit" value="Complete purchase"></form>`,
    click: "input",
    expect: "purchase",
  },
  {
    name: "buy now on checkout",
    path: "/checkout/review",
    html: `${CHECKOUT}<button>Buy now</button>`,
    click: "button",
    expect: "purchase",
  },
  {
    name: "spanish order",
    path: "/carrito",
    html: `<h1>Resumen del pedido</h1><p>Total a pagar $1,250.00 MXN</p><button>Realizar pedido</button>`,
    click: "button",
    expect: "purchase",
    consequence: "Total: $1,250.00",
  },
  {
    name: "role button div",
    path: "/checkout",
    html: `${CHECKOUT}<div role="button" tabindex="0" aria-label="Confirm and pay">→</div>`,
    click: "[role=button]",
    expect: "purchase",
  },
  {
    name: "email send",
    path: "/mail",
    html: `<div role="dialog"><label>To <input value="alice@example.com"></label><input aria-label="Subject" value="Hi"><div contenteditable="true">See you soon</div><div role="button" aria-label="Send ‪(⌘Enter)‬">Send</div></div>`,
    click: "[role=button]",
    expect: "send",
    consequence: "To: alice@example.com",
  },
  {
    name: "chat send",
    path: "/chat",
    html: `<form><textarea>On my way</textarea><button>Send</button></form>`,
    click: "button",
    expect: "send",
  },
  {
    name: "money transfer",
    path: "/transfers/new",
    html: `<h1>New transfer</h1><p>Recipient: Bob Smith</p><p>Amount $300.00</p><button>Transfer now</button>`,
    click: "button",
    expect: "send",
    consequence: "Amount: $300.00",
  },
  {
    name: "publish",
    path: "/editor",
    html: `<h1>Draft</h1><button>Publish</button>`,
    click: "button",
    expect: "publish",
  },
  {
    name: "post with text",
    path: "/home",
    html: `<div><div role="textbox" contenteditable="true">Hello world</div><button>Post</button></div>`,
    click: "button",
    expect: "publish",
  },
  {
    name: "delete confirm",
    path: "/settings",
    html: `<div role="alertdialog"><h2>Delete the repository acme/site?</h2><p>This cannot be undone.</p><button>Delete</button></div>`,
    click: "button",
    expect: "delete",
    consequence: "Delete the repository acme/site?",
  },
  {
    name: "delete account in dialog",
    path: "/account",
    html: `<dialog open><p>Your account and data will be removed.</p><button>Delete my account</button></dialog>`,
    click: "button",
    expect: "delete",
  },
  {
    name: "spanish delete",
    path: "/ajustes",
    html: `<div role="dialog"><p>¿Eliminar el proyecto? No se puede deshacer.</p><button>Eliminar</button></div>`,
    click: "button",
    expect: "delete",
  },
];

const NEGATIVE: Fixture[] = [
  {
    name: "add to cart",
    path: "/p/shoes",
    html: `${PRODUCT}<button>Add to cart</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "buy now on a product page",
    path: "/p/shoes",
    html: `${PRODUCT}<button>Buy now</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "proceed to checkout",
    path: "/cart",
    html: `${CHECKOUT}<button>Proceed to checkout</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "checkout link",
    path: "/cart",
    html: `${CHECKOUT}<a href="/checkout">Checkout</a>`,
    click: "a",
    expect: undefined,
  },
  {
    name: "continue to payment",
    path: "/checkout",
    html: `${CHECKOUT}<button>Continue to payment</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "apply coupon",
    path: "/checkout",
    html: `${CHECKOUT}<button>Apply</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "subscribe newsletter",
    path: "/blog",
    html: `<p>Get our news</p><input type="email"><button>Subscribe</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "send code",
    path: "/login",
    html: `<form><input type="tel" value="5551234"><button>Send code</button></form>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "send with nothing written",
    path: "/chat",
    html: `<form><textarea></textarea><button>Send</button></form>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "resend link",
    path: "/verify",
    html: `<button>Send link again</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "submit search",
    path: "/",
    html: `<form><input value="shoes"><button>Submit</button></form>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "sign in",
    path: "/login",
    html: `<form><input value="a@b.c"><input type="password"><button>Sign in</button></form>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "save draft",
    path: "/editor",
    html: `<textarea>Text</textarea><button>Save draft</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "preview",
    path: "/editor",
    html: `<textarea>Text</textarea><button>Preview</button>`,
    click: "button",
    expect: undefined,
  },
  { name: "post link in nav", path: "/", html: `<nav><a href="/posts">Posts</a></nav>`, click: "a", expect: undefined },
  {
    name: "post without text",
    path: "/home",
    html: `<div><div role="textbox" contenteditable="true"></div><button>Post</button></div>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "delete row without warning",
    path: "/inbox",
    html: `<ul><li>Invoice <button>Delete</button></li></ul>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "delete account opens a dialog",
    path: "/settings",
    html: `<h2>Danger zone</h2><button>Delete account</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "remove from cart",
    path: "/cart",
    html: `${CHECKOUT}<button>Remove</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "cancel in a delete dialog",
    path: "/settings",
    html: `<div role="alertdialog"><p>This cannot be undone.</p><button>Cancel</button><button>Delete</button></div>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "pay on a page with no amount",
    path: "/account",
    html: `<h1>Your plan</h1><button>Pay</button>`,
    click: "button",
    expect: undefined,
  },
  {
    name: "pay bills menu link",
    path: "/",
    html: `<nav><a href="/bills">Pay bills</a></nav>`,
    click: "a",
    expect: undefined,
  },
  {
    name: "checkbox named publish",
    path: "/editor",
    html: `<label><input type="checkbox"> Publish</label>`,
    click: "input",
    expect: undefined,
  },
];

const reason = chromeUnavailable();

describe.skipIf(reason)(`last click with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  let home: Sandbox;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    home = sandbox();
    browser = await chromium.launch({ channel: "chrome", headless: true, env: chromeEnv(home.env) });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    home?.cleanup();
  });

  async function classify(f: Fixture) {
    await page.route("https://shop.test/**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><body>${f.html}</body>` }),
    );
    await page.goto(`https://shop.test${f.path}`);
    await page.unroute("https://shop.test/**");
    const target = await clickTargetOf(page, f.click);
    expect(target, f.name).toBeDefined();
    return classifyClick(target!);
  }

  it("leaves every act to the person, with what it does", async () => {
    const missed: string[] = [];
    for (const f of POSITIVE) {
      const click = await classify(f);
      if (click?.kind !== f.expect) missed.push(`${f.name}: ${click?.kind ?? "none"}`);
      else if (f.consequence) expect(click?.consequence, f.name).toContain(f.consequence);
    }
    expect(missed).toEqual([]);
  });

  it("never stops a harmless click that shares the words", async () => {
    const stopped: string[] = [];
    for (const f of NEGATIVE) {
      const click = await classify(f);
      if (click) stopped.push(`${f.name}: ${click.kind}`);
    }
    expect(stopped).toEqual([]);
  });
});

describe("lastClickRefusal", () => {
  it("names the act, the step to ask for and the switch", () => {
    const text = lastClickRefusal({
      click: { kind: "purchase", consequence: ["Total: $95.50"] },
      target: "e12",
      element: "Place order button",
      identity: "shop",
    });
    expect(text).toContain("This click would buy (it places an order or makes a payment) (Total: $95.50)");
    expect(text).toContain('"target":"e12"');
    expect(text).toContain('"requireHumanClick":true');
    expect(text).toContain("turno-browser set shop --last-click false");
  });
});
