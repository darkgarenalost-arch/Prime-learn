// Freedom Studio Publishing — secure payment + delivery backend (Cloudflare Worker)
// Secrets required (set with `npx wrangler secret put`):
//   RAZORPAY_KEY_SECRET  -> from Razorpay dashboard (rotated key)
//   TOKEN_SECRET         -> any long random string (signs download tokens)
// The PDF is bundled privately into this Worker; there is no public URL for it.

import EBOOK from "./posture-reset-method-k7q2x9.pdf";

const PRODUCT = {
  id: "posture-reset",
  amount: 19900,            // paise  => ₹199.00 (server decides price, never the browser)
  currency: "INR",
  filename: "Fix-Your-Back-and-Neck-Posture.pdf",
  description: "Fix Your Back & Neck Posture — The Posture Reset Method™",
};
const TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const enc = new TextEncoder();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, "0")).join("");

async function rzp(env, path, method = "GET", body) {
  const res = await fetch("https://api.razorpay.com/v1" + path, {
    method,
    headers: {
      Authorization: "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function makeToken(env, paymentId) {
  const payload = b64url(enc.encode(JSON.stringify({ p: paymentId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })));
  const sig = b64url(await hmac(env.TOKEN_SECRET, payload));
  return `${payload}.${sig}`;
}
async function checkToken(env, token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = await hmac(env.TOKEN_SECRET, payload);
  let given;
  try { given = fromB64url(sig); } catch { return false; }
  if (!safeEqual(expected, given)) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch { return false; }
}

// Confirms with Razorpay that this payment is genuinely paid for OUR product.
async function confirmPayment(env, paymentId) {
  const p = await rzp(env, `/payments/${paymentId}`);
  if (!p.ok) return { ok: false, reason: "Payment not found." };
  let pay = p.data;

  if (pay.currency !== PRODUCT.currency || pay.amount !== PRODUCT.amount)
    return { ok: false, reason: "Payment amount or currency mismatch." };

  if (pay.status === "authorized") {
    const cap = await rzp(env, `/payments/${paymentId}/capture`, "POST", { amount: PRODUCT.amount, currency: PRODUCT.currency });
    if (!cap.ok) return { ok: false, pending: true, reason: "Payment is authorised but not yet captured." };
    pay = cap.data;
  }
  if (pay.status !== "captured") return { ok: false, pending: pay.status === "created", reason: `Payment status: ${pay.status}.` };

  const o = await rzp(env, `/orders/${pay.order_id}`);
  if (!o.ok || o.data.notes?.product !== PRODUCT.id || o.data.amount !== PRODUCT.amount || o.data.currency !== PRODUCT.currency)
    return { ok: false, reason: "Order does not match this product." };

  return { ok: true, payment: pay };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.RAZORPAY_KEY_SECRET || !env.TOKEN_SECRET) return json({ error: "Server is not configured." }, 500);

    try {
      // 1) Create order — amount is fixed on the server
      if (path === "/api/create-order" && request.method === "POST") {
        const r = await rzp(env, "/orders", "POST", {
          amount: PRODUCT.amount,
          currency: PRODUCT.currency,
          receipt: "rcpt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          notes: { product: PRODUCT.id },
        });
        if (!r.ok) return json({ error: "Could not start checkout. Please try again." }, 502);
        return json({
          orderId: r.data.id, amount: PRODUCT.amount, currency: PRODUCT.currency,
          keyId: env.RAZORPAY_KEY_ID, description: PRODUCT.description,
        });
      }

      // 2) Verify signature + confirm with Razorpay, then issue a short-lived download token
      if (path === "/api/verify" && request.method === "POST") {
        const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = await request.json();
        if (!/^order_\w+$/.test(oid || "") || !/^pay_\w+$/.test(pid || "") || !/^[0-9a-f]{64}$/.test(sig || ""))
          return json({ error: "Invalid payment details." }, 400);

        const expected = await hmac(env.RAZORPAY_KEY_SECRET, `${oid}|${pid}`);
        if (!safeEqual(enc.encode(hex(expected)), enc.encode(sig))) return json({ error: "Payment signature could not be verified." }, 400);

        const c = await confirmPayment(env, pid);
        if (!c.ok) return json({ error: c.reason, pending: !!c.pending }, c.pending ? 202 : 400);
        if (c.payment.order_id !== oid) return json({ error: "Order mismatch." }, 400);

        const token = await makeToken(env, pid);
        return json({ ok: true, paymentId: pid, token, downloadUrl: `/api/download?t=${token}` });
      }

      // 3) Recovery: payment ID + the email used at checkout
      if (path === "/api/recover" && request.method === "POST") {
        const { paymentId, email } = await request.json();
        if (!/^pay_\w{10,}$/.test(paymentId || "") || !/^\S+@\S+\.\S+$/.test(email || ""))
          return json({ error: "Please enter a valid payment ID and email." }, 400);
        const c = await confirmPayment(env, paymentId.trim());
        if (!c.ok || (c.payment.email || "").trim().toLowerCase() !== email.trim().toLowerCase())
          return json({ error: "We couldn't match those details to a successful payment." }, 404);
        const token = await makeToken(env, paymentId.trim());
        return json({ ok: true, paymentId, token, downloadUrl: `/api/download?t=${token}` });
      }

      // 4) Authorised download
      if (path === "/api/download" && request.method === "GET") {
        if (!(await checkToken(env, url.searchParams.get("t")))) return new Response("Download link is invalid or expired.", { status: 403 });
        return new Response(EBOOK, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${PRODUCT.filename}"`,
            "Cache-Control": "private, no-store",
            "X-Robots-Tag": "noindex",
          },
        });
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};
