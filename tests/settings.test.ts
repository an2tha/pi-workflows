import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describeWorkflowSettingsLocation, loadWorkflowSettings, saveWorkflowSettings, workflowSettingsPath } from "../src/settings";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempRoots: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pi-workflows-test-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await Bun.write(path, JSON.stringify(value, null, 2));
}

describe("loadWorkflowSettings", () => {
  test("merges global and project workflow model settings with project override", async () => {
    const root = await makeTempRoot();
    const home = resolve(root, "home");
    const project = resolve(root, "project");
    process.env.HOME = home;
    delete process.env.USERPROFILE;

    await writeJson(resolve(home, ".pi/agent/settings.json"), {
      workflows: {
        fastModel: "openai-codex/codex-5.3-spark",
        defaultModel: "anthropic/global-default",
      },
    });
    await writeJson(resolve(project, ".pi/settings.json"), {
      workflows: {
        defaultModel: "anthropic/project-default",
      },
    });

    await expect(loadWorkflowSettings(project)).resolves.toEqual({
      fastModel: "openai-codex/codex-5.3-spark",
      defaultModel: "anthropic/project-default",
    });
  });

  test("supports legacy/top-level workflow alias keys", async () => {
    const root = await makeTempRoot();
    const home = resolve(root, "home");
    const project = resolve(root, "project");
    process.env.HOME = home;

    await writeJson(resolve(home, ".pi/agent/settings.json"), {
      workflows: { fastModel: "from-workflows", defaultModel: "from-workflows-default" },
      workflow: { fastModel: "from-workflow", defaultModel: "from-workflow-default" },
      piWorkflows: { defaultModel: "from-pi-workflows" },
      workflowFastModel: "from-top-level-fast",
    });

    await expect(loadWorkflowSettings(project)).resolves.toEqual({
      fastModel: "from-top-level-fast",
      defaultModel: "from-pi-workflows",
    });
  });

  test("saves workflow settings without removing unrelated settings", async () => {
    const root = await makeTempRoot();
    const project = resolve(root, "project");

    await writeJson(resolve(project, ".pi/settings.json"), {
      theme: "dark",
      workflows: { fastModel: "old-fast" },
    });

    const path = await saveWorkflowSettings(project, "project", {
      fastModel: "openai-codex/codex-5.3-spark",
      defaultModel: "anthropic/claude-sonnet-4-5",
    });

    expect(path).toBe(workflowSettingsPath(project, "project"));
    const saved = JSON.parse(await Bun.file(path).text());
    expect(saved.theme).toBe("dark");
    expect(saved.workflows).toEqual({
      fastModel: "openai-codex/codex-5.3-spark",
      defaultModel: "anthropic/claude-sonnet-4-5",
    });
  });

  test("saves enabled flag and preserves existing model aliases", async () => {
    const root = await makeTempRoot();
    const project = resolve(root, "project");

    await writeJson(resolve(project, ".pi/settings.json"), {
      workflows: { fastModel: "fast", defaultModel: "heavy" },
    });

    const path = await saveWorkflowSettings(project, "project", { enabled: false, footerMode: "status" });
    const saved = JSON.parse(await Bun.file(path).text());

    expect(saved.workflows).toEqual({
      enabled: false,
      footerMode: "status",
      fastModel: "fast",
      defaultModel: "heavy",
    });
    await expect(loadWorkflowSettings(project)).resolves.toEqual({
      enabled: false,
      footerMode: "status",
      fastModel: "fast",
      defaultModel: "heavy",
    });
  });

  test("ignores missing or invalid settings files", async () => {
    const root = await makeTempRoot();
    const home = resolve(root, "home");
    const project = resolve(root, "project");
    process.env.HOME = home;

    await mkdir(resolve(project, ".pi"), { recursive: true });
    await Bun.write(resolve(project, ".pi/settings.json"), "{ not valid json");

    await expect(loadWorkflowSettings(project)).resolves.toEqual({});
  });
});

describe("describeWorkflowSettingsLocation", () => {
  test("mentions project and global settings locations", () => {
    process.env.HOME = "/home/example";
    const description = describeWorkflowSettingsLocation("/repo");

    expect(description).toContain("/repo/.pi/settings.json");
    expect(description).toContain("/home/example/.pi/agent/settings.json");
  });
});
