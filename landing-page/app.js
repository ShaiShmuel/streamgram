(() => {
  'use strict';
  const translations = window.STREAMGRAM_TRANSLATIONS;
  const links = window.STREAMGRAM_LINKS;
  const storageKey = 'streamgram.landing.language';
  const supported = ['en', 'he', 'ru', 'ar'];
  const valid = value => supported.includes(value);
  const selector = document.getElementById('language');
  const icons = {
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
    tag: '<path d="m20 13-7 7a2 2 0 0 1-3 0l-8-8V2h10l8 8a2 2 0 0 1 0 3Z"/><circle cx="7" cy="7" r="1"/>',
    globe: '<circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><path d="M2 12h20"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2"/>',
    code: '<path d="m8 5-7 7 7 7m8-14 7 7-7 7m-2-16-4 18"/>',
    shield: '<path d="m12 2 9 4v6c0 5-6 9-9 10-3-1-9-5-9-10V6Z"/><path d="m8 12 3 3 5-6"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>',
    activity: '<path d="M2 12h4l3-9 6 18 3-9h4"/>',
    git: '<circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M18 8a6 6 0 0 1-6 6H6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7h.01"/>',
    github: '<path d="M9 19c-4 1-4-2-6-2m12 5v-4a3.5 3.5 0 0 0-1-2.8c3.3-.4 6.8-1.6 6.8-7.3a5.7 5.7 0 0 0-1.6-4 5.3 5.3 0 0 0-.2-4s-1.2-.4-4 1.5a13.5 13.5 0 0 0-7 0C5.2-.5 4 .1 4 .1a5.3 5.3 0 0 0-.2 4 5.7 5.7 0 0 0-1.6 4c0 5.7 3.5 6.9 6.8 7.3A3.5 3.5 0 0 0 8 18v4" transform="translate(1 1) scale(.92)"/>',
  };
  document.querySelectorAll('[data-icon]').forEach(element => {
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[element.dataset.icon]}</svg>`;
  });
  document.querySelectorAll('[data-link]').forEach(anchor => {
    anchor.href = links[anchor.dataset.link];
  });
  function savedLanguage() {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }
  function languageFromUrl() {
    const query = new URL(window.location.href).searchParams.get('lng');
    const saved = savedLanguage();
    return valid(query) ? query : valid(saved) ? saved : 'en';
  }
  function applyLanguage(language, save = false) {
    const text = translations[language];
    document.documentElement.lang = language;
    document.documentElement.dir = ['he', 'ar'].includes(language) ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = text[element.dataset.i18n];
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(element => {
      element.setAttribute('aria-label', text[element.dataset.i18nAria]);
    });
    document.title = text.title;
    document.querySelector('meta[name="description"]').content = text.description;
    selector.value = language;
    if (save) {
      try { localStorage.setItem(storageKey, language); } catch { /* URL switching still works. */ }
    }
  }
  selector.addEventListener('change', () => {
    const language = selector.value;
    if (!valid(language)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('lng', language);
    history.pushState(null, '', url);
    applyLanguage(language, true);
  });
  window.addEventListener('popstate', () => applyLanguage(languageFromUrl()));
  applyLanguage(languageFromUrl());
})();
