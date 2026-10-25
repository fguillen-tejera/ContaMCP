import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../website/locale.js', import.meta.url), 'utf8');

class TestElement {
  closest(_selector: string): TestElement | null {
    return this;
  }
}

class TestAnchor extends TestElement {
  hreflang: string;
  constructor(hreflang: string) {
    super();
    this.hreflang = hreflang;
  }
}

function loadLocale(
  options: {
    path?: string;
    preference?: string | null;
    languages?: string[];
    browserLanguage?: string;
    storageBlocked?: boolean;
  } = {},
) {
  const url = new URL(options.path ?? '/', 'https://contamcp.web.app');
  let stored = options.preference ?? null;
  let redirected: string | null = null;
  let clickListener: ((event: { target: unknown }) => void) | undefined;
  runInNewContext(source, {
    URL,
    Element: TestElement,
    HTMLAnchorElement: TestAnchor,
    document: {
      addEventListener: (type: string, listener: typeof clickListener) => {
        if (type === 'click') clickListener = listener;
      },
    },
    navigator: {
      languages: options.languages ?? ['en-US'],
      language: options.browserLanguage ?? 'en-US',
    },
    window: {
      location: {
        pathname: url.pathname,
        href: url.href,
        replace: (destination: URL) => {
          redirected = destination.href;
        },
      },
      localStorage: {
        getItem: () => {
          if (options.storageBlocked) throw new Error('Storage unavailable');
          return stored;
        },
        setItem: (_key: string, value: string) => {
          if (options.storageBlocked) throw new Error('Storage unavailable');
          stored = value;
        },
      },
    },
  });
  return {
    get redirected() {
      return redirected;
    },
    get preference() {
      return stored;
    },
    choose(language: 'en' | 'es') {
      clickListener?.({ target: new TestAnchor(language === 'es' ? 'es-MX' : 'en') });
    },
  };
}

for (const language of ['es', 'es-MX', 'es-ES', 'ES-ar']) {
  test(`a first visit in ${language} opens Spanish`, () => {
    assert.equal(loadLocale({ languages: [language] }).redirected, 'https://contamcp.web.app/es');
  });
}

test('English is the fallback and secondary Spanish does not override the primary language', () => {
  for (const languages of [['en-US', 'es-MX'], ['fr-FR'], ['pt-BR']]) {
    assert.equal(loadLocale({ languages }).redirected, 'https://contamcp.web.app/en');
  }
});

test('navigator.language is used when navigator.languages is empty', () => {
  assert.equal(
    loadLocale({ languages: [], browserLanguage: 'es-MX' }).redirected,
    'https://contamcp.web.app/es',
  );
});

test('remembered choices take precedence over the browser language', () => {
  assert.equal(loadLocale({ preference: 'es' }).redirected, 'https://contamcp.web.app/es');
  assert.equal(
    loadLocale({ preference: 'en', languages: ['es-MX'] }).redirected,
    'https://contamcp.web.app/en',
  );
});

test('invalid preferences are ignored and cannot create an external redirect', () => {
  assert.equal(
    loadLocale({ preference: 'https://example.com', languages: ['es-MX'] }).redirected,
    'https://contamcp.web.app/es',
  );
});

test('explicit language links stay in that language without overwriting a remembered choice', () => {
  assert.equal(loadLocale({ path: '/en', preference: 'es' }).redirected, null);
  const spanish = loadLocale({ path: '/es', preference: 'en' });
  assert.equal(spanish.redirected, null);
  assert.equal(spanish.preference, 'en');
});

test('language selection preserves the original query string and section anchor', () => {
  assert.equal(
    loadLocale({ path: '/?source=share#demo', languages: ['es-MX'] }).redirected,
    'https://contamcp.web.app/es?source=share#demo',
  );
});

test('manual language choices are remembered for future visits to the root', () => {
  const page = loadLocale({ path: '/en' });
  page.choose('es');
  assert.equal(page.preference, 'es');
  assert.equal(
    loadLocale({ preference: page.preference }).redirected,
    'https://contamcp.web.app/es',
  );
  page.choose('en');
  assert.equal(page.preference, 'en');
});

test('blocked storage still permits detection and explicit language selection', () => {
  assert.equal(
    loadLocale({ storageBlocked: true, languages: ['es-MX'] }).redirected,
    'https://contamcp.web.app/es',
  );
  const page = loadLocale({ path: '/es', storageBlocked: true });
  assert.doesNotThrow(() => page.choose('en'));
  assert.equal(page.redirected, null);
});
