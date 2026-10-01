/**
 * Regression test for the "t.slice is not a function" crash (Quest #15923 app).
 *
 * Real streaming models make pi emit `toolcall_end` with toolCall.arguments as
 * a PARSED OBJECT, not a JSON string. The reducer used to store that object
 * straight into block.args / block.argsPretty, and the tool-card header then
 * crashed on args.slice(). This replays every malformed-event variant through
 * the reducer + summarizeArgs and asserts no crash and string-only output.
 *
 * Run: bun scripts/test_pi_events.ts
 */
import { applyEvent, createTurn, summarizeArgs } from "../src/lib/pi-events";
import type { PiEvent, Turn } from "../src/lib/types";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function toolBlock(turn: Turn) {
  const block = turn.blocks.find((b) => b.kind === "tool");
  if (!block || block.kind !== "tool") throw new Error("no tool block");
  return block;
}

// ---------------------------------------------------------------- case 1
// The reported production crash: write tool completes with OBJECT arguments.
{
  const turn = createTurn("make a file", "s1");
  const events: PiEvent[] = [
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "c1", toolName: "write" } },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '{"path":"todo' } },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '.md","content":"hi"}' } },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { id: "c1", name: "write", arguments: { path: "todo.md", content: "hi" } },
      },
    },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "write", result: { content: [{ text: "ok" }] } },
    { type: "agent_settled" },
  ];
  let threw: unknown = null;
  try {
    for (const event of events) applyEvent(turn, event);
  } catch (error) {
    threw = error;
  }
  check("object arguments: applyEvent does not throw", threw === null, String(threw));
  const block = toolBlock(turn);
  check("object arguments: block.args is a string", typeof block.args === "string", typeof block.args);
  check("object arguments: argsPretty is a string", typeof block.argsPretty === "string", typeof block.argsPretty);
  let summaryThrew: unknown = null;
  let summary = "";
  try {
    summary = summarizeArgs(block.toolName, block.argsPretty || block.args);
  } catch (error) {
    summaryThrew = error;
  }
  check("object arguments: summarizeArgs does not throw", summaryThrew === null, String(summaryThrew));
  check("object arguments: summary shows the path", summary === "todo.md", summary);
  check("object arguments: output attached", block.output === "ok", block.output);
  check("object arguments: state done", block.state === "done", block.state);
}

// ---------------------------------------------------------------- case 2
// String arguments (classic shape) must keep working.
{
  const turn = createTurn("run ls", "s2");
  const events: PiEvent[] = [
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "c1", toolName: "bash" } },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { id: "c1", name: "bash", arguments: '{"command":"ls -la"}' },
      },
    },
    { type: "agent_settled" },
  ];
  for (const event of events) applyEvent(turn, event);
  const block = toolBlock(turn);
  check("string arguments: args unchanged", block.args === '{"command":"ls -la"}', block.args);
  check(
    "string arguments: summary shows the command",
    summarizeArgs(block.toolName, block.argsPretty || block.args) === "ls -la"
  );
}

// ---------------------------------------------------------------- case 3
// toolcall_end with NO toolCall, tool_execution_start creating the block.
{
  const turn = createTurn("read it", "s3");
  const events: PiEvent[] = [
    {
      type: "tool_execution_start",
      toolCallId: "c9",
      toolName: "read",
      args: { path: "README.md" },
    },
    { type: "tool_execution_end", toolCallId: "c9", toolName: "read", result: { content: [{ text: "contents" }] } },
  ];
  let threw: unknown = null;
  try {
    for (const event of events) applyEvent(turn, event);
  } catch (error) {
    threw = error;
  }
  check("execution-only path: does not throw", threw === null, String(threw));
  const block = toolBlock(turn);
  check(
    "execution-only path: summary works",
    summarizeArgs(block.toolName, block.argsPretty || block.args) === "README.md"
  );
}

// ---------------------------------------------------------------- case 4
// Hostile summarizeArgs inputs must never throw.
{
  const inputs: unknown[] = [
    undefined,
    null,
    42,
    true,
    { path: "x.md" },
    { weird: { nested: { deeper: [1, 2, 3] } } },
    "",
    "   ",
    "not json at all {{{",
    '{"command":"a".repeat(200)}',
    [1, 2, 3],
  ];
  let threw: unknown = null;
  try {
    for (const input of inputs) {
      for (const tool of ["bash", "write", "edit", "read", "grep", "find", "ls", "mystery-tool", ""]) {
        const out = summarizeArgs(tool, input);
        if (typeof out !== "string") throw new Error(`non-string summary for ${tool}: ${typeof out}`);
      }
    }
  } catch (error) {
    threw = error;
  }
  check("summarizeArgs: hostile inputs never throw", threw === null, String(threw));
}

// ---------------------------------------------------------------- case 5
// Non-string text/thinking content and error fields must be coerced to strings.
{
  const turn = createTurn("weird stream", "s5");
  const events: PiEvent[] = [
    { type: "message_update", assistantMessageEvent: { type: "text_start" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: { bad: "delta" } } },
    { type: "message_update", assistantMessageEvent: { type: "text_end", content: { bad: "content" } } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: 123 } },
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      errorMessage: { code: "rate_limited", message: "slow down" },
    },
    {
      type: "extension_error",
      extensionPath: "/ext/tool",
      error: { stack: "boom" },
    },
    { type: "agent_settled" },
  ];
  let threw: unknown = null;
  try {
    for (const event of events) applyEvent(turn, event);
  } catch (error) {
    threw = error;
  }
  check("malformed content/errors: applyEvent does not throw", threw === null, String(threw));
  const text = turn.blocks.find((b) => b.kind === "text");
  check("text content coerced to string", text?.kind === "text" && typeof text.content === "string");
  check("errorText coerced to string", turn.errorText === undefined || typeof turn.errorText === "string");
  // The slice in PiApp's toast must be safe on whatever errorText we produced.
  check("PiApp toast slice is safe", typeof String(turn.errorText ?? "").slice(0, 300) === "string");
}

// ---------------------------------------------------------------- case 6
// tool_execution results with null/missing content entries must not throw.
{
  const turn = createTurn("nulls", "s6");
  const events: PiEvent[] = [
    {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      partialResult: { content: [null, { text: "partial" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      isError: true,
      result: { content: [{ text: "boom" }, null, {}] },
    },
  ];
  let threw: unknown = null;
  try {
    for (const event of events) applyEvent(turn, event);
  } catch (error) {
    threw = error;
  }
  check("null content entries: does not throw", threw === null, String(threw));
  const block = toolBlock(turn);
  check("error output attached", block.output === "boom", block.output);
  check("error state set", block.state === "error", block.state);
}

console.log("");
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All pi-event reducer tests passed.");
