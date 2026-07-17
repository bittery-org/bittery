# Marketing site prototypes — notes

**Question being answered:** which positioning angle should lead the rebuilt marketing site — craft, privacy, or engineering transparency?

Three throwaway vanilla-HTML variants of the landing page, each testing one angle. Open `index.html` (tabs M1–M3) or any `marketing-*.html` directly; `←`/`→` and the floating pill cycle between them.

| Variant | File | Angle | Hero | Structure |
|---|---|---|---|---|
| M1 · Craft | `marketing-1-craft.html` | "The Linear of password managers" — design as proof of engineering rigor | "The password manager, redesigned." | Centered hero → recreated app window (Sentinel money shot) → bento grid → receipts strip → pricing cards |
| M2 · Privacy | `marketing-2-privacy.html` | Zero-knowledge as *inability*, not policy | "The password manager that can't spy on you." | Editorial manifesto: device→wire→server pipeline diagram → numbered manifesto (01–04) → FAQ → pricing table rows |
| M3 · Engineering | `marketing-3-engineering.html` | Transparency for a dev beachhead; anti-enterprise-drift | "Zero-knowledge. Rust core. No compromises." | Ruled spec-sheet: terminal self-host → crypto datasheet → one-core/five-targets diagram → comparison matrix → cloud-vs-self-host pricing |

## Research summary (July 2026)

**Market (web research):** 1Password/Dashlane/Bitwarden have pivoted homepages to enterprise + "humans and AI agents" messaging; nobody credible competes on consumer craft (only Apple-native indie "Secrets"). Proton Pass owns privacy at scale (100M users) — hard to out-Proton on privacy alone. Passkey story should be hybrid ("passwords *and* passkeys"), not "passwords are dead". Recommended synthesis: **lead with craft, substantiate with engineering receipts, keep zero-knowledge as table-stakes proof.** Landing-page must-haves for a security product: dedicated security page, zero-knowledge stated as inability, exactly ~3 trust elements above the fold, data-portability answer in the FAQ, pricing on the landing page, comparison matrix (Proton-proven), real screenshots over illustration.

**Product facts used (from repo):** Sentinel dashboard (score tiers → FORTIFIED, prioritized briefing), Travel Mode, two-key protection (master password + Secret Key), AES-256-GCM w/ context-bound AAD, PBKDF2-SHA256 310k → HKDF, SRP-6a, RSA-4096-OAEP sharing, single Rust crypto core (WASM/native/Expo, zeroize), Emergency Kit / Recovery Key, share links (expiry, one-time, verified recipients, access logs), offline sync, biometric unlock, self-host via Docker (no subscription), license FSL-1.1-ALv2 → Apache-2.0, pricing Free / $3 Personal / $7 Family / $6 per-user Team.

**Decisions made (user):** 3 landing-page variants, one angle each; designed for post-launch (real CTA + pricing, not waitlist); confirmed platform claims only (Web, macOS, Windows, iOS, Android, Chrome).

## Caveats before any of this ships

- Competitor comparison prices/claims in M3 were drafted from public pages July 2026 — **re-verify every cell** before publishing.
- GitHub star count (★ 2.8k) in M3 is a placeholder.
- "6-phase security audit, published" refers to the *internal* audit in `docs/security-audit/` — don't let copy imply a third-party audit.
- Testimonials intentionally omitted (existing ones in `apps/marketing` look like placeholders).
- Pages use the Google Fonts CDN like the other explorations; the real site must self-host Inter per DESIGN.md.
- Product is still closed beta — CTAs assume public launch.

## Verdict

**M1 · Craft won** (user decision, 2026-07-16). Direction: rebuild `apps/marketing` on the M1 structure, with real recreated app markup ("screenshots" as live components) and animated product demos instead of static art.
