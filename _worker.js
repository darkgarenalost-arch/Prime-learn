/**
 * Freedom Studio Publishing — ebook checkout backend (Cloudflare Worker)
 *
 * Routes (all under /api, everything else is served from /public by Workers Assets):
 *   GET  /api/config        -> public checkout config (key id, price label). No secrets.
 *   POST /api/create-order  -> creates a Razorpay order; amount/currency come from server env ONLY.
 *   POST /api/verify        -> verifies checkout signature + re-fetches payment from Razorpay; idempotent.
 *   POST /api/webhook       -> Razorpay webhook (raw-body HMAC verified), idempotent by event id.
 *   POST /api/access        -> exchanges a recovery key for a short-lived download token.
 *   POST /api/recover       -> payment id + email -> recovery key (verified against Razorpay).
 *   GET  /api/download?t=   -> streams the PDF from PRIVATE R2 if the short-lived token is valid.
 *
 * Secrets (wrangler secret put): RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, TOKEN_SECRET
 * Vars (wrangler.toml [vars]):   RAZORPAY_KEY_ID, PRODUCT_AMOUNT_MINOR, PRODUCT_CURRENCY, EBOOK_OBJECT_KEY, ...
 * Bindings:                      ORDERS (KV), EBOOK (R2, private)
 */

const PRODUCT_ID = "posture-reset-method";
const RAZORPAY_API = "https://api.razorpay.com/v1";
const DOWNLOAD_TOKEN_TTL_S = 300; // 5 minutes
const ID_RE = /^[A-Za-z0-9_]{6,64}$/;
const enc = new TextEncoder();

// ---------- small helpers ----------
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}
const hmacHex = async (s, m) => bytesToHex(await hmac(s, m));
const hmacB64u = async (s, m) => b64u(await hmac(s, m));

/** Constant-time string comparison. */
function safeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function requireConfig(env) {
  const missing = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "TOKEN_SECRET"].filter(
    (k) => !env[k]
  );
  return missing;
}

// Defaults: Rs 299.00 = 29900 paise INR. Override with PRODUCT_AMOUNT_MINOR / PRODUCT_CURRENCY if ever needed.
const amountMinor = (env) => parseInt(env.PRODUCT_AMOUNT_MINOR || "29900", 10);
const currency = (env) => String(env.PRODUCT_CURRENCY || "INR").toUpperCase();

async function razorpay(env, path, init = {}) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    ...init,
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {}
  return { ok: res.ok, status: res.status, body };
}

async function readJson(request, maxBytes = 8192) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large.");
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    throw new HttpError(400, "Invalid JSON.");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- order records (KV) ----------
const orderKey = (id) => `order:${id}`;
async function getOrder(env, id) {
  const raw = await env.ORDERS.get(orderKey(id));
  return raw ? JSON.parse(raw) : null;
}
const putOrder = (env, o) => env.ORDERS.put(orderKey(o.order_id), JSON.stringify(o));

// ---------- tokens (stateless, HMAC-signed, no secrets inside) ----------
/** Long-lived recovery key: only lets the holder request a *short-lived* download token for a PAID order. */
const recoveryKey = (env, orderId) => hmacB64u(env.TOKEN_SECRET, `recover|${orderId}`);

async function mintDownloadToken(env, orderId) {
  const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_S;
  const payload = `${orderId}.${exp}`;
  const sig = await hmacB64u(env.TOKEN_SECRET, `download|${payload}`);
  return `${payload}.${sig}`;
}

async function checkDownloadToken(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [orderId, exp, sig] = parts;
  if (!ID_RE.test(orderId) || !/^\d+$/.test(exp)) return null;
  const expected = await hmacB64u(env.TOKEN_SECRET, `download|${orderId}.${exp}`);
  if (!safeEqual(sig, expected)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return orderId;
}

// ---------- core: confirm a payment with Razorpay and fulfil (idempotent) ----------
/**
 * Never trusts the browser or the webhook payload. Fetches the payment from Razorpay and checks
 * order id, amount, currency and status against OUR stored order record.
 * Returns { state: 'paid' | 'pending' | 'failed', order }.
 */
async function confirmAndFulfil(env, orderId, paymentId, source) {
  const order = await getOrder(env, orderId);
  if (!order) throw new HttpError(404, "Unknown order.");

  // Idempotency: an already-fulfilled order stays fulfilled; a different payment id cannot hijack it.
  if (order.status === "paid") {
    if (order.payment_id !== paymentId) throw new HttpError(409, "Order already settled by another payment.");
    return { state: "paid", order };
  }

  const r = await razorpay(env, `/payments/${encodeURIComponent(paymentId)}`);
  if (!r.ok || !r.body) throw new HttpError(502, "Could not confirm the payment with Razorpay. Please retry in a moment.");
  const p = r.body;

  if (p.order_id !== orderId) throw new HttpError(400, "Payment does not belong to this order.");
  if (p.amount !== order.amount || String(p.currency).toUpperCase() !== order.currency)
    throw new HttpError(400, "Payment amount or currency mismatch.");

  if (p.status === "captured") {
    const fresh = await getOrder(env, orderId); // re-read to narrow the race window
    if (fresh.status === "paid") return { state: "paid", order: fresh };
    const updated = {
      ...fresh,
      status: "paid",
      payment_id: paymentId,
      email: (p.email || "").toLowerCase(),
      method: p.method || null,
      fulfilled_at: new Date().toISOString(),
      fulfilled_via: source,
    };
    await putOrder(env, updated);
    return { state: "paid", order: updated };
  }
  if (p.status === "failed") return { state: "failed", order };
  return { state: "pending", order }; // created / authorized — wait for capture (webhook will finish it)
}

// ---------- route handlers ----------
async function handleConfig(env) {
  return json({
    keyId: env.RAZORPAY_KEY_ID || null,
    amountMinor: amountMinor(env),
    currency: currency(env),
    productName: env.PRODUCT_NAME || "Fix Your Back & Neck Posture — The Posture Reset Method™",
    merchantName: env.MERCHANT_NAME || "Freedom Studio Publishing",
  });
}

async function handleCreateOrder(request, env) {
  const body = await readJson(request);
  if (body.productId !== PRODUCT_ID) throw new HttpError(400, "Unknown product."); // the client may NOT choose price
  const amount = amountMinor(env);
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(500, "Store is not configured.");

  const receipt = `pr_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const r = await razorpay(env, "/orders", {
    method: "POST",
    body: JSON.stringify({ amount, currency: currency(env), receipt, notes: { product: PRODUCT_ID } }),
  });
  if (!r.ok || !r.body?.id) {
    // Typical cause for USD: international payments not enabled on the Razorpay account.
    console.error("order create failed", r.status, JSON.stringify(r.body?.error || {}));
    throw new HttpError(502, "We couldn't start the payment. Please try again, or contact support if this continues.");
  }
  const order = {
    order_id: r.body.id,
    status: "created",
    amount: r.body.amount,
    currency: r.body.currency,
    product: PRODUCT_ID,
    created_at: new Date().toISOString(),
  };
  await putOrder(env, order);
  return json({ orderId: order.order_id, amount: order.amount, currency: order.currency });
}

async function handleVerify(request, env) {
  const b = await readJson(request);
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = b;
  if (![orderId, paymentId].every((v) => ID_RE.test(String(v || ""))) || !signature)
    throw new HttpError(400, "Missing payment details.");

  // Official Razorpay check: HMAC_SHA256(order_id + "|" + payment_id, key_secret) === signature
  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
  if (!safeEqual(expected, String(signature).toLowerCase())) throw new HttpError(400, "Payment signature could not be verified.");

  const result = await confirmAndFulfil(env, orderId, paymentId, "checkout");
  if (result.state === "paid") {
    return json({
      status: "paid",
      orderId,
      recoveryKey: await recoveryKey(env, orderId),
      downloadToken: await mintDownloadToken(env, orderId),
    });
  }
  if (result.state === "failed") return json({ status: "failed" }, 402);
  return json({ status: "pending" }, 202);
}

async function handleWebhook(request, env) {
  const raw = await request.text(); // RAW body, exactly as sent
  const sig = request.headers.get("x-razorpay-signature") || "";
  if (!env.RAZORPAY_WEBHOOK_SECRET) throw new HttpError(503, "Webhook not configured.");
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, sig.toLowerCase())) throw new HttpError(400, "Bad signature.");

  const eventId = request.headers.get("x-razorpay-event-id");
  if (eventId) {
    const seen = await env.ORDERS.get(`evt:${eventId}`);
    if (seen) return json({ ok: true, duplicate: true });
  }

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch (_) {
    throw new HttpError(400, "Bad payload.");
  }
  if (evt.event === "payment.captured" || evt.event === "order.paid") {
    const pay = evt.payload?.payment?.entity;
    // Only identifiers are taken from the payload. Everything else is re-fetched and checked.
    if (pay && ID_RE.test(pay.id || "") && ID_RE.test(pay.order_id || "")) {
      const known = await getOrder(env, pay.order_id);
      if (known) await confirmAndFulfil(env, pay.order_id, pay.id, "webhook");
      // Unknown order ids (e.g. other products on the same account) are ignored on purpose.
    }
  }
  if (eventId) await env.ORDERS.put(`evt:${eventId}`, "1", { expirationTtl: 60 * 60 * 24 * 7 });
  return json({ ok: true });
}

async function handleAccess(request, env) {
  const { orderId, key } = await readJson(request);
  if (!ID_RE.test(String(orderId || "")) || !key) throw new HttpError(400, "Invalid link.");
  if (!safeEqual(await recoveryKey(env, orderId), key)) throw new HttpError(403, "Invalid link.");
  const order = await getOrder(env, orderId);
  if (!order || order.status !== "paid") throw new HttpError(402, "This order has no verified payment yet.");
  return json({ status: "paid", downloadToken: await mintDownloadToken(env, orderId) });
}

/** Lost the tab/link? payment id (from Razorpay's receipt email) + the email used at checkout. */
async function handleRecover(request, env) {
  const { paymentId, email } = await readJson(request);
  if (!ID_RE.test(String(paymentId || "")) || !/^[^@\s]+@[^@\s]+$/.test(String(email || "")))
    throw new HttpError(400, "Enter your Razorpay payment ID and the email used at checkout.");
  const generic = new HttpError(404, "We couldn't match those details to a completed payment.");
  const r = await razorpay(env, `/payments/${encodeURIComponent(paymentId)}`);
  if (!r.ok || !r.body) throw generic;
  const p = r.body;
  if (p.status !== "captured" || String(p.email || "").toLowerCase() !== email.trim().toLowerCase()) throw generic;
  const order = await getOrder(env, p.order_id);
  if (!order || order.product !== PRODUCT_ID) throw generic;
  const result = await confirmAndFulfil(env, order.order_id, paymentId, "recovery");
  if (result.state !== "paid") throw generic;
  return json({
    status: "paid",
    orderId: order.order_id,
    recoveryKey: await recoveryKey(env, order.order_id),
    downloadToken: await mintDownloadToken(env, order.order_id),
  });
}

async function handleDownload(request, env) {
  const token = new URL(request.url).searchParams.get("t");
  const orderId = await checkDownloadToken(env, token);
  if (!orderId) return new Response("Download link is invalid or has expired. Return to the site to get a fresh one.", { status: 403 });
  const order = await getOrder(env, orderId);
  if (!order || order.status !== "paid") return new Response("Payment not verified.", { status: 402 });

  const obj = await env.EBOOK.get(env.EBOOK_OBJECT_KEY || "posture-reset-method.pdf");
  if (!obj) {
    console.error("ebook object missing in R2");
    return new Response("The file is temporarily unavailable. Please contact support with your order ID.", { status: 500 });
  }
  const filename = env.EBOOK_DOWNLOAD_FILENAME || "Fix-Your-Back-and-Neck-Posture-The-Posture-Reset-Method.pdf";
  return new Response(obj.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(obj.size != null ? { "content-length": String(obj.size) } : {}),
    },
  });
}

// ---------- entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }
    try {
      const missing = requireConfig(env);
      if (missing.length) {
        console.error("Missing config:", missing.join(", "));
        throw new HttpError(503, "Store is not configured yet.");
      }
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "GET /api/config":
          return await handleConfig(env);
        case "POST /api/create-order":
          return await handleCreateOrder(request, env);
        case "POST /api/verify":
          return await handleVerify(request, env);
        case "POST /api/webhook":
          return await handleWebhook(request, env);
        case "POST /api/access":
          return await handleAccess(request, env);
        case "POST /api/recover":
          return await handleRecover(request, env);
        case "GET /api/download":
          return await handleDownload(request, env);
        default:
          return json({ error: "Not found." }, 404);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("unhandled", e && e.stack);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};
