# NUTEX design system

Style: **glass + depth**, from the UI/UX Pro Max recommendation for a modern SaaS dashboard (trust blue with an orange accent, glass surfaces, restrained complex motion). Everything is plain CSS in `apps/web/app/globals.css` plus two tiny client helpers in `apps/web/components/Fx.tsx`. No animation library.

## Tokens
| Token | Dark | Light |
|---|---|---|
| `--bg` | `#050816` | `#eef3ff` |
| `--text` / `--text-dim` | `#eaf0ff` / `#9aa9cc` | `#0f1a3a` / `#51608a` |
| `--brand` (links, focus, accents) | `#5b95ff` | `#2563eb` |
| `--btn-a` → `--btn-b` (primary button, white text, 5:1 or better) | `#2f66e8` → `#6a35e8` | `#2563eb` → `#6d28d9` |
| `--accent` | `#ff8a3d` | `#ea580c` |

`packages/ui/src/index.ts` mirrors the palette; `apps/web/tests/web-lib.test.ts` asserts the WCAG AA contrast of the pairs. Change both together.

## Depth and motion (what is where)
- **Living background**: three drifting light orbs plus a faint grid (`body::before/::after`), transform-only so it stays on the GPU.
- **Glass cards**: blur, 1px light edge, deep shadow. A light follows the pointer (`--px/--py`), and small cards tilt in 3D toward it (`--rx/--ry`, set by `FxProvider`).
- **Page entrance**: every section of `.content` rises in, staggered.
- **Login**: a rotating 3D cube (six faces: location, time, check, pay, people, security), two orbit rings and floating particles; the scene follows the pointer. On phones the sign-in form comes first.
- **Check-in key** (`.punch-btn`): raised 3D key with radar rings while idle, pressed-in on click, breathing while it works.
- **KPIs** count up (`CountUp`), tabs get a sliding gradient underline, modals pop in with perspective, toasts slide in.

## Accessibility and performance rules
- `prefers-reduced-motion: reduce` switches every animation and transition off and removes the tilt (`FxProvider` does nothing at all).
- The tilt runs only with a real mouse (`hover: hover` and `pointer: fine`) and never on tall cards or tables.
- Blur is lighter on phones; no new fonts or scripts are loaded (the CSP stays `default-src 'self'`).
- Contrast: body text and the primary button text meet WCAG AA in both themes. Focus rings stay visible.
