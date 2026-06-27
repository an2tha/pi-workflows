import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createWorkflowExtension } from "../src/extension";
import { WorkflowEngine } from "../src/engine";

describe("WorkflowEngine defaults", () => {
  test("registers built-in communication and locking tools", () => {
    const engine = new WorkflowEngine();

    expect(engine.getToolNames().sort()).toEqual([
      "bash",
      "workflow_blackboard",
      "workflow_locks",
      "workflow_receive",
      "workflow_send",
      "workflow_spawn",
    ]);
  });

  test("registers default agent classes", () => {
    const engine = new WorkflowEngine();
    const classNames = engine.getAgentClasses().map((item) => item.name).sort();

    expect(classNames).toEqual(["coder", "generalist", "researcher", "reviewer", "synthesizer", "tester"]);
  });
});

describe("createWorkflowExtension", () => {
  test("registers workflow tools, command, and skill discovery path", async () => {
    const tools: Array<{ name: string }> = [];
    const commands: string[] = [];
    const handlers = new Map<string, Function[]>();
    let activeTools: string[] = [];
    const pi = {
      on(event: string, handler: Function) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      getActiveTools() {
        return activeTools;
      },
      setActiveTools(next: string[]) {
        activeTools = next;
      },
      exec() {
        throw new Error("not used in this test");
      },
    };

    createWorkflowExtension()(pi as never);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "workflow_inspect_agent",
      "workflow_message",
      "workflow_prompt",
      "workflow_spawn",
      "workflow_status",
    ]);
    expect(commands).toContain("workflow-classes");
    expect(commands).toContain("workflow-inspect");
    expect(commands).toContain("workflow-prompt");
    expect(commands).toContain("workflow-settings");

    const discover = handlers.get("resources_discover")?.[0];
    expect(typeof discover).toBe("function");
    const result = await discover?.({ type: "resources_discover", cwd: process.cwd(), reason: "startup" }, {});
    expect(result.skillPaths).toContain(resolve(process.cwd(), "skills"));

    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    expect(typeof beforeAgentStart).toBe("function");
    const ctx = { cwd: process.cwd() };
    const injected = await beforeAgentStart?.({
      type: "before_agent_start",
      prompt: "do work",
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    }, ctx);
    expect(injected.systemPrompt).toContain("pi-workflows:auto-injected-skill");
    expect(injected.systemPrompt).toContain("<skill name=\"pi-workflows\"");
    expect(injected.systemPrompt).toContain("Use the workflow engine whenever it can reduce latency");

    const reinjected = await beforeAgentStart?.({
      type: "before_agent_start",
      prompt: "do work",
      systemPrompt: injected.systemPrompt,
      systemPromptOptions: {},
    }, ctx);
    expect(reinjected.systemPrompt.match(/pi-workflows:auto-injected-skill/g)).toHaveLength(1);

    let footerSet = false;
    let statusValue: string | undefined;
    const sessionStart = handlers.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start", reason: "startup" }, {
      cwd: process.cwd(),
      mode: "tui",
      sessionManager: { getSessionId: () => "session-test" },
      ui: {
        setFooter: () => { footerSet = true; },
        setStatus: (_key: string, value: string | undefined) => { statusValue = value; },
      },
    });
    expect(footerSet).toBe(false);
    expect(statusValue).toBeUndefined();
    expect(activeTools).toEqual(expect.arrayContaining(["workflow_spawn", "workflow_status"]));
  });
});
