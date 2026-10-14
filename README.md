# Deploy (Cloudflare Workers, flat folder — no sub-folders)

Files in ONE folder: index.html, worker.js, wrangler.toml, .assetsignore, README.md,
cover.jpg  (your ebook cover),  posture-reset-method-k7q2x9.pdf  (your ebook)

1. Install Node.js, then in this folder run:
   npx wrangler login
2. Add secrets (you'll be prompted to paste each value; they are NOT stored in any file):
   npx wrangler secret put RAZORPAY_KEY_SECRET     <- your NEW rotated secret
   npx wrangler secret put TOKEN_SECRET            <- any long random string (e.g. 40+ chars)
3. Deploy:
   npx wrangler deploy
4. Attach your domain: Cloudflare dashboard -> Workers -> freedom-posture-reset -> Settings -> Domains.
5. In index.html replace https://YOUR-DOMAIN.com/cover.jpg in og:image with your real domain.
6. Replace the policy placeholders (Privacy / Terms / Refund) with your real text.

Notes
- The PDF is bundled privately inside the Worker; .assetsignore keeps it (and worker.js) off the public site.
- If your PDF is large (Free plan Worker limit ~3 MB compressed, Paid ~10 MB), tell me and I'll switch delivery to a private R2 bucket.

# Test plan (use Razorpay TEST keys first: swap RAZORPAY_KEY_ID in wrangler.toml + secret, redeploy)
1. Page renders on desktop/mobile; nav, FAQ, sticky CTA work.
2. Click Buy -> Razorpay opens (order created server-side, ₹199 INR).
3. Close popup / fail a payment (test card failure) -> no download appears.
4. Tamper: POST /api/verify with a wrong signature -> 400.
5. Successful test payment -> "Payment successful!" + Download button -> correct PDF.
6. Press Download repeatedly / call /api/verify twice -> same result, nothing duplicated (stateless + idempotent).
7. Visit /posture-reset-method-k7q2x9.pdf directly -> 404 (not public). /api/download without token -> 403.
8. Close the tab after paying -> "Recover your download" with pay_ ID + email -> download works.
9. Meta Pixel Helper: PageView, ViewContent, InitiateCheckout, Purchase (once, only after verification).
10. Checkout amount shown = ₹199 INR.
