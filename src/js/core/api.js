// Every backend command, in one place. Commands live in
// src-tauri/src/commands.rs. Top-level argument names are camelCase here and
// Tauri maps them to the snake_case Rust parameters; *nested* objects
// (`plan`, `phase`) are passed through serde as-is, so their keys stay
// snake_case, matching the objects the backend returns.
import { invoke, listen } from './tauri.js';

export const api = {
  // ---- projects
  projects: () => invoke('get_projects'),
  archivedProjects: () => invoke('get_archived_projects'),
  /** orgId: the organization to create it in; null = a personal project. */
  addProject: ({ name, hourlyRate, peopleCount, orgId = null }) => invoke('add_project', { name, hourlyRate, peopleCount, orgId }),
  /** Moves a project into an organization, or back to personal (null). */
  setProjectOrg: (id, orgId) => invoke('set_project_org', { id, orgId }),
  updateProject: (id, { name, hourlyRate, peopleCount }) => invoke('update_project', { id, name, hourlyRate, peopleCount }),
  setLogo: (id, dataUrl) => invoke('set_project_logo', { id, dataUrl }),
  archiveProject: (id) => invoke('archive_project', { id }),
  /** Files the project; finalPayment (total paid, or null) is kept for the Archive. */
  endProject: (id, finalPayment) => invoke('end_project', { id, finalPayment }),
  setFinalPayment: (id, finalPayment) => invoke('set_final_payment', { id, finalPayment }),
  restoreProject: (id) => invoke('restore_project', { id }),
  deleteProject: (id) => invoke('delete_project', { id }),
  resetProject: (id) => invoke('reset_project', { id }),

  // ---- timer
  /** Both return the sessions that closed: [{ entry_id, project_id, project_name, seconds, note }] */
  start: (id) => invoke('start_project', { id }),
  pause: () => invoke('pause_timer'),
  setRunNote: (projectId, note) => invoke('set_run_note', { projectId, note }),
  setEntryNote: (entryId, note) => invoke('set_entry_note', { entryId, note }),
  deleteEntry: (entryId) => invoke('delete_entry', { entryId }),
  sync: () => invoke('sync'),
  takeRecoveredRuns: () => invoke('take_recovered_runs'),
  setActivePhase: (projectId, phaseId) => invoke('set_active_phase', { projectId, phaseId }),
  setActiveFeature: (projectId, featureId) => invoke('set_active_feature', { projectId, featureId }),

  // ---- schedule / project window
  projectDetail: (id) => invoke('get_project_detail', { id }),
  /** plan: { description, start_day, due_day, budget_hours } */
  updatePlan: (id, plan) => invoke('update_project_plan', { id, plan }),
  /** phase: { id?, project_id, name, kind, color, start_day, end_day, estimated_hours, progress } */
  savePhase: (phase) => invoke('save_phase', { phase }),
  deletePhase: (id) => invoke('delete_phase', { id }),
  /** feature: { id?, project_id, name, color } */
  saveFeature: (feature) => invoke('save_feature', { feature }),
  deleteFeature: (id) => invoke('delete_feature', { id }),
  openProjectWindow: (id) => invoke('open_project_window', { id }),

  // ---- stats & export
  daily: (fromDay, toDay) => invoke('get_daily', { fromDay, toDay }),
  /** Your sessions overlapping fromMs..toMs: [{ project_id, start_ts, end_ts }] */
  sessionSpans: (fromMs, toMs) => invoke('get_session_spans', { fromMs, toMs }),
  exportCsv: () => invoke('export_csv'),

  // ---- cloud sync (src-tauri/src/sync.rs). These four return
  // { url, email, signed_in, last_sync_at, last_error, profile, refused_changes }.
  cloudStatus: () => invoke('cloud_status'),
  cloudSignIn: ({ url, anonKey, email, password }) => invoke('cloud_sign_in', { url, anonKey, email, password }),
  cloudSignOut: () => invoke('cloud_sign_out'),
  cloudSyncNow: () => invoke('cloud_sync_now'),
  cloudSetDisplayName: (name) => invoke('cloud_set_display_name', { name }),
  /** Whether org teammates see when you're tracking one of its projects. */
  cloudSetShareActivity: (on) => invoke('cloud_set_share_activity', { on }),

  // ---- sharing
  /** Resolves to the added person's name. */
  addMember: (projectId, shareCode) => invoke('cloud_add_member', { projectId, shareCode }),
  /** Adds someone picked from the project's organization. Resolves to their name. */
  addMemberById: (projectId, userId) => invoke('cloud_add_member_by_id', { projectId, userId }),
  /** Removing yourself is leaving the project. */
  removeMember: (projectId, userId) => invoke('cloud_remove_member', { projectId, userId }),

  // ---- organizations (supabase/schema.sql, "organizations"). The reads are
  // this computer's copy as of the last sync; the cloud* calls go to the
  // server and sync before they resolve.
  /** [{ id, name, logo_data, currency, default_rate, week_start, join_code, role, people }] */
  orgs: () => invoke('get_orgs'),
  /** [{ org_id, user_id, role, display_name, joined_at, is_me }], owner first. */
  orgMembers: (orgId) => invoke('get_org_members', { orgId }),
  /** Resolves to the new organization's id. */
  createOrg: (name) => invoke('cloud_create_org', { name }),
  /** Resolves to the organization's id. */
  joinOrg: (code) => invoke('cloud_join_org', { code }),
  /** Resolves to the added person's name. */
  addOrgMember: (orgId, shareCode) => invoke('cloud_add_org_member', { orgId, shareCode }),
  /** Removing yourself is leaving the organization. */
  removeOrgMember: (orgId, userId) => invoke('cloud_remove_org_member', { orgId, userId }),
  /** role: 'admin' | 'member', or 'owner' to hand the organization over. */
  setOrgRole: (orgId, userId, role) => invoke('cloud_set_org_role', { orgId, userId, role }),
  /** changes: { name?, logo_data?, currency?, default_rate?, week_start? } */
  updateOrg: (orgId, changes) => invoke('cloud_update_org', { orgId, changes }),
  /** Resolves to the new invite code. */
  resetOrgJoinCode: (orgId) => invoke('cloud_reset_org_join_code', { orgId }),
  deleteOrg: (orgId) => invoke('cloud_delete_org', { orgId }),
  /** This computer's sessions on the organization's projects from fromMs on: [{ project_id, user_id, start_ts, seconds }] */
  orgEntries: (orgId, fromMs) => invoke('get_org_entries', { orgId, fromMs }),
  /** From the server: [{ user_id, display_name, role, weekly_goal_hours, running, project_id, project_name, started_at }] */
  orgPresence: (orgId) => invoke('cloud_org_presence', { orgId }),

  // ---- shared sessions (supabase/schema.sql, "shared sessions")
  /** { me, sessions: [{ id, project_id, project_name, host_id, host_name, started_at, my_status, people }] } */
  sharedSessions: () => invoke('get_shared_sessions'),
  /** Shares your running timer on the project with userIds (people in it). Resolves to the session's id. */
  shareSession: (projectId, userIds) => invoke('cloud_share_session', { projectId, userIds }),
  /** Joins a session you were asked to, from startedAt (after pausing what you were tracking). */
  joinSession: (sessionId, startedAt) => invoke('cloud_join_session', { sessionId, startedAt }),
  declineSession: (sessionId) => invoke('cloud_decline_session', { sessionId }),

};

/**
 * Calls `handler(reason)` whenever the backend changed data, from any window.
 * reason: 'timer' | 'projects' | 'schedule' | 'paused_for_sleep' | 'synced'
 * (see src-tauri/src/events.rs).
 */
export function onDataChanged(handler) {
  return listen('data-changed', (event) => handler(event.payload.reason));
}
