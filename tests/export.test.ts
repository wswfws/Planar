import { describe, expect, it } from 'vitest';
import { pdfFromJpegs } from '../src/core/pdf';
import { crc32, uniqueNames, zipFiles } from '../src/core/zip';

const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a readable archive with all files', () => {
    const files = [
      { name: 'Home.png', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'Детали.svg', data: new TextEncoder().encode('<svg/>') },
    ];
    const zip = zipFiles(files);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // End of central directory: two entries, directory inside the file.
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    // Walk the central directory and check names, sizes and CRCs.
    let at = view.getUint32(end + 16, true);
    for (const f of files) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      expect(view.getUint32(at + 16, true)).toBe(crc32(f.data));
      expect(view.getUint32(at + 24, true)).toBe(f.data.length);
      const nameLen = view.getUint16(at + 28, true);
      const offset = view.getUint32(at + 42, true);
      expect(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen))).toBe(f.name);
      // The data sits right after the local header.
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      const start = offset + 30 + view.getUint16(offset + 26, true);
      expect([...zip.subarray(start, start + f.data.length)]).toEqual([...f.data]);
      at += 46 + nameLen;
    }
  });

  it('makes names unique', () => {
    expect(uniqueNames(['a.png', 'b.png', 'a.png', 'a.png'])).toEqual(['a.png', 'b.png', 'a (2).png', 'a (3).png']);
  });
});

describe('pdf', () => {
  it('has a page per image with the right size and a valid cross-reference table', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = pdfFromJpegs([
      { width: 390, height: 844, jpeg, pixelWidth: 780, pixelHeight: 1688 },
      { width: 100, height: 50, jpeg, pixelWidth: 100, pixelHeight: 50 },
    ]);
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/Count 2');
    expect(s).toContain('/MediaBox [0 0 390 844]');
    expect(s).toContain('/MediaBox [0 0 100 50]');
    // Every xref entry points at its object (3 fixed objects + 3 per page = 9).
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    const lines = s.slice(xref).split('\n').slice(3, 3 + 9);
    lines.forEach((l, i) => {
      const off = Number(l.slice(0, 10));
      expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });
});
