# StreamGram landing page

Standalone HTML/CSS/JavaScript. No build step, backend, analytics, signup processing, or credentials. This folder is versioned in the repository. Configure your static host to serve `landing-page/` as its site directory.

## Local preview

From the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory landing-page
```

Open http://127.0.0.1:4173. Stop with Ctrl+C. Any static host can serve this directory unchanged.

## Languages

Use `?lng=en`, `?lng=he`, `?lng=ru`, or `?lng=ar`. A supported URL language overrides the saved landing-page preference. Otherwise the saved preference is used, with English as the default. The selector saves the preference under `streamgram.landing.language` and preserves other query parameters and anchors. Browser back/forward restores URL language. Hebrew and Arabic use RTL.

Edit copy in `translations.js`. Keep exactly the same keys in all four dictionaries. This includes image descriptions, navigation labels, document title, and meta description. Product names remain unchanged across languages. Search language inside the application is a separate setting.

## Links and assets

Edit destinations in `config.js`. The trial currently opens https://dev.taildfc218.ts.net, exactly as supplied; availability, registration, and seven-day access enforcement belong to that instance. Never use a personal addon token or an admin invite as a public marketing link. If the trial destination changes, update the no-JavaScript fallback in `index.html` too.

`assets/logo.png` is a copy of the project's transparent logo. The product illustration is original HTML/CSS artwork and is labeled as an illustration; it does not depict real account data. Inline outline icons follow Lucide-style geometry; no external fonts, images, scripts, or libraries are loaded.

Hosting benefits describe InstaPods' published HTTPS, persistent storage, always-on, and Git deployment capabilities (https://instapods.com). Pricing links to the provider instead of embedding time-sensitive prices or offers. No claim is made that a specific plan meets all streaming workloads.

## Checks

Verify all four languages on desktop and mobile, including 320px width, and both RTL layouts. Check FAQ keyboard interaction, focus visibility, reduced-motion mode, link destinations, and language query precedence. No build step is required; publish the contents of `landing-page/`.
