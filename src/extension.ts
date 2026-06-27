import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { sendMessage, snapshotRun } from "./bus";
import { renderAgentInspection, renderWorkflowTree } from "./display";
import { WorkflowEngine } from "./engine";
import { createWorkflowFooter } from "./footer";
import { WorkflowOverlay } from "./tui";
import { isWorkflowEnabled, loadWorkflowSettings, saveWorkflowSettings, type WorkflowSettingsScope } from "./settings";
import { textResult, type WorkflowEngineOptions, type WorkflowHostContext } from "./types";

export interface WorkflowExtensionOptions extends WorkflowEngineOptions {
  engine?: WorkflowEngine;
}

const WORKFLOW_TOOL_NAMES = [
  "workflow_spawn",
  "workflow_status",
  "workflow_inspect_agent",
  "workflow_prompt",
  "workflow_message",
];

export function createWorkflowExtension(options: WorkflowExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const engine = options.engine ?? new WorkflowEngine(options);
    const skillDir = fileURLToPath(new URL("../skills", import.meta.url));
    const skillPath = fileURLToPath(new URL("../skills/pi-workflows/SKILL.md", import.meta.url));
    let autoInjectedSkillBlock: Promise<string> | undefined;
    const getAutoInjectedSkillBlock = () => {
      autoInjectedSkillBlock ??= loadAutoInjectedSkillBlock(skillPath);
      return autoInjectedSkillBlock;
    };

    pi.on("resources_discover", async (event) => {
      const settings = await loadWorkflowSettings(event.cwd);
      return isWorkflowEnabled(settings) ? { skillPaths: [skillDir] } : {};
    });
    pi.on("session_start", async (_event, ctx) => {
      await applyWorkflowActivation(pi, ctx, engine);
    });
    pi.on("after_provider_response", async (_event, ctx) => {
      const settings = await loadWorkflowSettings(ctx.cwd);
      if (isWorkflowEnabled(settings) && (settings.footerMode ?? "status") === "status") updateWorkflowStatus(ctx, engine);
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const settings = await loadWorkflowSettings(ctx.cwd);
      if (!isWorkflowEnabled(settings)) return undefined;
      return { systemPrompt: appendAutoInjectedSkill(event.systemPrompt, await getAutoInjectedSkillBlock()) };
    });

    const SpawnParams = Type.Object({
      planJson: Type.String({
        description: "JSON string matching WorkflowPlan: { goal?, strategy?, agents:[{id?, class, task, model?, tools?, dependsOn?, context?, canSpawn?}], limits?, synthesis? }",
      }),
    });

    const StatusParams = Type.Object({
      runId: Type.Optional(Type.String({ description: "Workflow run id. Defaults to the most recent run." })),
      includeMessages: Type.Optional(Type.Boolean()),
      includeBlackboard: Type.Optional(Type.Boolean()),
      includeEvents: Type.Optional(Type.Boolean()),
      includeLocks: Type.Optional(Type.Boolean()),
    });

    const MessageParams = Type.Object({
      runId: Type.String(),
      to: Type.Optional(Type.String({ description: "Target agent id. Omit to broadcast." })),
      channel: Type.Optional(Type.String({ description: "Logical channel." })),
      text: Type.String(),
      data: Type.Optional(Type.Any()),
    });

    const InspectAgentParams = Type.Object({
      runId: Type.Optional(Type.String({ description: "Workflow run id. Defaults to the most recent run." })),
      agentId: Type.String({ description: "Subagent id to inspect." }),
      includeMessages: Type.Optional(Type.Boolean()),
      includeBlackboard: Type.Optional(Type.Boolean()),
      includeEvents: Type.Optional(Type.Boolean()),
    });

    const PromptAgentParams = Type.Object({
      runId: Type.Optional(Type.String({ description: "Workflow run id. Defaults to the most recent run." })),
      agentId: Type.String({ description: "Active subagent id." }),
      prompt: Type.String({ description: "Prompt to inject into the subagent." }),
      mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "steer interrupts after current tool batch; followUp waits." })),
    });

    pi.registerTool({
      name: "workflow_spawn",
      label: "Spawn workflow agents",
      description:
        "Spawn one or more workflow subagents from a JSON plan. Agents run with their own model/tool budget, shared blackboard, and inter-agent message bus.",
      promptSnippet:
        "workflow_spawn: spawn typed subagents from a WorkflowPlan JSON string for parallel/recursive work.",
      promptGuidelines: [
        "Use workflow_spawn when independent subagents can reduce wall-clock time or when a cheaper/faster model can do focused work.",
        "Keep planJson compact. Prefer researcher/reviewer/tester on fast models and only enable canSpawn when recursion is useful.",
        "Every spawned subagent has bash plus workflow_send/workflow_receive/workflow_blackboard/workflow_locks; mutating bash commands must declare writePaths.",
      ],
      parameters: SpawnParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        await assertWorkflowEnabled(ctx);
        const knownRuns = new Set(engine.getRuns().map((run) => run.id));
        let currentRunId: string | undefined;
        let requestOverlayRender: (() => void) | undefined;
        let overlayClosed = false;
        const getDisplayedRun = () => currentRunId ? engine.getRun(currentRunId) : findSpawnedRun(engine, knownRuns);
        if (ctx.mode === "tui" && ctx.hasUI) {
          void ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
            requestOverlayRender = () => tui.requestRender();
            const close = () => {
              overlayClosed = true;
              done();
            };
            return new WorkflowOverlay({
              engine,
              getRunId: () => getDisplayedRun()?.id,
              done: close,
              abort: () => ctx.abort(),
            });
          }, {
            overlay: true,
            overlayOptions: {
              width: "96%",
              maxHeight: "92%",
              minWidth: 92,
              anchor: "center",
              margin: 1,
              visible: (termWidth, termHeight) => termWidth >= 96 && termHeight >= 22,
            },
            onHandle: (handle) => handle.focus(),
          }).catch(() => {
            overlayClosed = true;
          });
        }
        const publish = () => {
          const run = getDisplayedRun();
          currentRunId = run?.id ?? currentRunId;
          if (!overlayClosed) requestOverlayRender?.();
          void loadWorkflowSettings(ctx.cwd).then((settings) => {
            if (isWorkflowEnabled(settings) && (settings.footerMode ?? "status") === "status") updateWorkflowStatus(ctx, engine);
          });
          onUpdate?.(textResult(renderWorkflowTree(run, { includeOutputs: true }), run ? compactRunSnapshot(engine, run) : { status: "starting" }));
        };

        publish();
        const interval = setInterval(publish, 250);
        signal?.addEventListener("abort", publish, { once: true });
        try {
          const result = await engine.runPlan(params.planJson, await makeHost(ctx, pi, signal, await getAutoInjectedSkillBlock()));
          currentRunId = result.runId;
          const run = engine.getRun(result.runId);
          publish();
          return textResult(renderWorkflowTree(run, { includeOutputs: true, includeEvents: true, maxOutputChars: 1200 }), result);
        } finally {
          clearInterval(interval);
          signal?.removeEventListener("abort", publish);
        }
      },
    });

    pi.registerTool({
      name: "workflow_status",
      label: "Workflow status",
      description: "Inspect a workflow run, including agents, optional messages, blackboard, and events.",
      promptSnippet: "workflow_status: inspect prior workflow runs and agent outputs.",
      parameters: StatusParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        await assertWorkflowEnabled(ctx);
        const run = params.runId ? engine.getRun(params.runId) : engine.getRuns().at(-1);
        if (!run) return textResult<unknown>("No workflow run found.", { found: false });
        const snapshot = snapshotRun(run);
        const payload = {
          ...snapshot,
          messages: params.includeMessages ? snapshot.messages : undefined,
          blackboard: params.includeBlackboard ? snapshot.blackboard : snapshot.blackboard.slice(-10),
          events: params.includeEvents ? snapshot.events : snapshot.events.slice(-20),
          locks: params.includeLocks ? engine.getWriteLocks(run.id) : engine.getWriteLocks(run.id).slice(-20),
        };
        return textResult<unknown>(JSON.stringify(payload, null, 2), payload);
      },
    });

    pi.registerTool({
      name: "workflow_inspect_agent",
      label: "Inspect workflow subagent",
      description: "Render a detailed inspection panel for one workflow subagent, including messages, blackboard notes, events, usage, and prompt-injection hint.",
      promptSnippet: "workflow_inspect_agent: inspect one subagent in a workflow tree.",
      parameters: InspectAgentParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        await assertWorkflowEnabled(ctx);
        const run = params.runId ? engine.getRun(params.runId) : engine.getRuns().at(-1);
        const text = renderAgentInspection(run, params.agentId, {
          includeMessages: params.includeMessages,
          includeBlackboard: params.includeBlackboard,
          includeEvents: params.includeEvents,
        });
        return textResult(text, { runId: run?.id, agentId: params.agentId });
      },
    });

    pi.registerTool({
      name: "workflow_prompt",
      label: "Inject prompt into subagent",
      description: "Inject a steering or follow-up prompt into an active workflow subagent.",
      promptSnippet: "workflow_prompt: steer an active subagent with an injected prompt.",
      parameters: PromptAgentParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        await assertWorkflowEnabled(ctx);
        const run = params.runId ? engine.getRun(params.runId) : engine.getRuns().at(-1);
        if (!run) throw new Error("No workflow run found.");
        const result = engine.injectPrompt(run.id, params.agentId, params.prompt, params.mode ?? "steer");
        return textResult(`Injected ${result.mode} prompt into ${result.agentId}.`, result);
      },
    });

    pi.registerTool({
      name: "workflow_message",
      label: "Send workflow message",
      description: "Send a message from the overseer to a running workflow's agent or channel.",
      promptSnippet: "workflow_message: send a message to a workflow agent/channel.",
      parameters: MessageParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        await assertWorkflowEnabled(ctx);
        const run = engine.getRun(params.runId);
        if (!run) throw new Error(`Workflow run not found: ${params.runId}`);
        const message = sendMessage(run, {
          from: "overseer",
          to: params.to,
          channel: params.channel,
          text: params.text,
          data: params.data,
        });
        return textResult(`sent ${message.id}`, message);
      },
    });

    pi.registerCommand("workflow-settings", {
      description: "Configure workflow fast/default model aliases.",
      async handler(args, ctx) {
        await configureWorkflowSettings(args, ctx, pi, engine);
      },
    });

    pi.registerCommand("workflow-classes", {
      description: "List registered workflow agent classes and subagent tools.",
      async handler(_args, ctx) {
        if (!(await notifyIfWorkflowDisabled(ctx))) return;
        const classes = engine.getAgentClasses().map((item) => ({
          name: item.name,
          description: item.description,
          model: typeof item.model === "string" ? item.model : item.model ? `${item.model.provider}/${item.model.id}` : undefined,
          tools: item.tools,
          canSpawn: item.canSpawn,
          allowedChildClasses: item.allowedChildClasses,
        }));
        ctx.ui.notify(`Workflow classes:\n${JSON.stringify({ classes, tools: engine.getToolNames() }, null, 2)}`);
      },
    });

    pi.registerCommand("workflow-inspect", {
      description: "Inspect a workflow subagent. Usage: /workflow-inspect [runId] <agentId>",
      async handler(args, ctx) {
        if (!(await notifyIfWorkflowDisabled(ctx))) return;
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const latestRun = engine.getRuns().at(-1);
        const runId = parts.length >= 2 ? parts[0] : latestRun?.id;
        const agentId = parts.length >= 2 ? parts[1] : parts[0] ?? (await ctx.ui.input("Inspect subagent", "agent id"));
        const run = runId ? engine.getRun(runId) : undefined;
        ctx.ui.notify(renderAgentInspection(run, agentId ?? ""));
      },
    });

    pi.registerCommand("workflow-prompt", {
      description: "Inject a prompt into an active workflow subagent. Usage: /workflow-prompt [runId] <agentId> <prompt>",
      async handler(args, ctx) {
        if (!(await notifyIfWorkflowDisabled(ctx))) return;
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const latestRun = engine.getRuns().at(-1);
        const runId = parts.length >= 3 ? parts.shift() : latestRun?.id;
        const agentId = parts.shift() ?? (await ctx.ui.input("Prompt subagent", "agent id"));
        const prompt = parts.join(" ") || (await ctx.ui.editor("Prompt to inject"));
        if (!runId || !agentId || !prompt) {
          ctx.ui.notify("workflow-prompt requires a run, agent id, and prompt", "warning");
          return;
        }
        const result = engine.injectPrompt(runId, agentId, prompt, "steer");
        ctx.ui.notify(`Injected prompt into ${result.agentId}.`, "info");
      },
    });
  };
}

async function applyWorkflowActivation(pi: ExtensionAPI, ctx: ExtensionContext, engine: WorkflowEngine): Promise<void> {
  const settings = await loadWorkflowSettings(ctx.cwd);
  const activeTools = pi.getActiveTools();
  const enabled = isWorkflowEnabled(settings);
  const nextTools = enabled
    ? Array.from(new Set([...activeTools, ...WORKFLOW_TOOL_NAMES]))
    : activeTools.filter((tool) => !WORKFLOW_TOOL_NAMES.includes(tool));
  if (nextTools.join("\0") !== activeTools.join("\0")) pi.setActiveTools(nextTools);

  if (ctx.mode !== "tui") return;
  if (!enabled) {
    ctx.ui.setStatus("pi-workflows", "workflow: off");
    return;
  }

  if (settings.footerMode === "replace") {
    ctx.ui.setFooter((_tui, theme, footerData) => createWorkflowFooter(ctx, engine, theme, footerData));
    ctx.ui.setStatus("pi-workflows", undefined);
  } else if (settings.footerMode === "off") {
    ctx.ui.setStatus("pi-workflows", undefined);
  } else {
    updateWorkflowStatus(ctx, engine);
  }
}

function updateWorkflowStatus(ctx: ExtensionContext, engine: WorkflowEngine): void {
  if (ctx.mode !== "tui") return;
  const usage = engine.getWorkflowUsage(ctx.sessionManager.getSessionId());
  if (!usage?.totalTokens) {
    ctx.ui.setStatus("pi-workflows", undefined);
    return;
  }
  ctx.ui.setStatus("pi-workflows", `wf ↑${formatCompact(usage.input)} ↓${formatCompact(usage.output)} $${(usage.cost ?? 0).toFixed(3)}`);
}

async function assertWorkflowEnabled(ctx: ExtensionContext): Promise<void> {
  const settings = await loadWorkflowSettings(ctx.cwd);
  if (!isWorkflowEnabled(settings)) {
    throw new Error("pi-agent-workflows is disabled in settings. Run /workflow-settings enable to re-enable it.");
  }
}

async function notifyIfWorkflowDisabled(ctx: ExtensionCommandContext): Promise<boolean> {
  const settings = await loadWorkflowSettings(ctx.cwd);
  if (isWorkflowEnabled(settings)) return true;
  ctx.ui.notify("pi-agent-workflows is disabled. Run /workflow-settings enable to re-enable it.", "warning");
  return false;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

async function configureWorkflowSettings(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, engine: WorkflowEngine): Promise<void> {
  const trimmed = args.trim();
  if (trimmed) {
    const handled = await configureWorkflowSettingsFromArgs(trimmed, ctx, pi, engine);
    if (handled) return;
  }

  const current = await loadWorkflowSettings(ctx.cwd);
  const scopeChoice = ctx.hasUI
    ? await ctx.ui.select("Workflow settings scope", ["project (.pi/settings.json)", "global (~/.pi/agent/settings.json)"], { timeout: 120000 })
    : "project (.pi/settings.json)";
  if (!scopeChoice) return;
  const scope: WorkflowSettingsScope = scopeChoice.startsWith("global") ? "global" : "project";

  const enabledChoice = ctx.hasUI
    ? await ctx.ui.select("pi-agent-workflows", [
        `keep current (${isWorkflowEnabled(current) ? "enabled" : "disabled"})`,
        "enabled",
        "disabled",
      ], { timeout: 120000 })
    : `keep current (${isWorkflowEnabled(current) ? "enabled" : "disabled"})`;
  if (!enabledChoice) return;

  const footerChoice = ctx.hasUI
    ? await ctx.ui.select("Workflow TUI reporting", [
        `keep current (${current.footerMode ?? "status"})`,
        "status (non-invasive; recommended)",
        "replace main footer (may conflict with other footer extensions)",
        "off",
      ], { timeout: 120000 })
    : `keep current (${current.footerMode ?? "status"})`;
  if (!footerChoice) return;

  const modelChoices = workflowModelChoices(ctx);
  const keepFast = `keep current fast (${current.fastModel ?? "unset"})`;
  const keepDefault = `keep current default (${current.defaultModel ?? "unset"})`;
  const clearFast = "clear fast model";
  const clearDefault = "clear default model";

  const fastChoice = ctx.hasUI
    ? await ctx.ui.select("Workflow fast model (@fast for inspection)", [keepFast, clearFast, ...modelChoices], { timeout: 120000 })
    : keepFast;
  if (!fastChoice) return;
  const defaultChoice = ctx.hasUI
    ? await ctx.ui.select("Workflow default/heavy model (@default for generation)", [keepDefault, clearDefault, ...modelChoices], { timeout: 120000 })
    : keepDefault;
  if (!defaultChoice) return;

  const enabled = enabledChoice.startsWith("keep current") ? current.enabled : enabledChoice === "enabled";
  const footerMode = footerChoice.startsWith("keep current")
    ? current.footerMode
    : footerChoice.startsWith("replace")
      ? "replace"
      : footerChoice.startsWith("off")
        ? "off"
        : "status";
  const fastModel = fastChoice === keepFast ? current.fastModel : fastChoice === clearFast ? undefined : parseWorkflowModelChoice(fastChoice);
  const defaultModel = defaultChoice === keepDefault ? current.defaultModel : defaultChoice === clearDefault ? undefined : parseWorkflowModelChoice(defaultChoice);
  const path = await saveWorkflowSettings(ctx.cwd, scope, { enabled, footerMode, fastModel, defaultModel });
  await applyWorkflowActivation(pi, ctx, engine);
  ctx.ui.notify(`Saved workflow settings to ${path}:\nenabled = ${enabled ?? true}\nfooterMode = ${footerMode ?? "status"}\n@fast = ${fastModel ?? "unset"}\n@default = ${defaultModel ?? "unset"}`, "info");
}

async function configureWorkflowSettingsFromArgs(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, engine: WorkflowEngine): Promise<boolean> {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts[0] === "show" || parts[0] === "list") {
    const current = await loadWorkflowSettings(ctx.cwd);
    ctx.ui.notify(`Workflow settings:\nenabled = ${isWorkflowEnabled(current)}\nfooterMode = ${current.footerMode ?? "status"}\n@fast = ${current.fastModel ?? "unset"}\n@default = ${current.defaultModel ?? "unset"}`, "info");
    return true;
  }

  let scope: WorkflowSettingsScope = "project";
  if (parts[0] === "global" || parts[0] === "project") scope = parts.shift() as WorkflowSettingsScope;
  const key = parts.shift();
  const value = parts.join(" ").trim();
  if (key === "enable" || key === "enabled" || key === "disable" || key === "disabled") {
    const enabled = key === "enable" || key === "enabled";
    const path = await saveWorkflowSettings(ctx.cwd, scope, { enabled });
    await applyWorkflowActivation(pi, ctx, engine);
    ctx.ui.notify(`Saved pi-agent-workflows ${enabled ? "enabled" : "disabled"} to ${path}`, "info");
    return true;
  }

  if (key === "footer" && (value === "status" || value === "replace" || value === "off")) {
    const path = await saveWorkflowSettings(ctx.cwd, scope, { footerMode: value });
    await applyWorkflowActivation(pi, ctx, engine);
    ctx.ui.notify(`Saved workflow footer mode to ${path}: ${value}`, "info");
    return true;
  }

  if ((key === "fast" || key === "default") && value) {
    const path = await saveWorkflowSettings(ctx.cwd, scope, {
      [key === "fast" ? "fastModel" : "defaultModel"]: value,
    });
    ctx.ui.notify(`Saved ${key} workflow model to ${path}: ${value}`, "info");
    return true;
  }

  if (args.trim()) {
    ctx.ui.notify(
      "Usage: /workflow-settings, /workflow-settings show, /workflow-settings [project|global] enable|disable, /workflow-settings [project|global] footer status|replace|off, /workflow-settings [project|global] fast <provider/model>, /workflow-settings [project|global] default <provider/model>",
      "warning",
    );
    return true;
  }
  return false;
}

function workflowModelChoices(ctx: ExtensionCommandContext): string[] {
  const models = ctx.modelRegistry.getAvailable().length ? ctx.modelRegistry.getAvailable() : ctx.modelRegistry.getAll();
  return models.map((model) => `${model.provider}/${model.id} — ${model.name}`).sort();
}

function parseWorkflowModelChoice(choice: string): string {
  return choice.split(" — ")[0]!.trim();
}

async function makeHost(ctx: ExtensionContext, pi: ExtensionAPI, signal?: AbortSignal, autoInjectedSkillBlock?: string): Promise<WorkflowHostContext> {
  return {
    cwd: ctx.cwd,
    signal,
    modelRegistry: ctx.modelRegistry,
    currentModel: ctx.model,
    sessionId: ctx.sessionManager.getSessionId(),
    workflowSettings: await loadWorkflowSettings(ctx.cwd),
    inheritedSkillContext: extractInheritedSkillContext(ctx, autoInjectedSkillBlock),
    exec: (command, args, options) => pi.exec(command, args, options),
  };
}

const AUTO_INJECTED_SKILL_MARKER = "<!-- pi-workflows:auto-injected-skill -->";

async function loadAutoInjectedSkillBlock(skillPath: string): Promise<string> {
  const content = await readFile(skillPath, "utf8");
  return [
    AUTO_INJECTED_SKILL_MARKER,
    "The pi-workflows skill is auto-injected silently. Follow it when planning, delegating, or working in codebases; do not announce that it was loaded.",
    `<skill name="pi-workflows" location="${skillPath}">`,
    content.trim(),
    "</skill>",
  ].join("\n");
}

function appendAutoInjectedSkill(systemPrompt: string, skillBlock: string): string {
  if (systemPrompt.includes(AUTO_INJECTED_SKILL_MARKER)) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${skillBlock}`;
}

function extractInheritedSkillContext(ctx: ExtensionContext, autoInjectedSkillBlock?: string): string | undefined {
  const parts: string[] = [];
  const systemPrompt = autoInjectedSkillBlock ? `${ctx.getSystemPrompt()}\n\n${autoInjectedSkillBlock}` : ctx.getSystemPrompt();
  const availableSkills = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0];
  if (availableSkills) parts.push(`Available skills from the root agent:\n${availableSkills}`);

  const loadedSkillBlocks: string[] = [];
  for (const match of systemPrompt.matchAll(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g)) {
    loadedSkillBlocks.push(match[0]);
  }
  for (const entry of ctx.sessionManager.getBranch()) {
    const text = entry.type === "message" ? messageText(entry.message) : entry.type === "custom_message" ? contentText(entry.content) : "";
    for (const match of text.matchAll(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g)) {
      loadedSkillBlocks.push(match[0]);
    }
  }
  const uniqueSkillBlocks = Array.from(new Set(loadedSkillBlocks));
  if (uniqueSkillBlocks.length) {
    parts.push(`Loaded skill files from the root conversation:\n${uniqueSkillBlocks.join("\n\n")}`);
  }

  if (parts.length === 0) return undefined;
  return limitText(parts.join("\n\n"), 40_000);
}

function messageText(message: unknown): string {
  return message && typeof message === "object" && "content" in message ? contentText(message.content) : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item ? String(item.text) : ""))
    .filter(Boolean)
    .join("\n");
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...[truncated inherited skill context]`;
}

function findSpawnedRun(engine: WorkflowEngine, knownRuns: Set<string>) {
  return engine.getRuns().find((run) => !knownRuns.has(run.id));
}

function compactRunSnapshot(engine: WorkflowEngine, run: NonNullable<ReturnType<WorkflowEngine["getRun"]>>): unknown {
  return {
    runId: run.id,
    status: run.status,
    goal: run.goal,
    agents: Array.from(run.agents.values()).map((agent) => ({
      id: agent.id,
      className: agent.className,
      status: agent.status,
      parentAgentId: agent.parentAgentId,
      error: agent.error,
      usage: agent.usage,
    })),
    usage: run.usage,
    messages: run.messages.length,
    blackboard: run.blackboard.length,
    events: run.events.slice(-20),
    locks: engine.getWriteLocks(run.id),
  };
}

function compactToolResult(result: Awaited<ReturnType<WorkflowEngine["runPlan"]>>): unknown {
  return {
    runId: result.runId,
    status: result.status,
    goal: result.goal,
    results: result.results.map((item) => ({
      id: item.id,
      className: item.className,
      status: item.status,
      model: item.model,
      output: item.output,
      error: item.error,
      usage: item.usage,
    })),
    synthesis: result.synthesis,
    usage: result.usage,
    blackboard: result.blackboard.slice(-20),
    error: result.error,
  };
}
