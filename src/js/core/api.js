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
  addProject: ({ name, hourlyRate, peopleCount }) => invoke('add_project', { name, hourlyRate, peopleCount }),
  updateProject: (id, { name, hourlyRate, peopleCount }) => invoke('update_project', { id, name, hourlyRate, peopleCount }),
  setLogo: (id, dataUrl) => invoke('set_project_logo', { id, dataUrl }),
  archiveProject: (id) => invoke('archive_project', { id }),
  restoreProject: (id) => invoke('restore_project', { id }),
  deleteProject: (id) => invoke('delete_project', { id }),
  resetProject: (id) => invoke('reset_project', { id }),

  // ---- timer
  start: (id) => invoke('start_project', { id }),
  pause: () => invoke('pause_timer'),
  sync: () => invoke('sync'),
  takeRecoveredRuns: () => invoke('take_recovered_runs'),
  setActivePhase: (projectId, phaseId) => invoke('set_active_phase', { projectId, phaseId }),

  // ---- schedule / project window
  projectDetail: (id) => invoke('get_project_detail', { id }),
  /** plan: { description, start_day, due_day, budget_hours } */
  updatePlan: (id, plan) => invoke('update_project_plan', { id, plan }),
  /** phase: { id?, project_id, name, kind, color, start_day, end_day, estimated_hours, progress } */
  savePhase: (phase) => invoke('save_phase', { phase }),
  deletePhase: (id) => invoke('delete_phase', { id }),
  openProjectWindow: (id) => invoke('open_project_window', { id }),

  // ---- stats & export
  daily: (fromDay, toDay) => invoke('get_daily', { fromDay, toDay }),
  exportCsv: () => invoke('export_csv'),
};

/**
 * Calls `handler(reason)` whenever the backend changed data, from any window.
 * reason: 'timer' | 'projects' | 'schedule' | 'paused_for_sleep'
 * (see src-tauri/src/events.rs).
 */
export function onDataChanged(handler) {
  return listen('data-changed', (event) => handler(event.payload.reason));
}
