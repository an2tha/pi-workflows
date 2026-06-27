import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type WorkflowSettingsScope = "project" | "global";

export interface WorkflowSettings {
  /** Defaults to true when unset. */
  enabled?: boolean;
  fastModel?: string;
  defaultModel?: string;
  /**
   * How pi-agent-workflows reports workflow token/cost usage in the TUI.
   * - status: non-invasive extension status line (default)
   * - replace: replace the main footer to fold workflow cost into core totals
   * - off: no TUI status/footer reporting
   */
  footerMode?: "status" | "replace" | "off";
}

export interface PiWorkflowSettingsFile {
  workflows?: WorkflowSettings;
  workflow?: WorkflowSettings;
  piWorkflows?: WorkflowSettings;
  workflowFastModel?: string;
  workflowDefaultModel?: string;
}

export function workflowSettingsPath(cwd: string, scope: WorkflowSettingsScope): string {
  if (scope === "project") return resolve(cwd, ".pi", "settings.json");
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("Cannot resolve global workflow settings path: HOME is not set");
  return resolve(home, ".pi", "agent", "settings.json");
}

export async function loadWorkflowSettings(cwd: string): Promise<WorkflowSettings> {
  const home = process.env.HOME || process.env.USERPROFILE;
  const globalPath = home ? resolve(home, ".pi", "agent", "settings.json") : undefined;
  const projectPath = resolve(cwd, ".pi", "settings.json");

  const globalSettings = globalPath ? await readSettingsFile(globalPath) : {};
  const projectSettings = await readSettingsFile(projectPath);
  return mergeWorkflowSettings(extractWorkflowSettings(globalSettings), extractWorkflowSettings(projectSettings));
}

export async function saveWorkflowSettings(cwd: string, scope: WorkflowSettingsScope, settings: WorkflowSettings): Promise<string> {
  const path = workflowSettingsPath(cwd, scope);
  const existing = await readSettingsFile(path);
  const next = {
    ...existing,
    workflows: { ...(existing.workflows ?? {}) },
  } satisfies PiWorkflowSettingsFile;
  applyWorkflowSettingsPatch(next.workflows!, settings);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}

async function readSettingsFile(path: string): Promise<PiWorkflowSettingsFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PiWorkflowSettingsFile;
  } catch {
    return {};
  }
}

function extractWorkflowSettings(settings: PiWorkflowSettingsFile): WorkflowSettings {
  return {
    ...settings.workflows,
    ...settings.workflow,
    ...settings.piWorkflows,
    fastModel: settings.workflowFastModel ?? settings.piWorkflows?.fastModel ?? settings.workflow?.fastModel ?? settings.workflows?.fastModel,
    defaultModel:
      settings.workflowDefaultModel ??
      settings.piWorkflows?.defaultModel ??
      settings.workflow?.defaultModel ??
      settings.workflows?.defaultModel,
  };
}

function mergeWorkflowSettings(base: WorkflowSettings, override: WorkflowSettings): WorkflowSettings {
  const result: WorkflowSettings = {};
  const enabled = override.enabled ?? base.enabled;
  const fastModel = override.fastModel ?? base.fastModel;
  const defaultModel = override.defaultModel ?? base.defaultModel;
  const footerMode = override.footerMode ?? base.footerMode;
  if (enabled !== undefined) result.enabled = enabled;
  if (fastModel !== undefined) result.fastModel = fastModel;
  if (defaultModel !== undefined) result.defaultModel = defaultModel;
  if (footerMode !== undefined) result.footerMode = footerMode;
  return result;
}

function applyWorkflowSettingsPatch(target: WorkflowSettings, patch: WorkflowSettings): void {
  for (const key of ["enabled", "fastModel", "defaultModel", "footerMode"] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) delete target[key];
    else (target as Record<typeof key, unknown>)[key] = value;
  }
}

export function isWorkflowEnabled(settings: WorkflowSettings): boolean {
  return settings.enabled !== false;
}

export function describeWorkflowSettingsLocation(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return `${resolve(cwd, ".pi", "settings.json")} or ${resolve(home, ".pi", "agent", "settings.json")}`;
}
