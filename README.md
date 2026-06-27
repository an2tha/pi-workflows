# pi-agent-workflows

A pi extension that lets an overseer model spawn typed workflow subagents from JSON.

## What is implemented

- `workflow_spawn` tool: accepts a compact `WorkflowPlan` JSON string and runs subagents sequentially or in parallel.
- Floating workflow window: `workflow_spawn` opens a focused overlay with collapsible agent trees, tool-call overview, per-agent inspection, pricing, and controls.
- Statusbar accounting: subagent token/cost usage is added into the main pi footer totals with a `wf+` breakdown.
- Close with `q`: returns to the normal pi UI without aborting the workflow.
- Individual inspection: `workflow_inspect_agent`, `/workflow-inspect`, or the overlay Inspect tab show one subagent’s task, model, output, messages, notes, events, usage, and controls.
- Prompt injection: `workflow_prompt`, `/workflow-prompt`, or `p` inside the overlay can steer active subagents while they run.
- Escape abort: pressing Esc in the overlay aborts the workflow and propagates cancellation to running subagents.
- Recursive spawning: agent classes can opt into `canSpawn` and restrict child classes.
- Per-agent model selection: use `model` on a class or spawn spec. Use `@fast`, `@default`, or `@current` sentinels.
- Inter-agent communication: subagents share `workflow_send`, `workflow_receive`, and `workflow_blackboard`.
- Global write locks: mutating bash commands must declare `writePaths`; locks prevent subagents from claiming the same file/path during a run.
- Bash for every subagent: the `bash` tool is mandatory for all spawned agents.
- Root skill inheritance: available/loaded skills from the overseer context are carried into subagent prompts.
- TypeScript API: register custom agent classes and custom workflow tools with `createWorkflowExtension`, `defineAgentClass`, and `defineWorkflowTool`.
- Main-agent skill: `skills/pi-workflows/SKILL.md` encourages workflow-first orchestration for codebase work and mandates `@fast` for inspection, `@default` for generation.

## Install

Install from npm:

```bash
pi install npm:pi-agent-workflows
```

Or install directly from GitHub:

```bash
pi install git:github.com/an2tha/pi-worfklows
```

For local development, try a checkout without installing:

```bash
pi -e /path/to/pi-workflows/index.ts
```

Configure workflow model aliases, enable/disable the extension, and choose non-invasive status vs footer replacement mode:

```text
/workflow-settings
/workflow-settings show
/workflow-settings disable
/workflow-settings enable
/workflow-settings footer status
```

## Example plan

```json
{
  "goal": "Investigate and validate the CLI parser",
  "strategy": "parallel",
  "agents": [
    {
      "id": "research",
      "class": "researcher",
      "task": "Find the parser entry points and summarize relevant files.",
      "model": "@fast"
    },
    {
      "id": "review",
      "class": "reviewer",
      "task": "Look for parser edge cases and safety risks.",
      "model": "@fast"
    }
  ]
}
```

Configure fast/default model aliases in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "workflows": {
    "fastModel": "openai-codex/codex-5.3-spark",
    "defaultModel": "anthropic/claude-sonnet-4-5"
  }
}
```

Environment variables are still supported as fallback:

```bash
PI_WORKFLOW_FAST_MODEL=openai-codex/codex-5.3-spark
PI_WORKFLOW_DEFAULT_MODEL=anthropic/claude-sonnet-4-5
```

## Write locking

The subagent `bash` tool treats read commands as unlocked. Commands that look mutating are rejected unless they pass `writePaths`.

Example mutating bash call inside a custom workflow tool:

```ts
await ctx.bash("python3 scripts/update.py src/cache.ts", {
  writePaths: ["src/cache.ts"],
  lockTimeoutMs: 5000,
});
```

Locks are global to the engine and held for the workflow run. This prevents two subagents from owning the same file or a parent/child path concurrently.

## TypeScript API sketch

```ts
import Type from "typebox";
import {
  createWorkflowExtension,
  defineAgentClass,
  defineWorkflowTool,
  textResult,
} from "pi-agent-workflows";

export default createWorkflowExtension({
  agentClasses: [
    defineAgentClass({
      name: "docs-writer",
      description: "Writes concise documentation from findings.",
      model: "@fast",
      tools: ["bash", "summarize_file"],
    }),
  ],
  tools: [
    defineWorkflowTool({
      name: "summarize_file",
      description: "Read a file and return a short summary.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(params, ctx) {
        const quotedPath = JSON.stringify(params.path);
        const result = await ctx.bash(`python3 - <<'PY'\nfrom pathlib import Path\nprint(Path(${quotedPath}).read_text()[:2000])\nPY`);
        return textResult(result.stdout, result);
      },
    }),
  ],
});
```

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
