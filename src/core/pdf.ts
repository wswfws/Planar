/** A minimal PDF writer: one page per image, each page the size of its screen. */

export interface PdfPage {
  /** Page size in points (1 point = 1 design pixel). */
  width: number;
  height: number;
  /** The picture: a baseline JPEG and its size in pixels. */
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
}

export function pdfFromJpegs(pages: PdfPage[], title = 'Planar export'): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string | Uint8Array[]) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else body.forEach(push);
    push('\nendobj\n');
  };
  const num = (v: number) => String(Math.round(v * 100) / 100);

  push('%PDF-1.4\n');
  // Objects: 1 catalog, 2 page tree, 3 info, then per page: page, content, image.
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const first = 4;
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${first + i * 3} 0 R`).join(' ')}] >>`);
  object(3, `<< /Title (${title.replace(/[()\\]/g, '')}) /Producer (Planar) >>`);
  pages.forEach((p, i) => {
    const page = first + i * 3;
    const content = `q ${num(p.width)} 0 0 ${num(p.height)} 0 0 cm /Im0 Do Q`;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    object(page + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(page + 2, [
      enc.encode(`<< /Type /XObject /Subtype /Image /Width ${p.pixelWidth} /Height ${p.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`),
      p.jpeg,
      enc.encode('\nendstream'),
    ]);
  });
  const count = first + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
