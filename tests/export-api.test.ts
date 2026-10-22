import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRender } from '../src/agent/raster';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { startServer } from '../server/server';
import { signUp, type TestServer } from './helpers';

let server: TestServer;
let url = '';

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000 });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

function screens() {
  const doc = createDocument('Export me');
  const page = doc.pageIds[0];
  for (const [i, name] of ['Home', 'Home', 'Settings'].entries()) {
    const frame = createNode('frame', { name, x: i * 500, y: 0, width: 400, height: 300 });
    insertNode(doc, frame, page);
    insertNode(doc, createNode('rectangle', { name: 'Box', x: 10, y: 10, width: 100, height: 50 }), frame.id);
  }
  return doc;
}

const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { Cookie: cookie } });

describe('export.zip', () => {
  it('returns every screen of a page as SVG files, with unique names', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { doc: screens() })).body.file;
    const res = await get(ann.cookie, `/api/files/${file.id}/export.zip?format=svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await res.arrayBuffer());
    const text = zip.toString('latin1');
    expect(text).toContain('Home.svg');
    expect(text).toContain('Home (2).svg');
    expect(text).toContain('Settings.svg');
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(3);
    expect(text).toContain('<svg');
  });

  it('needs access, and refuses unknown formats', async () => {
    const ann = await signUp(url, 'ann');
    const eve = await signUp(url, 'eve');
    const file = (await ann.call('POST', '/api/files', { doc: screens() })).body.file;
    expect((await get(eve.cookie, `/api/files/${file.id}/export.zip`)).status).toBe(404);
    expect((await get(ann.cookie, `/api/files/${file.id}/export.zip?format=gif`)).status).toBe(400);
    const empty = (await ann.call('POST', '/api/files', { name: 'Empty' })).body.file;
    expect((await get(ann.cookie, `/api/files/${empty.id}/export.zip?format=svg`)).status).toBe(404);
  });

  it('renders PNG files and a PDF with a page per screen (when the optional renderer is installed)', async () => {
    if (!canRender()) return;
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { doc: screens() })).body.file;
    const png = Buffer.from(await (await get(ann.cookie, `/api/files/${file.id}/export.zip?format=png&scale=1`)).arrayBuffer());
    expect(png.readUInt16LE(png.length - 22 + 10)).toBe(3);
    expect(png.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    const pdf = await get(ann.cookie, `/api/files/${file.id}/export.zip?format=pdf&scale=1`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const text = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text).toContain('/MediaBox [0 0 400 300]');
  });
});
