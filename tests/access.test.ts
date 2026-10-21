import { describe, expect, it } from 'vitest';
import { can, roleFor, type Shareable } from '../server/access';

const file = (over: Partial<Shareable> = {}): Shareable => ({ ownerId: 'owner', linkAccess: 'none', members: {}, ...over });

describe('roleFor', () => {
  it('gives the owner full rights and strangers nothing', () => {
    expect(roleFor(file(), 'owner')).toBe('owner');
    expect(roleFor(file(), 'someone')).toBeNull();
    expect(roleFor(file(), null)).toBeNull();
  });

  it('uses the member role', () => {
    const f = file({ members: { ed: 'editor', vi: 'viewer' } });
    expect(roleFor(f, 'ed')).toBe('editor');
    expect(roleFor(f, 'vi')).toBe('viewer');
  });

  it('lets the link grant access to anyone, guests included', () => {
    expect(roleFor(file({ linkAccess: 'view' }), null)).toBe('viewer');
    expect(roleFor(file({ linkAccess: 'edit' }), null)).toBe('editor');
    expect(roleFor(file({ linkAccess: 'edit' }), 'someone')).toBe('editor');
  });

  it('takes the strongest of owner, member and link', () => {
    expect(roleFor(file({ linkAccess: 'edit', members: { vi: 'viewer' } }), 'vi')).toBe('editor');
    expect(roleFor(file({ linkAccess: 'view', members: { ed: 'editor' } }), 'ed')).toBe('editor');
    expect(roleFor(file({ linkAccess: 'edit' }), 'owner')).toBe('owner');
  });

  it('treats files without an owner as link-only', () => {
    expect(roleFor(file({ ownerId: null, linkAccess: 'edit' }), null)).toBe('editor');
    expect(roleFor(file({ ownerId: null }), null)).toBeNull();
  });
});

describe('can', () => {
  it('follows the permission matrix', () => {
    expect(can('viewer', 'view')).toBe(true);
    expect(can('viewer', 'edit')).toBe(false);
    expect(can('viewer', 'share')).toBe(false);
    expect(can('editor', 'edit')).toBe(true);
    expect(can('editor', 'share')).toBe(true);
    expect(can('editor', 'delete')).toBe(false);
    expect(can('editor', 'transfer')).toBe(false);
    expect(can('owner', 'delete')).toBe(true);
    expect(can('owner', 'transfer')).toBe(true);
    expect(can(null, 'view')).toBe(false);
  });
});
