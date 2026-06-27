---
name: pi-workflows
description: Use pi workflow subagents for codebase work, repo exploration, implementation planning, reviews, testing, or any task where parallel cheap scouts and focused writer agents can reduce time or token cost.
---

# Pi Workflows

Use the workflow engine whenever it can reduce latency, token cost, or context load. Prefer orchestrating small subagents over doing all repository discovery yourself.

## Default orchestration pattern

1. Stay the orchestrator: keep the overall goal, constraints, and final decision-making in the main conversation.
2. Model routing is mandatory:
   - ALWAYS use the fast model alias `@fast` for inspection: repo scouting, file discovery, reading code, risk review, tests, validation, search, and summarization of existing facts.
   - ALWAYS use the heavy/default model alias `@default` for generation: writing code, editing files, architecture decisions, final synthesis, migration design, and any task that creates new implementation.
   - Do not put heavy/default models on `researcher`, `reviewer`, or `tester` work. Do not put fast models on `coder` or final synthesis work.
3. Spawn cheap/fast scouts first for codebase exploration:
   - `researcher` for repo layout, relevant files, APIs, conventions.
   - `reviewer` for risk scanning and edge cases.
   - `tester` for focused validation commands.
   - Use `model: "@fast"`.
4. Spawn expensive/default agents only for high-value code writing, architecture, or final synthesis. Use `model: "@default"`.
5. Let expensive writer agents work asynchronously when file ownership is clear, while cheap reviewers/testers scout or validate in parallel.
6. Use `strategy: "parallel"` for independent scouts; use `dependsOn` when a writer needs scout outputs first.
7. Keep subagent tasks narrow. Give explicit paths, expected outputs, and limits.
8. Use the live `workflow_spawn` tree plus `workflow_inspect_agent` for individual subagent inspection.
9. Use `workflow_prompt` to inject steering prompts into active subagents when the orchestrator needs to correct course.
10. Use `workflow_status` to inspect results, token usage, and cost, then synthesize and decide next steps yourself.

## Writing code safely

Subagents share a global write-lock system.

- Read-only bash commands require no lock.
- Any mutating bash command must declare `writePaths` with every file/directory it may create, modify, or delete.
- Write locks are held for the workflow run, so two subagents cannot claim the same file or parent/child path.
- If a lock conflict occurs, do not work around it. Re-plan: assign one owner, split files, or have the orchestrator merge changes.
- Prefer one writer per file. Let cheap agents scout/review while the orchestrator or a single writer owns edits.

## Skills and context

Skills available or loaded in the root conversation are inherited by workflow subagents. If a subagent task matches an inherited skill, tell it to follow that skill and read referenced files as needed. Keep inherited skill use focused to avoid token bloat.

## Example scouting plan

```json
{
  "goal": "Understand where to add the new cache invalidation behavior",
  "strategy": "parallel",
  "agents": [
    {
      "id": "layout",
      "class": "researcher",
      "model": "@fast",
      "task": "Find the relevant cache modules, tests, and naming conventions. Return file paths and a short map."
    },
    {
      "id": "risks",
      "class": "reviewer",
      "model": "@fast",
      "task": "Look for edge cases around cache invalidation and concurrency. Return prioritized risks with evidence."
    }
  ]
}
```

## Example writer plan

```json
{
  "goal": "Implement the cache invalidation change after scouting",
  "strategy": "sequential",
  "agents": [
    {
      "id": "writer",
      "class": "coder",
      "model": "@default",
      "task": "Implement the agreed cache invalidation change. Before mutating files, claim write locks by passing writePaths to bash. Keep edits minimal.",
      "tools": ["bash"],
      "canSpawn": true
    },
    {
      "id": "test",
      "class": "tester",
      "model": "@fast",
      "dependsOn": ["writer"],
      "task": "Run the focused tests for the changed files and summarize failures or pass status."
    }
  ]
}
```

## Settings

Workflow model aliases and extension enablement can be configured with `/workflow-settings` or in `~/.pi/agent/settings.json` / `.pi/settings.json`:

```json
{
  "workflows": {
    "enabled": true,
    "footerMode": "status",
    "fastModel": "openai-codex/codex-5.3-spark",
    "defaultModel": "anthropic/claude-sonnet-4-5"
  }
}
```

Environment fallback is also supported:

```bash
PI_WORKFLOW_FAST_MODEL=openai-codex/codex-5.3-spark
PI_WORKFLOW_DEFAULT_MODEL=anthropic/claude-sonnet-4-5
```
