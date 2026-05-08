# docs/

GitHub Pages source for the Tokextract / `conorluddy` marketplace landing page.

## Stack

No build step. The page is static HTML + React (UMD) + Babel-standalone, all loaded from CDN. Edit content in `src/data.js`, layout in `src/sections.jsx`, design tokens in `tokens.css`, base styles in `styles.css`.

```
docs/
├── index.html       Host page; loads React UMD + Babel from unpkg, mounts <div id="root">
├── tokens.css       Design tokens (colors, spacing, type scale)
├── styles.css       Base styles + component classes (vt- prefix)
├── src/
│   ├── data.js          Content loaded into a window.TOKEXTRACT global
│   ├── primitives.jsx   Mark logo, Section, Pill, Frame, Pre, Stat
│   ├── diagrams.jsx     Vestige-era figure components (mostly unused on this page)
│   ├── interactive.jsx  Interactive widgets
│   ├── sections.jsx     One function per landing section (Bar, Hero, What, …)
│   └── app.jsx          Composes sections, mounts to #root
└── assets/              Images (favicon, social card, screenshots) — populate later
```

## Provenance

Scaffolding lifted from `/Users/conor/Development/Vestige/docs` on 2026-05-08. Same React-via-CDN pattern, same primitives, same `vt-` CSS class prefix. The prefix is intentionally not rebranded for v1 plumbing — it's not user-facing and a rename would just be churn. Revisit if Tokextract gets its own visual identity later.

When pulling future improvements from upstream Vestige (better primitives, new patterns), pull file-by-file rather than wholesale — Tokextract content has diverged in `data.js`, `sections.jsx`, and `app.jsx`.

## Local preview

```bash
python3 -m http.server -d docs 8080
# Then open http://localhost:8080
```

Any modern browser works (React 18 UMD + Babel standalone). Babel transforms JSX in-browser, so first paint is slightly delayed — acceptable for a landing page.

## Updating content

- **Copy / numbers / pitch:** edit `src/data.js`. Single source of truth.
- **Section order or layout:** edit `src/sections.jsx` (or `src/app.jsx` for the composition itself).
- **Colors / typography / spacing tokens:** edit `tokens.css`.
- **Component-class styles:** edit `styles.css`.
- **New section:** add a function to `sections.jsx`, add corresponding content to `data.js`, then mount in `app.jsx`.

## GitHub Pages config (when ready)

When the Extoken repo gets pushed to GitHub, enable Pages with **Deploy from branch** → `main` → `/docs`. Site goes live at `https://conorluddy.github.io/Extoken/`.

For a custom domain (e.g. `tokextract.com`), add a `CNAME` file to this directory and configure DNS at the registrar.

## Deferred

- **Analytics tag.** Vestige's `G-C1XLTQ3SS1` Google Analytics ID was stripped during the lift. Add a Tokextract-owned tag (Plausible, Fathom, or fresh GA) when going public.
- **Open-graph / Twitter card metadata.** Add to `index.html` `<head>` once content stabilizes.
- **Favicon + social card image.** Drop into `assets/` and reference from `index.html`.
- **Visual rebrand from `vt-` prefix to `tx-`.** Cosmetic; defer.
