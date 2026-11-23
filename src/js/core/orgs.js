// Organizations: which workspace a project is in, and where it may be moved.
// Pure (no DOM, no backend), shared with the Android app through its
// src/lib/shared.js. The server enforces the same rules in guard_project()
// (supabase/schema.sql); these only decide what to offer.

/** The workspace of projects with no organization. */
export const PERSONAL = 'personal';

/** True if `project` is in the workspace `id` (PERSONAL or an organization id). */
export const inWorkspace = (project, id) => (id === PERSONAL ? !project.org_id : project.org_id === id);

/** True if you may change the organization: its owner or an admin. */
export const isOrgAdmin = (org) => org?.role === 'owner' || org?.role === 'admin';

/** `id` if it's one of `orgs`, else PERSONAL (an organization you've left reads as Personal). */
export const validWorkspace = (id, orgs) => (orgs.some((o) => o.id === id) ? id : PERSONAL);

/**
 * Where `project` may go, as workspace ids, its current one first. Out of an
 * organization only as its owner or an admin; into one only as the project's
 * owner (an admin who sees it only through the organization may take it out,
 * but not into another one). `orgs`: yours, with your `role` in each.
 */
export function moveTargets(project, orgs) {
  const here = project.org_id || PERSONAL;
  const current = project.org_id ? orgs.find((o) => o.id === project.org_id) : null;
  const canLeave = !project.org_id || isOrgAdmin(current);
  const out = [here];
  if (!canLeave) return out;
  if (project.org_id) out.push(PERSONAL);
  if (project.is_owner && !project.managed_only) {
    for (const o of orgs) if (!out.includes(o.id)) out.push(o.id);
  }
  return out;
}

/** The hourly rate a new project in workspace `id` starts with: the organization's default, else yours. */
export function defaultRate(id, orgs, personalRate) {
  const org = orgs.find((o) => o.id === id);
  return org?.default_rate ?? personalRate ?? null;
}

/**
 * The people of an organization who can still be added to one of its
 * projects: everyone not already in it. `orgMembers`: [{ user_id, ... }] of
 * the project's organization; `projectMembers`: [{ user_id }] of the project.
 * Sorted by name.
 */
export function addableMembers(orgMembers, projectMembers) {
  const inIt = new Set(projectMembers.map((m) => m.user_id));
  return orgMembers
    .filter((m) => !inIt.has(m.user_id))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), undefined, { sensitivity: 'base' }));
}

/**
 * Who may change a project's members, mirroring can_manage_project() on the
 * server: its owner, or an owner or admin of its organization. Both show up
 * locally as `is_owner` (an admin who isn't in the project reads as its owner).
 */
export const canManageMembers = (project) => !!project?.is_owner;
