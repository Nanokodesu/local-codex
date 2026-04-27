const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const STREAM_PROGRESS = process.env.CODEX_STREAM_PROGRESS !== "false";
const STREAM_CODEX_EVENTS = process.env.CODEX_STREAM_EVENTS !== "false";
const STREAM_COMMAND_OUTPUT = process.env.CODEX_STREAM_COMMAND_OUTPUT !== "false";
const SKILLS_DIR = process.env.CODEX_SKILLS_DIR || path.join(process.cwd(), "skills");
const MAX_MATCHED_SKILLS = Number(process.env.CODEX_MAX_MATCHED_SKILLS || 3);
const UTF8_ENV = {
  LANG: process.env.LANG || "C.UTF-8",
  LC_ALL: process.env.LC_ALL || "C.UTF-8",
  PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
  PYTHONUTF8: process.env.PYTHONUTF8 || "1",
  npm_config_unicode: process.env.npm_config_unicode || "true",
};

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const MODELS = [
  "codex",
  "gpt-5-codex",
  "gpt-5.1-codex",
  "gpt-4.1",
  "gpt-4o",
];

app.get([/^\/.*models$/], (req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "openai",
      permission: [],
      root: id,
      parent: null,
    })),
  });
});

app.get([/^\/.*models\/([^/]+)$/], (req, res) => {
  const id = req.params[0] || "codex";
  res.json({
    id,
    object: "model",
    created: 0,
    owned_by: "openai",
    permission: [],
    root: id,
    parent: null,
  });
});

app.get(["/", "/health"], (req, res) => {
  res.json({
    ok: true,
    service: "codex-bridge",
    endpoints: ["/v1/chat/completions", "/codex"],
  });
});

app.post("/codex", async (req, res) => {
  const rawPrompt = normalizeContent(req.body.prompt);
  if (!rawPrompt.trim()) {
    return res.status(400).json({ error: "Missing prompt" });
  }
  const prompt = buildPrompt([{ role: "user", content: rawPrompt }], req.body.tools);

  const workdir = resolveWorkdir(req.body);
  if (!workdir.ok) {
    return res.status(400).json({ error: workdir.error });
  }

  const wantsStream = req.body.stream === true;
  const responseId = makeId("codex");
  const model = req.body.model || "codex";

  if (wantsStream) {
    startSse(res);
  }

  let output = "";
  try {
    await runCodex({
      prompt,
      cwd: workdir.path,
      onText: (text, options = {}) => {
        if (options.includeInFinal !== false) output += text;
        if (wantsStream) sendChatChunk(res, responseId, model, text);
      },
      onDebug: (text) => {
        if (wantsStream && STREAM_CODEX_EVENTS) sendChatChunk(res, responseId, model, text);
      },
      onProgress: (text) => {
        if (wantsStream && STREAM_PROGRESS) sendChatChunk(res, responseId, model, text);
      },
      signalClose: res,
    });

    if (wantsStream) {
      sendDone(res, responseId, model);
    } else {
      res.json({ output: output.trim() });
    }
  } catch (error) {
    if (wantsStream) {
      sendChatChunk(res, responseId, model, `\n[Error] ${error.message}\n`);
      sendDone(res, responseId, model);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post([/^\/.*chat\/completions$/, /^\/v1$/], async (req, res) => {
  const { messages, stream, tools } = req.body;
  const wantsStream = stream === true;
  const model = req.body.model || "codex";
  const responseId = makeId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);

  if (!Array.isArray(messages)) {
    return res.status(400).json({
      error: {
        message: "Invalid messages array",
        type: "invalid_request_error",
      },
    });
  }

  const workdir = resolveWorkdir(req.body);
  if (!workdir.ok) {
    return res.status(400).json({
      error: {
        message: workdir.error,
        type: "invalid_request_error",
      },
    });
  }

  const prompt = buildPrompt(messages, tools);
  if (!prompt.trim()) {
    return res.status(400).json({
      error: {
        message: "No prompt content found",
        type: "invalid_request_error",
      },
    });
  }

  if (wantsStream) {
    startSse(res);
  }

  let finalContent = "";
  let usage = null;

  try {
    await runCodex({
      prompt,
      cwd: workdir.path,
      onUsage: (nextUsage) => {
        usage = nextUsage;
      },
      onText: (text, options = {}) => {
        if (options.includeInFinal !== false) finalContent += text;
        if (wantsStream) sendChatChunk(res, responseId, model, text, created);
      },
      onDebug: (text) => {
        if (wantsStream && STREAM_CODEX_EVENTS) sendChatChunk(res, responseId, model, text, created);
      },
      onProgress: (text) => {
        if (wantsStream && STREAM_PROGRESS) sendChatChunk(res, responseId, model, text, created);
      },
      signalClose: res,
    });

    if (wantsStream) {
      sendDone(res, responseId, model, created);
      return;
    }

    res.json({
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: finalContent.trim(),
          },
          finish_reason: "stop",
        },
      ],
      usage: normalizeUsage(usage),
    });
  } catch (error) {
    console.error("[OpenAI endpoint] Codex execution failed:", error);

    if (wantsStream) {
      sendDone(res, responseId, model, created);
      return;
    }

    res.status(500).json({
      error: {
        message: error.message,
        type: "server_error",
      },
    });
  }
});

app.use((err, req, res, next) => {
  if (!err) return next();

  console.error("[request error]", err);
  res.status(err.status || 500).json({
    error: {
      message: err.message || "Internal Server Error",
      type: err.type || "server_error",
    },
  });
});

app.use((req, res) => {
  console.log(`[404 Not Found] ${req.method} ${req.url}`);
  res.status(404).json({
    error: {
      message: `Not Found: ${req.url}`,
      type: "invalid_request_error",
    },
  });
});

const server = app.listen(PORT, () => {
  console.log(`Codex bridge running at http://localhost:${PORT}`);
  console.log(`OpenAI compatible endpoint available at http://localhost:${PORT}/v1/chat/completions`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;

function runCodex({ prompt, cwd, onText, onDebug, onProgress, onUsage, signalClose }) {
  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
    ];

    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }

    args.push("-");

    console.log(`[codex] ${CODEX_BIN} ${args.join(" ")} (cwd: ${cwd})`);

    const cleanEnv = {
      PATH: process.env.PATH,
      HTTP_PROXY: process.env.HTTP_PROXY || "http://127.0.0.1:7897",
      HTTPS_PROXY: process.env.HTTPS_PROXY || "http://127.0.0.1:7897",
      http_proxy: process.env.http_proxy || "http://127.0.0.1:7897",
      https_proxy: process.env.https_proxy || "http://127.0.0.1:7897",
      ALL_PROXY: process.env.ALL_PROXY,
      all_proxy: process.env.all_proxy,
    };

    const child = spawn(CODEX_BIN, args, {
      cwd,
      shell: process.platform === "win32",
      env: Object.assign({}, process.env, cleanEnv, UTF8_ENV, { NO_COLOR: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const commandStates = new Map();
    const progressState = {
      commandStarted: false,
      finalStarted: false,
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const cleanup = () => {
      if (signalClose) {
        signalClose.off?.("close", abortHandler);
        signalClose.off?.("aborted", abortHandler);
      }
    };

    const abortHandler = () => {
      if (settled) return;
      console.log("[codex] request closed; stopping child process");
      child.kill();
    };

    if (signalClose) {
      signalClose.on?.("close", abortHandler);
      signalClose.on?.("aborted", abortHandler);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      stdoutBuffer = consumeLines(stdoutBuffer, (line) => {
        if (!line.trim()) return;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          console.log(`[codex stdout] ${line}`);
          return;
        }

        handleCodexEvent(event, {
          onText,
          onDebug,
          onProgress,
          onUsage,
          commandStates,
          progressState,
        });
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      stderrBuffer = consumeLines(stderrBuffer, (line) => {
        const clean = stripAnsi(line).trim();
        if (!clean) return;
        console.warn(`[codex stderr] ${clean}`);
      });
    });

    child.on("error", (error) => {
      finish(reject, new Error(`Failed to start Codex CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim());
          handleCodexEvent(event, {
            onText,
            onDebug,
            onProgress,
            onUsage,
            commandStates,
            progressState,
          });
        } catch {
          console.log(`[codex stdout tail] ${stdoutBuffer.trim()}`);
        }
      }

      if (code !== 0) {
        const detail = stripAnsi(stderrBuffer).trim();
        finish(reject, new Error(`Codex exited with code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }

      finish(resolve);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function handleCodexEvent(event, { onText, onDebug, onProgress, onUsage, commandStates, progressState }) {
  if (event.type === "turn.completed") {
    onUsage?.(event.usage);
    return;
  }

  const item = event.item;
  if (!item) return;

  if (item.type === "agent_message") {
    const state = commandStates.get(item.id) || { lastLength: 0 };
    const fullText = normalizeContent(item.text || item.content || "");
    const delta = fullText.slice(state.lastLength);
    
    if (delta) {
      onText(delta, { includeInFinal: true });
      state.lastLength = fullText.length;
      commandStates.set(item.id, state);
    }

    if (event.type === "item.completed") {
      onText("\n", { includeInFinal: true });
      commandStates.delete(item.id);
    }
    return;
  }

  if (item.type === "command_execution") {
    handleCommandEvent(event, item, { onDebug, onProgress, commandStates, progressState });
    return;
  }
}

function handleCommandEvent(event, item, { onDebug, onProgress, commandStates, progressState }) {
  if (event.type === "item.started") {
    if (!STREAM_CODEX_EVENTS) return;

    const cmd = formatCommand(item.command || "");
    commandStates.set(item.id, { outputLength: 0, blockOpen: true });
    onDebug?.(`\n> **>_** \`${cmd}\`\n> <details><summary>点击展开执行输出</summary>\n>\n> \`\`\`text\n> `);
    return;
  }

  if (!STREAM_CODEX_EVENTS) return;

  const state = commandStates.get(item.id) || { outputLength: 0, blockOpen: false };

  if (STREAM_COMMAND_OUTPUT && typeof item.aggregated_output === "string") {
    const oldLength = state.outputLength || 0;
    const nextOutput = item.aggregated_output.slice(oldLength);
    
    if (nextOutput) {
      onDebug?.(nextOutput.replace(/\n/g, '\n> '));
    }
    
    state.outputLength = item.aggregated_output.length;
    commandStates.set(item.id, state);
  }

  if (event.type === "item.completed") {
    const exitCode = item.exit_code ?? "unknown";
    const closeBlock = state.blockOpen ? "\n> ```\n>\n> </details>\n\n" : "";
    const isSuccess = exitCode === 0 || exitCode === "0";
    
    const status = isSuccess ? "\n" : `> ❌ **执行失败 (Exit Code: ${exitCode})**\n\n`;
    onDebug?.(`${closeBlock}${status}`);
    commandStates.delete(item.id);
  }
}

function formatCommand(command) {
  let cmd = command;
  if (cmd.includes("powershell.exe")) {
    const match = cmd.match(/-Command\s+"([^"]+)"/);
    if (match) cmd = match[1];
  }

  return cmd.length > 120 ? `${cmd.substring(0, 117)}...` : cmd;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function startSse(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");
}

function sendChatChunk(res, id, model, text, created = Math.floor(Date.now() / 1000)) {
  if (!text || res.writableEnded) return;

  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          content: text,
        },
        finish_reason: null,
      },
    ],
  };

  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sendDone(res, id, model, created = Math.floor(Date.now() / 1000)) {
  if (res.writableEnded) return;

  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };

  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildPrompt(messages, tools = []) {
  const normalized = messages
    .map((message) => ({
      role: message.role || "user",
      content: normalizeContent(message.content),
    }))
    .filter((message) => message.content.trim());

  const userIntent = normalized
    .filter((message) => message.role !== "assistant")
    .map((message) => message.content)
    .join("\n\n");
  const skills = loadSkills();
  const matchedSkills = matchSkills(userIntent, skills);
  const skillPrompt = buildSkillsPrompt(skills, matchedSkills);

  let clientToolsPrompt = "";
  if (Array.isArray(tools) && tools.length > 0) {
    clientToolsPrompt = `
[Client Native Tools/Skills]
The client environment (Work Buddy) has provided the following native tools (OpenAI format) that you can invoke. 
You SHOULD proactively use these tools when they are relevant to the user's request.
Because you are running through a text-based proxy, to invoke a tool, you should output a clear JSON function call block in your response, or follow whatever syntax the client usually expects for tool invocation.
\`\`\`json
${JSON.stringify(tools, null, 2)}
\`\`\`
`;
  }

  // Load persistent agent memory if it exists
  let agentMemoryPrompt = "";
  const memoryPath = path.join(process.cwd(), ".agent_memory.json");
  if (fs.existsSync(memoryPath)) {
    try {
      const memoryData = fs.readFileSync(memoryPath, "utf8");
      agentMemoryPrompt = `\n[Agent Persistent Memory]\nHere is your remembered context from previous sessions:\n\`\`\`json\n${memoryData}\n\`\`\`\nUse this memory to maintain context and avoid repeating mistakes or asking for the same information twice.\n`;
    } catch (err) {
      console.error("[Codex Bridge] Failed to read agent memory:", err.message);
    }
  }

  const systemPrompt = `[System Instructions]
You are a highly capable AI Agent, an elite autonomous developer. You MUST use the following specific Markdown structures to simulate a native Agent UI experience for the user.

1. AUTONOMY & SELF-CORRECTION (Agent Protocol):
   - You are proactive. Do not stop at partial fixes. Carry changes through implementation, testing, and refinement without waiting for the user.
   - If a command fails, DO NOT immediately ask the user for help. Read the error, analyze it, and try at least 2 different approaches to fix it yourself before giving up.
   - You have permission to create, modify, and delete files to achieve the user's goal.

2. SEAMLESS ONLINE RESEARCH & CREATIVITY:
   - Integrate online research seamlessly with your local analysis and creative problem-solving.
   - Only perform internet searches when the task genuinely requires up-to-date facts, external APIs, specific documentation, or troubleshooting unknown errors.
   - When you do use online research, you MUST explicitly list all the URLs you visited or referenced in a separate section using this exact format:
**🌐 搜索来源**
- [Title](URL)
- [Title](URL)

3. THINKING PROCESS (Chain of Thought): Always wrap your reasoning in this exact format before taking action:
**🤔 深度思考**
(1. Analyze the request... 2. Plan the steps... 3. Anticipate edge cases...)

4. PROGRESS TRACKING: When updating task status, use this exact format:
**✅ 进度更新**
- [x] (Completed task)
- [ ] (Pending task)

5. FILE OPERATIONS: After you modify, create, or read a file, explicitly state the result using one of these formats:
📄 \`filename.ext\` *(已修改)* **+n -m** (n = lines added, m = lines removed)
❌ \`filename.ext\` *(修改失败)*
👁️ \`filename.ext\` *(已读取)*

6. CONCISE CODE CHANGES: For large code modifications, DO NOT output the full file content in your conversation response. Instead, use a "SEARCH/REPLACE" style diff or a unified diff format to show only what changed. This makes it much easier for the user to review.
   Example:
   \`\`\`diff
   - (old code line)
   + (new code line)
   \`\`\`

7. AVOID MASSIVE TEXT OUTPUTS:
   - NEVER output massive raw arrays, JSON data, long file contents, or unformatted data dumps directly into the chat response.
   - If you extract or process a large amount of data, DO NOT print it all. Instead, print a short preview (e.g., first 2-3 items) and summarize the rest, or save the full result to a local file and provide the user with the file path.
   - Do not use HTML <details> tags for massive data as it may break the UI. Simply truncate the output and tell the user it has been truncated or saved.

8. NATURAL LANGUAGE: Explain what you are about to do in normal text before running commands.

9. ENCODING: Avoid Chinese text mojibake. When creating or modifying scripts, source files, JSON, Markdown, batch files, or PowerShell files that contain Chinese text, save them as UTF-8. On Windows, prefer explicit encoding flags such as PowerShell \`-Encoding utf8\`, Node.js \`fs.writeFileSync(path, content, "utf8")\`, and Python \`open(path, "w", encoding="utf-8")\`. Before running PowerShell commands that print Chinese text, set \`$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\`.

Rule: Always respond in Chinese. Strictly maintain these Markdown prefixes (📄, ✅, etc.) so the frontend can render them beautifully. Use concise diffs for large changes.
${agentMemoryPrompt}${skillPrompt}${clientToolsPrompt}`;

  if (normalized.length === 1 && normalized[0].role === "user") {
    return `${systemPrompt}\n\nUSER:\n${normalized[0].content}`;
  }

  return [
    systemPrompt,
    "---",
    "CONVERSATION HISTORY:",
    ...normalized.map((message) => `${message.role.toUpperCase()}:\n${message.content}`),
  ].join("\n\n");
}

function loadSkills() {
  const dirsToScan = [
    SKILLS_DIR,
    path.join(os.homedir(), ".workbuddy", "skills-marketplace", "skills"),
  ];

  const allSkills = [];

  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const filePath = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, "utf8");
        return parseSkill(entry.name, filePath, content);
      })
      .filter(Boolean);

    allSkills.push(...entries);
  }

  return allSkills;
}

function parseSkill(directoryName, filePath, content) {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const name = sanitizeSkillName(titleMatch?.[1] || directoryName);
  const description = extractSection(content, ["description", "描述", "说明"]) || "";
  const triggersText = extractSection(content, ["triggers", "trigger", "触发条件", "触发词"]) || "";
  const triggers = triggersText
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  return {
    name,
    path: filePath,
    description: description.trim(),
    triggers,
    content: content.trim(),
  };
}

function matchSkills(userIntent, skills) {
  const text = normalizeMatchText(userIntent);
  return skills
    .map((skill) => {
      let score = 0;
      const name = normalizeMatchText(skill.name);

      if (name && text.includes(name)) score += 10;
      for (const trigger of skill.triggers) {
        const normalizedTrigger = normalizeMatchText(trigger);
        if (normalizedTrigger && text.includes(normalizedTrigger)) score += 6;
      }

      for (const keyword of extractKeywords(`${skill.name}\n${skill.description}`)) {
        if (text.includes(keyword)) score += 1;
      }

      return { skill, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_SKILLS)
    .map((item) => item.skill);
}

function buildSkillsPrompt(skills, matchedSkills) {
  if (!skills.length) {
    return `

## Skills
No local skills were found. Local skills can be added under: ${SKILLS_DIR} or ~/.workbuddy/skills-marketplace/skills`;
  }

  const index = skills
    .map((skill) => `- ${skill.name}: ${skill.description || "无描述"}`)
    .join("\n");

  const selected = matchedSkills.length
    ? matchedSkills
        .map((skill) => `### ${skill.name}\nSource: ${skill.path}\n\n${skill.content}`)
        .join("\n\n---\n\n")
    : "No skill matched automatically for this request.";

  return `

## Skills
Before answering, inspect the user's request and decide whether a local skill applies.
If one or more skills apply, explicitly say which skill you are using in the 执行反馈 section, then follow the full skill instructions.
Do not invent unavailable skills.

Available skills:
${index}

Matched skill instructions:
${selected}`;
}

function extractSection(content, headings) {
  const escaped = headings.map((heading) => escapeRegExp(heading)).join("|");
  const pattern = new RegExp(`^##\\s*(?:${escaped})\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "im");
  return content.match(pattern)?.[1] || "";
}

function extractKeywords(text) {
  return normalizeMatchText(text)
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

function normalizeMatchText(text) {
  return String(text || "").toLowerCase();
}

function sanitizeSkillName(name) {
  return String(name || "").trim().replace(/\s+/g, "-");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.type === "input_text") return part.text || "";
        if (part?.text) return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function resolveWorkdir(body = {}) {
  const candidate =
    body.cwd ||
    body.workdir ||
    body.metadata?.cwd ||
    body.metadata?.workdir ||
    DEFAULT_WORKDIR;

  const resolved = path.resolve(String(candidate));
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Working directory does not exist: ${resolved}` };
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `Working directory is not a directory: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

function consumeLines(buffer, onLine) {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() || "";
  for (const line of lines) onLine(line);
  return rest;
}

function stripAnsi(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function ensureTrailingBlankLine(text) {
  return text.endsWith("\n") ? text : `${text}\n\n`;
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 11)}`;
}

function normalizeUsage(usage) {
  if (!usage) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
  }

  const promptTokens = usage.input_tokens || 0;
  const completionTokens = usage.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}
