# Marketing website

Run `pnpm dev:website` from the repository root with Node 24 and pnpm, then open
<http://localhost:4321>. The server binds only to the local loopback interface and serves an
explicit list of public assets. It does not serve repository files or access D1, OAuth, or the MCP
server. The page needs no build step or additional packages.

Visiting `/` selects a language before the page content loads: a remembered manual EN/ES choice takes
priority, otherwise the browser's primary language selects `/es` for Spanish (`es` or `es-*`) and
`/en` for every other language. Explicit `/es` and `/en` links always show the requested language.
The header's EN/ES link switches between them and remembers the manual choice in local storage under
`contamcp-language`. When storage is blocked, detection and explicit language links still work.
Without JavaScript, the root falls back to Spanish and both explicit language pages remain readable.
Both HTML documents include translated metadata, accessibility labels, and static demo content.
Keep their markup and copy in sync when editing the page. Shared
`main.js` selects the matching demo conversations, chart labels, and progress text from the document
language. English uses a synthetic USD dataset; Spanish uses a separate MXN dataset. These are
localized examples, not currency conversions of real records. User messages and composer suggestions
use amounts such as `$45` or `$450` without currency names or codes. Assistant results include a
currency code where it clarifies the figures. The compatibility strip keeps `MXN · USD · EUR`.

`demo-dates.js` resolves the current day in the visitor's browser timezone and formats dates in
the selected website language. Examples use today's date, the current month through today,
the previous calendar month for comparisons, future billing dates, and a savings target two
calendar months ahead. Upcoming payments are sorted by date. Statement filenames include the
current month and year. Receipt photographs have no embedded date; their captions use today's
date. Dates refresh after midnight while open and when returning to the page. No backend or
network request supplies these dates, and demo amounts remain synthetic fixtures.

The sticky header contains the language switch, GitHub link, and getting-started CTA. It is transparent
at the top and gains a flat translucent background after scrolling, without blur. The hero backdrop
extends behind the header so the top of the page blends continuously. Anchor offsets leave room for
the header on desktop and phones.

The ContaMCP mark is the approved Ledger C concept: a rounded C with two inset ledger lines.
Both localized pages use the same 48-unit SVG symbol for the header, footer, and composer badge.
`favicon.svg` uses the same geometry on a dark rounded background. Logo explorations remain
local reference files and are excluded from the public build.

The page stays focused on the hero, interactive demo, saved-records example, open-source setup,
and a final call to action with the connection steps above the footer: opening ChatGPT Plugins,
naming the custom MCP server, and connecting with Google, plus a copyable production MCP URL.
On phones, the six demo tabs form three rows.
The installation CTAs use “Instalar ContaMCP” / “Install ContaMCP”. Short text and voice expense
examples use less transcript height on phones; charts, statements, and receipt examples retain
their larger scrolling area. Desktop hero supporting copy uses 20px text (18px on tablets),
section paragraphs use 17–18px, and demo messages use 14px. Mobile hero descriptions and section paragraphs use 17px text, demo messages use 14px,
and secondary labels generally use 12px. Demo tabs retain two columns and wrap longer labels;
transcript heights leave space for the larger type while preserving page scroll chaining.
The saved-records section illustrates finding the same expense in a new ChatGPT conversation,
using synthetic data and an amount formatted from integer cents. Section dividers span the viewport;
inner containers keep the text and cards aligned with the rest of the page.
- `index.html`: Mexican Spanish content, inline SVG icons, and illustrative ChatGPT conversations
  with synthetic data.
- `english.html`: English copy of the same page and example content.
- `locale.js`: early language selection and remembered EN/ES choices, with no network calls.
- `styles.css`: responsive dark theme inspired by the T3 Code marketing site, with staggered text
  entrances and conversational motion inspired by [x.ai/bot](https://x.ai/bot). The implementation
  uses original CSS and browser APIs, with no animation packages or copied third-party code.
  A continuous static grid and soft green glow fade behind the hero and demo without intercepting
  interactions. The demo softens the shared backdrop after the hero, and the ChatGPT window keeps
  its opaque background for contrast.
- `main.js`: six example workflows with keyboard-accessible tabs: expense recording, income recording,
  monthly spending, recurring payments, savings, and spending insights. Expenses use a confirmation checklist; income
  uses a green amount and exact monthly cash-flow summary. The monthly response has a total, an animated SVG donut, and
  category amounts; recurring payments use dated cards, and savings use an accessible progress bar.
  Insights reuse the same food spending fixture and compare it with an optional next-month target.
  The expense demo has Text, Receipt, PDF, and Voice format buttons. Receipt and voice examples
  illustrate the same gas expense; the voice transcription sits in italics inside the audio bubble.
  The statement concept confirms 20 saved expenses, with category counts and an exact total.
  The formats use manual selection and keep the existing conversation animation; they do not autoplay
  from one format to the next. Attachments and waveforms are static synthetic illustrations: there
  is no file upload, microphone access, document extraction, or bulk save implementation. This local
  concept does not establish support for importing statements into the production ledger.
  The receipt thumbnails are generated sample photographs, optimized to WebP; see
  [receipt asset paths and generation prompt](receipt-assets.md).
  The potential reduction is calculated in integer cents; no budget is set by the demonstration.
  Savings amounts and progress also derive from a synthetic fixture in integer cents. Monthly amounts come from one synthetic
  fixture in integer cents, with exact totals and approximate chart geometry. All examples are fixed data, with no model calls or financial mutations. The composer
  accepts single-line local typing on desktop without sending or saving it; Enter cannot add a newline.
  At phone widths (680px and below), it is disabled and cannot receive focus or open the keyboard.
  Switching examples preserves the typed draft,
  and reloading clears it. There is no form, submission handler, or storage of demo messages. Only
  the site's manual language choice is stored. The send button
  is disabled, and the preview server's CSP blocks network connections and form submissions.

The demo plays once when its ChatGPT panel is at least half visible, waiting for the section's
entrance animation to finish before the tool activity starts. Tab clicks keep their faster timing.
Feature tabs replay a short
question → tool activity → response sequence. Questions fade in fully formed; AI replies retain
their streaming text and result animations. Selecting the active tab replays its example; there
are no separate playback controls or helper captions. A newer selection cancels pending animation
work. Focusing the composer or hiding the page finishes the sequence without changing the draft. Reduced-motion
preferences show complete results immediately and disable the entrance/scroll animations. Lower
sections reveal once as they enter view; the full page remains readable without JavaScript.
Scrolling past either end of the demo conversation continues scrolling the surrounding page.
On phones, clicking a task or expense-format pill brings the demo below the sticky header when
less than 80% of its available viewing area is visible. An already well-positioned demo stays still.
This page scroll uses smooth motion unless reduced motion is requested. Initial playback and arrow-key
tab navigation do not trigger page scrolling.

Refresh after editing website files. The Node watcher restarts the server when its source changes.
Use `pnpm check` for formatting, lint, strict server/browser type checks, and the existing ledger
tests. Verify the page at desktop and phone widths after layout changes. `pnpm build` still
packages only the MCP Worker.

## Firebase Hosting

The marketing site's entry point is <https://contamcp.web.app/>, with explicit language pages at
<https://contamcp.web.app/es> (Spanish) and <https://contamcp.web.app/en> (English).
The root `firebase.json` targets the reserved Hosting site
`contamcp`, with project `secret-301000` (ContaMCP Prod) selected in `.firebaserc`. Firebase Management
and Hosting are enabled in that project. Both pages include canonical URLs and absolute alternate
language links for the public domain.

`pnpm build:website` copies only the seventeen public assets into `dist/website`; documentation and
development configuration are excluded. Hosting serves that bundle and preserves the local preview's
security headers. `/es/` and `/index.html` redirect to `/es`; `/en/` and `/english.html` redirect
to `/en`. Unversioned assets must
revalidate instead of retaining stale copies across releases. No Firebase client SDK is needed.

With the Firebase CLI installed, test the production routing locally without using the real project:

```sh
pnpm build:website
firebase emulators:start --only hosting --project demo-contamcp
```

Open <http://127.0.0.1:4322> or either explicit language page. The emulator uses a demo project ID and
does not deploy or provision resources. Stop it with Ctrl+C.

`pnpm test:website` covers browser language selection, remembered choices, explicit links,
preserved queries/anchors, blocked storage, local calendar days, leap years, and month/year
rollovers. It also runs as part of `pnpm check`.

To publish an authorized website release, use the authenticated `fernandoguillen.apps@gmail.com`
account and the explicit `secret-301000` project:

```sh
firebase deploy --only hosting --project secret-301000 --account fernandoguillen.apps@gmail.com
```

The deploy command rebuilds the public bundle through the Hosting predeploy hook.

The MCP Worker is deployed separately.

The page optionally loads DM Sans from Google Fonts and falls back to system fonts offline.
Getting-started and documentation links point to this project's GitHub repository. Hosted-agent
validation is still in progress, so the page links to setup instructions rather than advertising a
verified one-click connection. It includes no analytics, registration, or production financial data.

`openai-blossom-white.png` is the unmodified white Blossom PNG from OpenAI's
[official brand assets](https://cdn.openai.com/brand/openai-logos.zip), referenced by its
[brand guidelines](https://openai.com/brand/). The asset and ChatGPT name belong to OpenAI and are
not covered by this repository's MIT license. They identify the compatible client in the demo and
compatibility row; ContaMCP is an independent project.
