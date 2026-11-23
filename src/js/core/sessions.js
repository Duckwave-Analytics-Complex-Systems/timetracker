// Shared sessions (a meeting, pairing): one timer shared with others in the
// project, each tracking it under their own name. The rules both apps follow
// to show them; the server keeps them (supabase/schema.sql, "shared
// sessions"). Pure, shared with the Android app through its src/lib/shared.js.
//
// A session as both apps keep it, from my_shared_sessions():
//   { id, project_id, project_name, host_id, host_name, started_at,
//     my_status: 'host' | 'joined' | 'asked',
//     people: [{ user_id, name, status: 'joined' | 'asked', joined_at }] }

/** True if a project's timer was started for you by someone's shared session. */
export const isSharedRun = (project) => String(project?.run_device ?? '').startsWith('shared:');

/** The session you're in (started or joined) on a project, or null. */
export function sessionOf(projectId, sessions) {
  return sessions.find((s) => s.project_id === projectId && (s.my_status === 'host' || s.my_status === 'joined')) ?? null;
}

/**
 * Who you're with in a session: the host and everyone who joined, not you,
 * by name. `me`: your user id.
 */
export function companions(session, me) {
  if (!session) return [];
  const out = [];
  if (session.host_id !== me) out.push(session.host_name);
  for (const p of session.people) if (p.status === 'joined' && p.user_id !== me) out.push(p.name);
  return out.filter(Boolean);
}

/** "Ana", "Ana and Bren", "Ana, Bren and Carla". `and`: the word for "and". */
export function namesText(names, and = 'and') {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

/** Sessions you're asked to join and haven't answered here yet (`answered`: a Set of ids). */
export const pendingInvites = (sessions, answered = new Set()) =>
  sessions.filter((s) => s.my_status === 'asked' && !answered.has(s.id));

/**
 * The project's people you can still add to your session on it: everyone in
 * the project but you and those already in (or asked). `members`: the
 * project's [{ user_id, display_name, ... }]; `session` may be null (not
 * shared yet). Sorted by name.
 */
export function addableToSession(members, session, me) {
  const taken = new Set([me]);
  if (session) {
    taken.add(session.host_id);
    for (const p of session.people) taken.add(p.user_id);
  }
  return members
    .filter((m) => m.user_id && !taken.has(m.user_id))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), undefined, { sensitivity: 'base' }));
}
