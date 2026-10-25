(() => {
  const preferenceKey = 'contamcp-language';

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('.language-switch') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    const language = link.hreflang === 'es-MX' ? 'es' : link.hreflang === 'en' ? 'en' : null;
    if (!language) return;
    try {
      window.localStorage.setItem(preferenceKey, language);
    } catch {
      // Explicit language URLs keep the switch usable when storage is blocked.
    }
  });

  if (window.location.pathname !== '/') return;

  /** @type {string | null} */
  let preference = null;
  try {
    preference = window.localStorage.getItem(preferenceKey);
  } catch {
    // Browser language remains available without persistent storage.
  }
  const browserLanguage = (navigator.languages[0] ?? navigator.language)
    .split('-')[0]
    ?.toLowerCase();
  const language =
    preference === 'es' || preference === 'en'
      ? preference
      : browserLanguage === 'es'
        ? 'es'
        : 'en';
  const destination = new URL(window.location.href);
  destination.pathname = `/${language}`;
  window.location.replace(destination);
})();
