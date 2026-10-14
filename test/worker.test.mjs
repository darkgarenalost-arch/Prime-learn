// Run: node --test test/worker.test.mjs   (Node 20+). Uses FAKE secrets and a mocked Razorpay API.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/worker.js";

const SECRET = "fake_key_secret", WH = "fake_webhook_secret";
const kv = new Map();
const env = {
  RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: WH, TOKEN_SECRET: "tok_secret_for_tests",
  PRODUCT_AMOUNT_MINOR: "29900", PRODUCT_CURRENCY: "INR", EBOOK_OBJECT_KEY: "book.pdf",
  ORDERS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
  EBOOK: { get: async (k) => (k === "book.pdf" ? { body: new Response("%PDF-1.7 fake").body, size: 13 } : null) },
};

// ---- mocked Razorpay ----
const payments = {}; let orderSeq = 0; let lastOrderBody = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  assert.ok(init.headers.authorization.startsWith("Basic "));
  if (u.endsWith("/orders")) {
    lastOrderBody = JSON.parse(init.body);
    return Response.json({ id: `order_TEST${++orderSeq}abc`, amount: lastOrderBody.amount, currency: lastOrderBody.currency });
  }
  const m = u.match(/\/payments\/(.+)$/);
  if (m && payments[m[1]]) return Response.json(payments[m[1]]);
  return Response.json({ error: {} }, { status: 400 });
};

const call = (method, path, body, headers = {}) =>
  worker.fetch(new Request("https://shop.test" + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
const sig = (o, p) => createHmac("sha256", SECRET).update(`${o}|${p}`).digest("hex");
async function newOrder() { const r = await call("POST", "/api/create-order", { productId: "posture-reset-method", amount: 1 }); return (await r.json()).orderId; }

test("create-order uses server price/currency and ignores client amount", async () => {
  const id = await newOrder();
  assert.match(id, /^order_/);
  assert.equal(lastOrderBody.amount, 29900);
  assert.equal(lastOrderBody.currency, "INR");
});

test("create-order rejects unknown product", async () => {
  assert.equal((await call("POST", "/api/create-order", { productId: "x" })).status, 400);
});

test("invalid signature is rejected and nothing is unlocked", async () => {
  const id = await newOrder(); payments.pay_BAD123456 = { id: "pay_BAD123456", order_id: id, amount: 29900, currency: "INR", status: "captured", email: "a@b.co" };
  const r = await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: "pay_BAD123456", razorpay_signature: "deadbeef" });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(kv.get(`order:${id}`)).status, "created");
});

test("valid signature + captured payment -> paid, token downloads the PDF; repeat is idempotent", async () => {
  const id = await newOrder(); const pid = "pay_OK1234567";
  payments[pid] = { id: pid, order_id: id, amount: 29900, currency: "INR", status: "captured", email: "Buyer@Example.com" };
  const body = { razorpay_order_id: id, razorpay_payment_id: pid, razorpay_signature: sig(id, pid) };
  const r1 = await call("POST", "/api/verify", body); const j1 = await r1.json();
  assert.equal(r1.status, 200); assert.equal(j1.status, "paid");
  const fulfilledAt = JSON.parse(kv.get(`order:${id}`)).fulfilled_at;
  const r2 = await call("POST", "/api/verify", body); assert.equal((await r2.json()).status, "paid");
  assert.equal(JSON.parse(kv.get(`order:${id}`)).fulfilled_at, fulfilledAt, "fulfilment record must not be rewritten");
  const d = await call("GET", "/api/download?t=" + encodeURIComponent(j1.downloadToken));
  assert.equal(d.status, 200); assert.equal(d.headers.get("content-type"), "application/pdf");
  assert.match(d.headers.get("content-disposition"), /attachment/); assert.equal(await d.text(), "%PDF-1.7 fake");
});

test("amount or currency mismatch is rejected", async () => {
  const id = await newOrder(); const pid = "pay_MISMATCH1";
  payments[pid] = { id: pid, order_id: id, amount: 29900, currency: "USD", status: "captured" };
  const r = await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: pid, razorpay_signature: sig(id, pid) });
  assert.equal(r.status, 400);
});

test("failed / authorized payments do not unlock", async () => {
  const id = await newOrder();
  payments.pay_FAILED001 = { id: "pay_FAILED001", order_id: id, amount: 29900, currency: "INR", status: "failed" };
  let r = await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: "pay_FAILED001", razorpay_signature: sig(id, "pay_FAILED001") });
  assert.equal(r.status, 402);
  payments.pay_AUTH00001 = { id: "pay_AUTH00001", order_id: id, amount: 29900, currency: "INR", status: "authorized" };
  r = await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: "pay_AUTH00001", razorpay_signature: sig(id, "pay_AUTH00001") });
  assert.equal(r.status, 202);
  assert.equal(JSON.parse(kv.get(`order:${id}`)).status, "created");
});

test("a second payment id cannot hijack an already-paid order", async () => {
  const id = await newOrder();
  for (const pid of ["pay_FIRST00001", "pay_SECOND0001"]) payments[pid] = { id: pid, order_id: id, amount: 29900, currency: "INR", status: "captured" };
  await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: "pay_FIRST00001", razorpay_signature: sig(id, "pay_FIRST00001") });
  const r = await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: "pay_SECOND0001", razorpay_signature: sig(id, "pay_SECOND0001") });
  assert.equal(r.status, 409);
});

test("download without / with forged / expired token is refused", async () => {
  assert.equal((await call("GET", "/api/download")).status, 403);
  assert.equal((await call("GET", "/api/download?t=order_X1234567.9999999999.forged")).status, 403);
  const id = await newOrder();
  const past = Math.floor(Date.now() / 1000) - 10;
  const mac = createHmac("sha256", env.TOKEN_SECRET).update(`download|${id}.${past}`).digest("base64url");
  assert.equal((await call("GET", `/api/download?t=${id}.${past}.${mac}`)).status, 403, "expired but correctly signed");
  const fut = past + 600; const mac2 = createHmac("sha256", env.TOKEN_SECRET).update(`download|${id}.${fut}`).digest("base64url");
  assert.equal((await call("GET", `/api/download?t=${id}.${fut}.${mac2}`)).status, 402, "valid token but order unpaid");
});

test("webhook: bad signature rejected; valid one fulfils; duplicate event is a no-op", async () => {
  const id = await newOrder(); const pid = "pay_WEBHOOK001";
  payments[pid] = { id: pid, order_id: id, amount: 29900, currency: "INR", status: "captured", email: "w@x.co" };
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: id } } } });
  assert.equal((await call("POST", "/api/webhook", raw, { "x-razorpay-signature": "nope", "x-razorpay-event-id": "evt1" })).status, 400);
  const good = createHmac("sha256", WH).update(raw).digest("hex");
  const h = { "x-razorpay-signature": good, "x-razorpay-event-id": "evt_A" };
  assert.equal((await call("POST", "/api/webhook", raw, h)).status, 200);
  assert.equal(JSON.parse(kv.get(`order:${id}`)).status, "paid");
  const dup = await (await call("POST", "/api/webhook", raw, h)).json(); assert.equal(dup.duplicate, true);
});

test("webhook cannot fulfil on a forged payload (payment not captured at Razorpay)", async () => {
  const id = await newOrder(); const pid = "pay_FORGED0001";
  payments[pid] = { id: pid, order_id: id, amount: 29900, currency: "INR", status: "created" };
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: id, status: "captured" } } } });
  await call("POST", "/api/webhook", raw, { "x-razorpay-signature": createHmac("sha256", WH).update(raw).digest("hex") });
  assert.equal(JSON.parse(kv.get(`order:${id}`)).status, "created");
});

test("recovery key and payment-id+email recovery (tab closed scenario)", async () => {
  const id = await newOrder(); const pid = "pay_RECOVER001";
  payments[pid] = { id: pid, order_id: id, amount: 29900, currency: "INR", status: "captured", email: "Me@Mail.com" };
  const v = await (await call("POST", "/api/verify", { razorpay_order_id: id, razorpay_payment_id: pid, razorpay_signature: sig(id, pid) })).json();
  assert.equal((await call("POST", "/api/access", { orderId: id, key: "wrong" })).status, 403);
  const a = await call("POST", "/api/access", { orderId: id, key: v.recoveryKey }); assert.equal(a.status, 200);
  assert.equal((await call("POST", "/api/recover", { paymentId: pid, email: "other@mail.com" })).status, 404);
  const ok = await call("POST", "/api/recover", { paymentId: pid, email: "me@mail.com" }); assert.equal(ok.status, 200);
});

test("no secret ever appears in the frontend", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!/key_secret|rzp_live|rzp_test|RAZORPAY_KEY_SECRET/i.test(html));
});
