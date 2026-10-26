# Receipt demo assets

Generated with the built-in imagegen tool, using synthetic data only. No real merchant,
customer, payment, or account information appears in these assets.
- `receipt-en.webp`: 360 × 360; sample total $45.00.
- `receipt-es.webp`: 360 × 360; sample total $450.00.

The final generated image contains two adjacent square photographs. Each half was cropped,
resized to twice its displayed dimensions, and encoded as WebP at quality 84 using `cwebp`.
The page loads the matching localized thumbnail lazily.

The original generation requested natural smartphone photographs of creased thermal gas
receipts on a dark tabletop, with localized totals, date 24 OCT 2026, and SAMPLE/EJEMPLO labels.
The receipt details were simplified with this imagegen prompt:

> Edit this synthetic receipt photo pair. Keep the same two square side-by-side photographs,
> composition, texture, creases, torn edges, shadows, headings FUEL/GASOLINA, date 24 OCT 2026,
> exact TOTAL $45.00 on the left and TOTAL $450.00 on the right, and SAMPLE/EJEMPLO bottom
> labels. ONLY change the tiny middle item details: REMOVE the LITRES and PRICE/L lines and
> all quantity/unit-price values from both receipts entirely. Replace the middle block with
> a single small faint item label 'GAS PURCHASE' on the left and 'COMPRA DE GASOLINA' on the
> right, with no amount or numbers on that line. The only numbers visible anywhere must be
> the date and the exact TOTAL amounts already present. Preserve natural thermal print and
> plenty of white space. No other changes.

The final imagegen edit removed the embedded date so the assets remain reusable. The webpage
shows today's localized date in an HTML caption. Final edit prompt, verbatim:

> Edit this synthetic receipt photo pair. Remove ONLY the printed date line '24 OCT 2026' from
> both receipts, leaving naturally blank paper in those areas. Do not put any other dates,
> years, quantities, or new text anywhere. Keep the photographs identical otherwise: preserve
> side-by-side square framing, paper texture, creases, torn edges, dark tabletop, shadows,
> exact FUEL/GASOLINA headings, GAS PURCHASE/COMPRA DE GASOLINA item labels, TOTAL $45.00 on
> the left, TOTAL $450.00 on the right, and SAMPLE/EJEMPLO labels. The finished reusable
> receipt samples must contain no dates or years.
