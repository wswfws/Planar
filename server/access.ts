export type LinkAccess = 'none' | 'view' | 'edit';
export type MemberRole = 'editor' | 'viewer';
export type Role = 'owner' | 'editor' | 'viewer';

export interface Shareable {
  ownerId: string | null;
  linkAccess: LinkAccess;
  members: Record<string, MemberRole>;
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/** The people of a project; its members get the same role on every file in it. */
export interface ProjectAccess {
  ownerId: string;
  members: Record<string, MemberRole>;
}

/**
 * The strongest role a person has on a file: owner, explicit member, via the
 * link, or via the project the file is in (project owner and editors can edit its files).
 */
export function roleFor(file: Shareable, userId: string | null, project?: ProjectAccess | null): Role | null {
  let best: Role | null = null;
  const up = (r: Role) => {
    if (!best || RANK[r] > RANK[best]) best = r;
  };
  if (userId && file.ownerId === userId) up('owner');
  if (userId && file.members[userId]) up(file.members[userId]);
  if (userId && project) {
    if (project.ownerId === userId) up('editor');
    else if (project.members[userId]) up(project.members[userId]);
  }
  if (file.linkAccess === 'edit') up('editor');
  else if (file.linkAccess === 'view') up('viewer');
  return best;
}

export type Action = 'view' | 'edit' | 'share' | 'delete' | 'transfer';

const NEEDS: Record<Action, Role> = { view: 'viewer', edit: 'editor', share: 'editor', delete: 'owner', transfer: 'owner' };

export function can(role: Role | null, action: Action): boolean {
  return !!role && RANK[role] >= RANK[NEEDS[action]];
}
