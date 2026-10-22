import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('projects', () => {
  it('shares files as a whole through the project', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const cy = await signUp(url, 'cy');
    const project = (await ann.call('POST', '/api/projects', { name: 'Website redesign' })).body.project;
    expect(project).toMatchObject({ name: 'Website redesign', role: 'owner', files: 0 });
    const a = (await ann.call('POST', '/api/files', { name: 'Home' })).body.file;
    const b = (await ann.call('POST', '/api/files', { name: 'Pricing' })).body.file;
    expect((await ben.call('GET', `/api/files/${a.id}`)).status).toBe(404);

    // Moving files in, then inviting people to the project, gives them every file.
    expect((await ann.call('PATCH', `/api/files/${a.id}`, { projectId: project.id })).body.file.projectId).toBe(project.id);
    await ann.call('PATCH', `/api/files/${b.id}`, { projectId: project.id });
    await ann.call('PUT', `/api/projects/${project.id}/members`, { username: ben.username, role: 'viewer' });
    await ann.call('PUT', `/api/projects/${project.id}/members`, { username: cy.username, role: 'editor' });
    expect((await ben.call('GET', `/api/files/${a.id}`)).body.file.role).toBe('viewer');
    expect((await cy.call('GET', `/api/files/${b.id}`)).body.file.role).toBe('editor');
    const shared = (await ben.call('GET', '/api/files?scope=shared')).body.files.map((f: { name: string }) => f.name).sort();
    expect(shared).toEqual(['Home', 'Pricing']);
    expect((await ben.call('GET', `/api/projects`)).body.projects[0]).toMatchObject({ role: 'viewer', files: 2 });
    expect((await ben.call('GET', `/api/files?project=${project.id}`)).body.files).toHaveLength(2);

    // Roles still limit what people can do: a project viewer cannot rename, an editor can; neither moves the file.
    expect((await ben.call('PATCH', `/api/files/${a.id}`, { name: 'x' })).status).toBe(403);
    expect((await cy.call('PATCH', `/api/files/${a.id}`, { name: 'Landing' })).status).toBe(200);
    expect((await cy.call('PATCH', `/api/files/${a.id}`, { projectId: null })).status).toBe(403);
    expect((await ben.call('PUT', `/api/projects/${project.id}/members`, { username: cy.username, role: null })).status).toBe(403);

    // Taking a file out removes the project people's access to it; deleting the project frees the rest.
    await ann.call('PATCH', `/api/files/${b.id}`, { projectId: null });
    expect((await ben.call('GET', `/api/files/${b.id}`)).status).toBe(404);
    expect((await ann.call('DELETE', `/api/projects/${project.id}`)).status).toBe(200);
    expect((await ben.call('GET', `/api/files/${a.id}`)).status).toBe(404);
    expect((await ann.call('GET', '/api/files')).body.files).toHaveLength(2);
  });

  it('only lets people add files to projects they can edit, and only the owner can change one', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const project = (await ann.call('POST', '/api/projects', { name: 'Private' })).body.project;
    const mine = (await ben.call('POST', '/api/files', { name: 'Ben file' })).body.file;
    expect((await ben.call('PATCH', `/api/files/${mine.id}`, { projectId: project.id })).status).toBe(404);
    expect((await ben.call('GET', `/api/projects/${project.id}`)).status).toBe(404);
    await ann.call('PUT', `/api/projects/${project.id}/members`, { username: ben.username, role: 'viewer' });
    expect((await ben.call('PATCH', `/api/files/${mine.id}`, { projectId: project.id })).status).toBe(404);
    await ann.call('PUT', `/api/projects/${project.id}/members`, { username: ben.username, role: 'editor' });
    expect((await ben.call('PATCH', `/api/files/${mine.id}`, { projectId: project.id })).status).toBe(200);
    expect((await ben.call('PATCH', `/api/projects/${project.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await ben.call('DELETE', `/api/projects/${project.id}`)).status).toBe(403);
    expect((await ann.call('POST', '/api/projects', { name: '  ' })).status).toBe(400);
    // The project owner sees Ben's file through the project.
    expect((await ann.call('GET', `/api/files/${mine.id}`)).body.file.role).toBe('editor');
  });

  it('searches file names across own and shared files', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    await ann.call('POST', '/api/files', { name: 'Checkout flow' });
    const shared = (await ben.call('POST', '/api/files', { name: 'Checkout mobile' })).body.file;
    await ben.call('POST', '/api/files', { name: 'Secret checkout' });
    await ben.call('PUT', `/api/files/${shared.id}/members`, { username: ann.username, role: 'viewer' });
    const names = (await ann.call('GET', '/api/files?scope=all&q=CHECK')).body.files.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['Checkout flow', 'Checkout mobile']);
    expect((await ann.call('GET', '/api/files?scope=all&q=nothing')).body.files).toHaveLength(0);
  });
});
