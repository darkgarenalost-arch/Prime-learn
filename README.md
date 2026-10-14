# Posture Reset Method — ebook store

- `public/index.html` — the whole frontend (HTML + CSS + JS in one file). `public/assets/` holds the cover and 3 real preview pages.
- `src/worker.js` — Cloudflare Worker: order creation, signature verification, webhook, recovery, private PDF delivery.
- `wrangler.toml` — config (public vars + bindings). `test/worker.test.mjs` — 12 backend tests (`node --test test/worker.test.mjs`).

## Architecture
Browser → `/api/create-order` (server sets ₹299 INR) → Razorpay Checkout → `/api/verify` (HMAC check + re-fetch payment from Razorpay, checks order/amount/currency/status) → 5-minute signed download token → `/api/download` streams the PDF from a **private R2 bucket**. Webhook `/api/webhook` finishes orders if the buyer closes the tab. KV stores order records (idempotency + support audit).

## Environment
| Name | Where | Value |
|---|---|---|
| `RAZORPAY_KEY_ID` | wrangler.toml [vars] | Key ID (public) |
| `PRODUCT_AMOUNT_MINOR` / `PRODUCT_CURRENCY` | [vars] | `29900` / `INR` |
| `RAZORPAY_KEY_SECRET` | **secret** | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | **secret** | the secret you type when creating the webhook |
| `TOKEN_SECRET` | **secret** | `openssl rand -hex 32` |

## Setup (about 15 minutes)
1. Install: `npm i -g wrangler` then `wrangler login`.
2. `cd posture-reset-store`
3. `wrangler kv namespace create ORDERS` → paste the id into `wrangler.toml`.
4. `wrangler r2 bucket create posture-ebook-private` (leave private; no public URL).
5. Upload the PDF: `wrangler r2 object put posture-ebook-private/posture-reset-method.pdf --file "./Your-Final-Ebook.pdf" --content-type application/pdf --remote`
6. Secrets: `wrangler secret put RAZORPAY_KEY_SECRET`, `... RAZORPAY_WEBHOOK_SECRET`, `... TOKEN_SECRET`.
7. **Start in Test Mode**: set `RAZORPAY_KEY_ID` to your `rzp_test_...` key and use the test secret.
8. `wrangler deploy`. Add your domain under Workers → Settings → Domains.
9. Razorpay Dashboard → Settings → Webhooks → add `https://YOUR-DOMAIN/api/webhook`, events `payment.captured` and `order.paid`, and the same webhook secret as step 6.
10. Replace `YOUR-DOMAIN.example` in `index.html` (canonical / Open Graph), add `assets/og-image.jpg` (1200×630), real legal text (placeholders are highlighted yellow).
11. Run the test plan below, then switch to the live Key ID + live secret and redeploy.

## Currency
Price is ₹299 INR (29900 paise), which every Razorpay account supports, so no international-payments setup is needed. Overseas cards are only accepted if International Payments is enabled on your account; otherwise buyers from abroad may be declined.

## Meta Pixel
Pixel `2104801253414514` is set in `index.html` (`PIXEL_ID`). Events: `PageView`, `ViewContent` (on load), `InitiateCheckout` (Buy click), `Purchase` (only after the server verifies payment; `eventID` = Razorpay order id for deduplication). Verify in Events Manager → Test Events, or with the Meta Pixel Helper extension.

## Test plan (Test Mode)
1. Page renders on desktop and phone; nav, Buy buttons, FAQ, footer dialogs work.
2. Click Buy → Razorpay opens; double-click does not create two orders.
3. Close the popup / use a failing test card → no download appears.
4. Use a successful test payment → "Payment successful!" and the download gives the right PDF.
5. Open the personal link in a new browser → download works. Try the Recover form with payment id + email.
6. Open `/api/download` with no token or an altered token → 403. Confirm the R2 bucket has no public access.
7. Webhook: Razorpay dashboard → Webhooks → resend an event → 200, no duplicate record.
8. Price shown (₹299) equals charged amount and currency in the Razorpay dashboard.
9. View page source: no secret.

Automated: backend tests 1-12 (signature rejection, mismatch, idempotency, forged webhook, token expiry, recovery) passed locally against a mocked Razorpay. Not yet run: real Razorpay calls, real R2/KV, real checkout popup.

## Decisions / items needed from you
- Final PDF (export from Word; see note in chat about the cover page layout).
- Real Privacy, Terms and Refund text; domain; OG image; optional Meta Pixel ID (`PIXEL_ID` in the script).
- Optional hardening: Cloudflare rate-limiting rule on `/api/recover` and `/api/create-order`.
