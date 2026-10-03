/**
 * Tool-call parsing for every provider shape Henry talks to.
 *
 * A model "calling a tool" is not one wire format. Measured against Ollama
 * 0.34.4 on this machine, same prompt, same tool schema:
 *
 *   llama3.2:3b        → `choices[0].message.tool_calls[]` (OpenAI shape)
 *   llama3.2:3b        → `message.tool_calls[]` with `arguments` as an OBJECT
 *                        (Ollama native /api/chat shape)
 *   qwen2.5-coder:7b   → NO tool_calls field at all; the call arrives as raw
 *                        text in `content`:
 *                        `{"name":"file_list","parameters":{"path":"~/Projects"}}`
 *
 * So a parser that only reads `tool_calls` silently reports "the model made no
 * tool calls" for a model that demonstrably made one. `parseInlineToolCalls`
 * recovers the third shape; it is deliberately conservative and only lifts
 * JSON that actually looks like a tool call, so ordinary prose containing a
 * JSON blob is left alone.
 */

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Keys a model may use for the argument object, across the shapes above. */
const ARG_KEYS = ['arguments', 'parameters', 'params', 'args', 'input'] as const;
/** Keys a model may use for the tool name. */
const NAME_KEYS = ['name', 'tool', 'tool_name', 'function_name'] as const;

let inlineSeq = 0;

/** Arguments arrive as an object (Ollama/Anthropic) or a JSON string (OpenAI). */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Read one OpenAI-style `tool_calls` array. `arguments` may be a JSON string
 * (OpenAI, Ollama's `/v1`) or an object (Ollama's `/api/chat`).
 */
export function parseOpenAIToolCalls(raw: unknown, fallbackIndex = 0): ParsedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ParsedToolCall[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    // Ollama native nests under `function`; OpenAI nests under `function` too.
    const fn = (e.function && typeof e.function === 'object' ? e.function : e) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) return;
    const args = parseToolArguments(fn.arguments ?? fn.parameters ?? fn.input);
    const id = typeof e.id === 'string' && e.id ? e.id : `call_${name}_${fallbackIndex + i}`;
    calls.push({ id, name, arguments: args });
  });
  return calls;
}

/**
 * Anthropic returns tool calls as `content` blocks of type `tool_use`, and its
 * text can be spread across several blocks — concatenating only the first
 * block (as the old adapter did) dropped the rest of the answer.
 */
export function parseAnthropicContent(blocks: unknown): {
  content: string;
  toolCalls: ParsedToolCall[];
} {
  if (!Array.isArray(blocks)) return { content: '', toolCalls: [] };
  let content = '';
  const toolCalls: ParsedToolCall[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') content += b.text;
    else if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) continue;
      toolCalls.push({
        id: typeof b.id === 'string' && b.id ? b.id : `call_${name}_${toolCalls.length}`,
        name,
        arguments: parseToolArguments(b.input),
      });
    }
  }
  return { content, toolCalls };
}

/**
 * Is this parsed JSON a tool call? Requires a tool name AND an argument
 * container, which is what separates a tool call from any other JSON object.
 */
function toolCallFromObject(obj: unknown): ParsedToolCall | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  // OpenAI occasionally nests one more level: {"function": {"name", "arguments"}}
  const target = (o.function && typeof o.function === 'object' && !Array.isArray(o.function)
    ? o.function
    : o) as Record<string, unknown>;
  let name = '';
  for (const key of NAME_KEYS) {
    if (typeof target[key] === 'string' && (target[key] as string).trim()) {
      name = (target[key] as string).trim();
      break;
    }
  }
  if (!name) return undefined;
  let args: Record<string, unknown> = {};
  for (const key of ARG_KEYS) {
    if (key in target) {
      args = parseToolArguments(target[key]);
      break;
    }
  }
  // No argument key at all is still a valid zero-arg call — but only when the
  // object carries nothing else that marks it as ordinary data.
  if (!(ARG_KEYS.some((k) => k in target)) && Object.keys(target).length > 1) return undefined;
  return { id: `call_inline_${++inlineSeq}_${name}`, name, arguments: args };
}

/**
 * Where a piece of text came from. Mining free text for a tool call is only
 * ever safe on text the MODEL AUTHORED.
 *
 * It is not safe on anything the model merely read: a `web_fetch_page` result,
 * an email body, a file on disk. A page containing
 * `{"name":"run_shell","arguments":{"command":"..."}}` would otherwise become
 * an executed command — a retrieved-content prompt-injection execution path
 * that bypasses every safety tier Henry has, because the tool would arrive as
 * a legitimate model decision.
 *
 * The parameter is required and narrow on purpose: a caller cannot reach this
 * function without stating which kind of text it holds.
 */
export type ToolCallTextSource = 'model-output';

/**
 * Pull tool calls out of free text. Handles the three shapes seen live:
 * the whole message is one JSON object, a ```json fenced block, or a JSON
 * object embedded in surrounding prose. The lifted text is removed from the
 * content so the user does not see raw JSON as the assistant's reply.
 *
 * `source` must be 'model-output'. Anything else returns the text untouched
 * with no tool calls, so a future caller reaching for this on retrieved
 * content gets a no-op rather than an execution path.
 */
export function parseInlineToolCalls(
  text: string,
  source: ToolCallTextSource
): {
  content: string;
  toolCalls: ParsedToolCall[];
} {
  if (source !== 'model-output') return { content: text ?? '', toolCalls: [] };
  if (!text || !text.includes('{')) return { content: text ?? '', toolCalls: [] };

  // `span` is the exact text to remove from the reply; `json` is what to parse.
  // They differ for a fenced block, where the backticks must go too.
  const candidates: Array<{ span: string; json: string }> = [];
  const trimmed = text.trim();
  candidates.push({ span: trimmed, json: trimmed });
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push({ span: match[0], json: match[1].trim() });
  }

  // Balanced-brace scan: an object embedded in prose.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const span = text.slice(start, i + 1);
        candidates.push({ span, json: span });
        start = -1;
      }
    }
  }

  const toolCalls: ParsedToolCall[] = [];
  const consumed: string[] = [];
  // The three candidate sources overlap by design: a message that is one JSON
  // object is also found by the brace scan, and every object inside an array
  // is found again by it. Lifting the same call twice would run the tool twice
  // for one decision, so a span already covered by a lifted span is skipped.
  for (const candidate of candidates) {
    if (consumed.some((span) => span.includes(candidate.span))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.json) as unknown;
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    let matched = false;
    for (const item of list) {
      const call = toolCallFromObject(item);
      if (call) {
        toolCalls.push(call);
        matched = true;
      }
    }
    if (matched) consumed.push(candidate.span);
  }

  if (toolCalls.length === 0) return { content: text, toolCalls: [] };

  let content = text;
  for (const span of [...consumed].sort((a, b) => b.length - a.length)) {
    content = content.split(span).join('');
  }
  return { content: content.trim(), toolCalls };
}