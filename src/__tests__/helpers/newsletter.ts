/**
 * A marketing newsletter as mail programs and email builders write it: a style sheet, a hidden preheader, Outlook
 * conditional comments, and sections whose layout tables are nested `tableDepth` levels deep (table > tbody > tr > td
 * each), filled with product cards until the HTML has at least `bytes` characters.
 */
export function nestedNewsletter({ bytes, tableDepth }: { bytes: number; tableDepth: number }): string {
  const css =
    Array.from({ length: 200 }, (_, i) => `.c${i}{color:#333333;font-size:14px;line-height:20px;padding:0 ${i % 20}px}`).join("\n") +
    "\n@media only screen and (max-width:600px){.col{width:100%!important;display:block!important}}";
  const layoutOpen = (level: number) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="l${level}"><tbody><tr>` +
    `<td align="center" valign="top" style="padding:${level % 4}px 0;background-color:#ffffff">`;
  const layoutClose = "</td></tr></tbody></table>";
  const card = (i: number) =>
    `<!--[if mso]><table role="presentation" width="600"><tr><td width="300"><![endif]-->` +
    `<div class="col c${i % 200}" style="display:inline-block;width:50%;vertical-align:top">` +
    `<table role="presentation" width="100%"><tbody><tr><td style="padding:8px">` +
    `<a href="https://shop.example.com/p/${i}?utm_source=newsletter&amp;utm_medium=email"><img src="https://img.example.com/${i}.jpg" alt="Produkt ${i}" width="280" style="display:block;border:0"></a>` +
    `</td></tr><tr><td style="font-family:Arial,sans-serif;font-size:14px;color:#222222">` +
    `<p style="margin:0 0 8px"><strong>Produkt ${i}</strong><br>Nur diese Woche: <span style="color:#d00000">-${10 + (i % 40)} %</span></p>` +
    `<p style="margin:0"><a href="https://shop.example.com/p/${i}" style="color:#0055ff;text-decoration:underline">Jetzt ansehen</a> &rsaquo;</p>` +
    `</td></tr></tbody></table></div>` +
    `<!--[if mso]></td></tr></table><![endif]-->`;

  const sections: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; ) {
    let section = "";
    for (let level = 0; level < tableDepth; level++) section += layoutOpen(level);
    for (let k = 0; k < 6; k++) section += card(i++);
    section += layoutClose.repeat(tableDepth);
    sections.push(section);
    size += section.length;
  }
  return (
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Angebote der Woche</title><style>${css}</style></head><body style="margin:0;background:#f4f4f4">` +
    `<div style="display:none;max-height:0;overflow:hidden">Vorschau${"&#847;&zwnj;&nbsp;".repeat(80)}</div>` +
    `<center>${sections.join("")}</center></body></html>`
  );
}
