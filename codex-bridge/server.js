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
const STREAM_COMMAND_OUTPUT = process.env.CODEX_STREAM_COMMAND_OUTPUT === "true";
const TERMINAL_COMMAND_OUTPUT_PREVIEW = Number(process.env.CODEX_TERMINAL_COMMAND_OUTPUT_PREVIEW || 2000);
const COMMAND_PROGRESS_HEARTBEAT_MS = Number(process.env.CODEX_COMMAND_PROGRESS_HEARTBEAT_MS || 8000);
const MAX_NATURAL_TEXT_CHUNK = Number(process.env.CODEX_MAX_NATURAL_TEXT_CHUNK || 120);
const SKILLS_DIR = process.env.CODEX_SKILLS_DIR || path.join(process.cwd(), "skills");
const MAX_MATCHED_SKILLS = Number(process.env.CODEX_MAX_MATCHED_SKILLS || 3);
const ATTACHMENTS_DIR = process.env.CODEX_ATTACHMENTS_DIR || path.join(os.tmpdir(), "codex-bridge-attachments");
const OBSIDIAN_VAULT = "e:/321/nano";

const UTF8_ENV = {
  LANG: process.env.LANG || "C.UTF-8",
  LC_ALL: process.env.LC_ALL || "C.UTF-8",
  PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
  PYTHONUTF8: process.env.PYTHONUTF8 || "1",
  LESSCHARSET: process.env.LESSCHARSET || "utf-8",
  npm_config_unicode: process.env.npm_config_unicode || "true",
};
const WINDOWS_UTF8_ENV = process.platform === "win32" ? {
  DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: process.env.DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION || "1",
  POWERSHELL_TELEMETRY_OPTOUT: process.env.POWERSHELL_TELEMETRY_OPTOUT || "1",
  PYTHONLEGACYWINDOWSSTDIO: process.env.PYTHONLEGACYWINDOWSSTDIO || "0",
} : {};

process.stdout.setDefaultEncoding?.("utf8");
process.stderr.setDefaultEncoding?.("utf8");

app.use(cors());
app.use((req, res, next) => {
  res.charset = "utf-8";
  next();
});
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
  "gpt-5.5",
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

function handleProgress(res, text, { progressSteps, model, responseId, created }) {
  if (!text) return;

  let clean = text
    .replace(/\*\*✅ 进度更新\*\*/g, "")
    .replace(/\*\*✅ 任务完成总结\*\*/g, "")
    .replace(/\*\*⏳ 运行状态\*\*/g, "")
    .replace(/\*\*⏳ 正在处理\*\*/g, "")
    .replace(/^- \[[ x]\] /g, "")
    .replace(/，详细过程见服务端终端。?/, "")
    .trim();

  if (!clean) return;

  let segments = clean.split(/\n+/).filter(s => s.trim().length > 0);
  
  if (segments.length === 1 && clean.length > 40) {
    segments = clean.split(/([。；！!？?])\s*/).reduce((acc, part, i) => {
      if (i % 2 === 0) acc.push(part);
      else if (acc.length > 0) acc[acc.length - 1] += part;
      return acc;
    }, []).filter(s => s.trim().length > 0);
  }
  
  for (const segment of segments) {
    const trimmed = segment.replace(/\s+/g, " ").trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (progressSteps.includes(trimmed)) continue;
    if (progressSteps.some((step) => step.includes(trimmed))) continue;

    const previousPrefix = progressSteps.find((step) => trimmed.startsWith(step));
    const next = previousPrefix ? trimmed.slice(previousPrefix.length).trim() : trimmed;
    if (!next || next.length < 2 || progressSteps.includes(next)) continue;

    progressSteps.push(next);
    const delta = `\n\n> ⏳ ${next}\n\n`;
    sendChatChunk(res, responseId, model, delta, created, true);
  }
}

app.post("/codex", async (req, res) => {
  const rawPrompt = normalizeMessageContent({
    content: req.body.prompt,
    attachments: req.body.attachments,
    files: req.body.files,
    images: req.body.images,
    items: req.body.items,
  });
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
  // 优先使用后端环境变量定义的模型，实现后端自主控制
  const model = CODEX_MODEL || req.body.model || "codex";
  const progressSteps = [];

  if (wantsStream) {
    startSse(res);
  }

  let output = "";
  let pendingDebug = "";
  try {
    await runCodex({
      prompt,
      model,
      cwd: workdir.path,
      onText: (text, options = {}) => {
          if (options.includeInFinal !== false) output += text;
          if (!wantsStream) return;

          // 自动刷新逻辑：如果缓冲区有推理内容，且当前正文出现了换行符（段落结束）
          // 或者正文显式包含了 [Thinking] 触发词
          const shouldFlush = pendingDebug && (text.includes("\n") || text.includes("[Thinking]"));
          
           if (shouldFlush) {
             if (text.includes("[Thinking]")) {
              const parts = text.split("[Thinking]");
              // 发送触发词前的部分
              if (parts[0]) sendContentChunk(res, responseId, model, parts[0]);
              // 注入推理内容
              sendChatChunk(res, responseId, model, pendingDebug, Math.floor(Date.now() / 1000), true);
              pendingDebug = "";
              // 发送触发词后的部分
              if (parts[1]) sendContentChunk(res, responseId, model, parts[1]);
            } else {
              // 遇到换行自动注入
              sendChatChunk(res, responseId, model, pendingDebug, Math.floor(Date.now() / 1000), true);
              pendingDebug = "";
              sendContentChunk(res, responseId, model, text);
            }
          } else {
            sendContentChunk(res, responseId, model, text);
          }
        },
      onDebug: (text) => {
        if (wantsStream && STREAM_CODEX_EVENTS) {
          pendingDebug += text;
        }
      },
      onProgress: (text) => {
        if (wantsStream && STREAM_PROGRESS) {
          handleProgress(res, text, {
            progressSteps,
            model,
            responseId,
            created: Math.floor(Date.now() / 1000)
          });
        }
      },
      signalClose: res,
    });

    if (wantsStream) {
      if (pendingDebug) {
        sendChatChunk(res, responseId, model, pendingDebug, Math.floor(Date.now() / 1000), true);
      }
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
  // 优先使用后端环境变量定义的模型，实现后端自主控制
  const model = CODEX_MODEL || req.body.model || "codex";
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

  const prompt = buildPrompt(mergeRequestAttachments(messages, req.body), tools);
  if (!prompt.trim()) {
    return res.status(400).json({
      error: {
        message: "No prompt content found",
        type: "invalid_request_error",
      },
    });
  }

  const progressSteps = [];

  if (wantsStream) {
    startSse(res);
  }

  let finalContent = "";
  let usage = null;
  let pendingDebug = "";

  try {
    await runCodex({
      prompt,
      model,
      cwd: workdir.path,
      onUsage: (nextUsage) => {
        usage = nextUsage;
      },
      onText: (text, options = {}) => {
        if (options.includeInFinal !== false) finalContent += text;
        if (!wantsStream) return;

        // 自动刷新逻辑：如果缓冲区有推理内容，且当前正文出现了换行符（段落结束）
        // 或者正文显式包含了 [Thinking] 触发词
        const shouldFlush = pendingDebug && (text.includes("\n") || text.includes("[Thinking]"));
        
        if (shouldFlush) {
          if (text.includes("[Thinking]")) {
            const parts = text.split("[Thinking]");
            if (parts[0]) sendContentChunk(res, responseId, model, parts[0], created);
            sendChatChunk(res, responseId, model, pendingDebug, created, true);
            pendingDebug = "";
            if (parts[1]) sendContentChunk(res, responseId, model, parts[1], created);
          } else {
            // 遇到换行自动注入推理内容
            sendChatChunk(res, responseId, model, pendingDebug, created, true);
            pendingDebug = "";
            sendContentChunk(res, responseId, model, text, created);
          }
        } else {
          sendContentChunk(res, responseId, model, text, created);
        }
      },
      onDebug: (text) => {
        if (wantsStream && STREAM_CODEX_EVENTS) {
          pendingDebug += text;
        }
      },
      onProgress: (text) => {
        if (wantsStream && STREAM_PROGRESS) {
          handleProgress(res, text, { 
            progressSteps, 
            model, 
            responseId, 
            created 
          });
        }
      },
      signalClose: res,
    });

    if (wantsStream) {
      // 发送剩余的调试信息（如果有）
      if (pendingDebug) {
        sendChatChunk(res, responseId, model, pendingDebug, created, true);
      }
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

function runCodex({ prompt, model, cwd, onText, onDebug, onProgress, onUsage, signalClose }) {
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

    // 优先且仅使用后端定义的 CODEX_MODEL。
    // 如果 CODEX_MODEL 为空，则不传递 -m 参数，让 codex CLI 使用其内部配置的默认模型。
    // 这样可以完全忽略前端传来的模型选择。
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
      env: Object.assign({}, process.env, cleanEnv, UTF8_ENV, WINDOWS_UTF8_ENV, { NO_COLOR: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const commandStates = new Map();

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
      clearCommandTimers(commandStates);
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
          });
        } catch {
          console.log(`[codex stdout tail] ${stdoutBuffer.trim()}`);
        }
      }

      if (code !== 0) {
        const detail = stripAnsi(stderrBuffer).trim();
        let errorMessage = `Codex exited with code ${code}`;
        
        if (detail.includes("401 Unauthorized") || detail.includes("token_revoked") || detail.includes("refresh_token_reused")) {
          errorMessage = "身份验证过期 (401 Unauthorized)。请在终端运行 `codex login` 重新登录。";
        } else if (detail) {
          // 提取最后几行关键错误
          const lines = detail.split('\n');
          const lastError = lines.reverse().find(l => l.includes("ERROR") || l.includes("Error"));
          errorMessage += lastError ? `: ${lastError}` : `: ${detail.slice(-200)}`;
        }
        
        finish(reject, new Error(errorMessage));
        return;
      }

      finish(resolve);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function handleCodexEvent(event, { onText, onDebug, onProgress, onUsage, commandStates }) {
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
    handleCommandEvent(event, item, { onProgress, commandStates });
    return;
  }
}

function clearCommandTimers(commandStates) {
  for (const state of commandStates.values()) {
    if (state?.timer) clearInterval(state.timer);
  }
}

function handleCommandEvent(event, item, { onProgress, commandStates }) {
  if (event.type === "item.started") {
    if (!STREAM_CODEX_EVENTS) return;

    const cmd = formatCommand(item.command || "");
    const summary = summarizeCommand(cmd);
    const startedAt = Date.now();
    const state = { 
      outputLength: 0, 
      command: cmd,
      summary,
      truncated: false,
      displayedLength: 0,
      startedAt,
      lastProgressAt: startedAt,
      timer: null,
    };
    if (COMMAND_PROGRESS_HEARTBEAT_MS > 0) {
      state.timer = setInterval(() => {
        const latest = commandStates.get(item.id);
        if (!latest) return;
        const elapsed = formatDuration(Date.now() - latest.startedAt);
        onProgress?.(`${latest.summary}进行中，已用${elapsed}。`);
      }, COMMAND_PROGRESS_HEARTBEAT_MS);
      state.timer.unref?.();
    }
    commandStates.set(item.id, state);
    console.log(`[codex command] started: ${cmd}`);
    onProgress?.(`${summary}：${describeCommandTarget(cmd)}`);
    return;
  }

  if (!STREAM_CODEX_EVENTS) return;

  const state = commandStates.get(item.id) || { outputLength: 0, command: "", summary: "正在执行本地命令", truncated: false, displayedLength: 0 };

  if (STREAM_COMMAND_OUTPUT && typeof item.aggregated_output === "string" && !state.truncated) {
    const oldLength = state.outputLength || 0;
    const nextOutput = item.aggregated_output.slice(oldLength);
    
    if (nextOutput) {
      if (state.displayedLength + nextOutput.length > TERMINAL_COMMAND_OUTPUT_PREVIEW) {
        const allowed = TERMINAL_COMMAND_OUTPUT_PREVIEW - state.displayedLength;
        if (allowed > 0) {
          const part = nextOutput.slice(0, allowed);
          console.log(`[codex command output] ${stripAnsi(part)}`);
          state.displayedLength += part.length;
        }
        console.log("[codex command output] ... truncated; full output remains in Codex event stream ...");
        state.truncated = true;
      } else {
        console.log(`[codex command output] ${stripAnsi(nextOutput)}`);
        state.displayedLength += nextOutput.length;
      }
    }
    
    state.outputLength = item.aggregated_output.length;
    const now = Date.now();
    if (now - (state.lastProgressAt || 0) >= Math.max(2000, COMMAND_PROGRESS_HEARTBEAT_MS / 2)) {
      state.lastProgressAt = now;
      onProgress?.(`${state.summary}收到新输出，当前约${state.outputLength}字符。`);
    }
    commandStates.set(item.id, state);
  }

  if (event.type === "item.completed") {
    const exitCode = item.exit_code ?? "unknown";
    const isSuccess = exitCode === 0 || exitCode === "0";
    const summary = state.summary || "本地命令";
    const subject = summary.replace(/^正在/, "");
    if (state.timer) clearInterval(state.timer);
    const elapsed = state.startedAt ? `，耗时${formatDuration(Date.now() - state.startedAt)}` : "";
    const status = isSuccess ? `${subject}已完成${elapsed}` : `${subject}失败，退出码：${exitCode}${elapsed}`;
    console.log(`[codex command] completed (${exitCode}): ${state.command || formatCommand(item.command || "")}`);
    onProgress?.(`${status}`);
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

function describeCommandTarget(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return "准备执行本地操作";

  const pathMatch =
    cmd.match(/(?:-Path|-LiteralPath|cwd)\s+["']?([^"'\s;|]+(?:\s[^"';|]+)?)["']?/i) ||
    cmd.match(/\b([A-Z]:\\[^;|"'`]+|\/[^;|"'`]+)\b/i);
  const target = pathMatch?.[1]?.trim();
  const suffix = target ? `目标${formatShortTarget(target)}` : "正在分析命令目标";
  return suffix;
}

function formatShortTarget(target) {
  const normalized = String(target || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 60) return `：${normalized}`;
  return `：...${normalized.slice(-57)}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function summarizeCommand(command) {
  const cmd = String(command || "").toLowerCase();

  if (cmd.includes("apply_patch")) return "正在修改项目文件";
  if (cmd.includes("node -c") || cmd.includes("npm run typecheck") || cmd.includes("tsc")) return "正在检查代码语法或类型";
  if (cmd.includes("npm test") || cmd.includes("pytest") || cmd.includes("vitest") || cmd.includes("jest")) return "正在运行测试";
  if (cmd.includes("npm run build") || cmd.includes("vite build") || cmd.includes("next build")) return "正在构建项目";
  if (cmd.includes("rg ") || cmd.includes("select-string") || cmd.includes("findstr")) return "正在搜索代码";
  if (cmd.includes("get-childitem") && (cmd.includes("-recurse") || cmd.includes("-filter") || cmd.includes("-include"))) return "正在扫描本地文件线索";
  if (cmd.includes("get-content") || cmd.includes("type ") || cmd.includes("cat ")) return "正在读取文件内容";
  if (cmd.includes("git diff") || cmd.includes("git status")) return "正在检查代码变更";
  if (cmd.includes("get-childitem") || cmd.includes(" ls ") || cmd.startsWith("ls ")) return "正在查看项目文件";

  return "正在执行本地命令";
}

function startSse(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");
}

function sendContentChunk(res, id, model, text, created = Math.floor(Date.now() / 1000)) {
  for (const part of splitNaturalTextForDisplay(text)) {
    sendChatChunk(res, id, model, part, created);
  }
}

function splitNaturalTextForDisplay(text) {
  const value = String(text || "");
  if (!value || value.length <= MAX_NATURAL_TEXT_CHUNK) return [value];
  if (value.includes("```") || value.includes("|") || /^\s*([-*]|\d+\.|#{1,6}\s)/m.test(value)) return [value];

  const parts = [];
  let buffer = "";
  for (const token of value.split(/([。！？!?；;]\s*)/)) {
    if (!token) continue;
    buffer += token;
    if (buffer.length >= MAX_NATURAL_TEXT_CHUNK && /[。！？!?；;]\s*$/.test(buffer)) {
      parts.push(`${buffer.trimEnd()}\n\n`);
      buffer = "";
    }
  }
  if (buffer) parts.push(buffer);
  return parts.length ? parts : [value];
}

function sendChatChunk(res, id, model, text, created = Math.floor(Date.now() / 1000), isReasoning = false) {
  if (!text || res.writableEnded) return;

  const delta = isReasoning ? { reasoning_content: text } : { content: text };

  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
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

let agentMemoryCache = { data: "", mtime: 0, lastScan: 0 };

function getAgentMemoryPrompt() {
  const memoryPath = path.join(process.cwd(), ".agent_memory.json");
  const now = Date.now();
  
  if (!fs.existsSync(memoryPath)) {
    agentMemoryCache.mtime = 0;
    agentMemoryCache.data = "";
    return "";
  }

  // Fast path TTL check
  if (now - agentMemoryCache.lastScan < 5000) {
    return agentMemoryCache.data;
  }

  const currentMtime = fs.statSync(memoryPath).mtimeMs;
  agentMemoryCache.lastScan = now;

  if (agentMemoryCache.mtime === currentMtime) {
    return agentMemoryCache.data;
  }

  let agentMemoryPrompt = "";
  try {
    const buffer = fs.readFileSync(memoryPath);
    let memoryData;
    try {
      const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
      memoryData = utf8Decoder.decode(buffer);
    } catch (e) {
      const gbkDecoder = new TextDecoder("gbk");
      memoryData = gbkDecoder.decode(buffer);
    }
    JSON.parse(memoryData);
    agentMemoryPrompt = `\n[Agent Persistent Memory]\nHere is your remembered context from previous sessions:\n\`\`\`json\n${memoryData}\n\`\`\`\nUse this memory to maintain context and avoid repeating mistakes or asking for the same information twice.\n`;
  } catch (err) {
    console.error("[Codex Bridge] Failed to read agent memory:", err.message);
  }

  agentMemoryCache.mtime = currentMtime;
  agentMemoryCache.data = agentMemoryPrompt;
  return agentMemoryPrompt;
}

function buildPrompt(messages, tools = []) {
  const normalized = messages
    .map((message) => ({
      role: message.role || "user",
      content: normalizeMessageContent(message),
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

  // Load persistent agent memory if it exists (now cached)
  let agentMemoryPrompt = getAgentMemoryPrompt();

  const systemPrompt = `[System Instructions]
You are a HIGHLY AUTONOMOUS ELITE DEVELOPER. You don't just follow instructions; you solve problems with extreme technical depth and creativity.

1. INTELLIGENCE-DRIVEN PROTOCOL (CRITICAL):
   - **Vault Definition**: When you refer to "仓库" (Vault) or repository in a general context, it refers to your Obsidian Vault located at \`e:/321/nano\`. The project path (\`e:/local codex/codex-bridge\`) is ONLY for system bridge files.
   - **Mandatory Investigation**: Before forming any plan or implementation, you MUST proactively gather intelligence. Use local search/read tools to understand the codebase AND web search to check documentation, best practices, or external context.
   - **Intelligence-First Planning**: Your "📋 任务规划" must be derived from actual findings in the local files and online research. Avoid guessing.
   - **Extreme Autonomy**: If a task is ambiguous, investigate the local context and technical docs to deduce the most reasonable path forward. Propose and implement elegant, modern, and high-performance solutions.

2. SEAMLESS ONLINE RESEARCH & CREATIVITY:
   - Integrate online research seamlessly with your local analysis. 
   - Default to doing a brief online check before answering or implementing, especially when facts, APIs, documentation, versions, or best practices might be relevant.
   - When you do use online research, you MUST explicitly list all the URLs you visited or referenced:
**🌐 搜索来源**
- [Title](URL)
- [Title](URL)

3. THINKING PROCESS (Chain of Thought):
**🤔 深度思考**
(1. Investigation Phase: What do I need to search locally/online to fully understand the context? 2. Analysis: What are the core findings and potential risks? 3. Creative Design: What is the most robust and elegant solution? 4. Verification Plan: How will I prove it works?)
   - **THINKING BLOCKS**: Your tool execution logs and background reasoning will automatically appear between paragraphs in the final response.
   - **EXPLICIT TRIGGER**: If you want to force the thinking block to appear at a specific location, use the \`[Thinking]\` tag.

4. PLANNING & PROGRESS:
   - At the VERY START of your response (immediately after Thinking), provide your intelligence-driven task list:
**📋 任务规划**
- [ ] (Investigation task)
- [ ] (Implementation task)
- [ ] (Verification/Testing task)
   - During your response, provide status updates in NATURAL LANGUAGE only.
   - Each status update must be its own short paragraph. Do not concatenate multiple updates into one long paragraph.
   - Keep every status update to 1-2 concise sentences. After each status update, insert a blank line before continuing.
   - When you have several actions or observations to report, split them into separate paragraphs instead of joining them with spaces or long comma chains.
   - For long-running searches, scans, builds, installs, or data processing, describe the visible work process incrementally: current scope, target file types or keywords, what has been found so far, and what the next stage will verify.
   - When exploring files, searches, or command output, do not wait until the end to explain progress; emit concise stage updates as the work advances.
   - DO NOT output the "✅ 进度更新" block yourself; the system will handle the real-time progress bar at the top of the message.
   - At the VERY END of your response, after all work is done, provide a comprehensive final summary including natural language descriptions, task checklists, and file change tables:
**✅ 任务完成总结**

**执行逻辑**
Use 2-3 concise natural-language sentences to explain what you changed, why this approach was chosen, and how it addresses the user's request.

**📋 执行明细**
- [x] (Completed Task 1)
- [x] (Completed Task 2)

**📄 变更明细**
| 文件路径 | 状态 | 变更 (Lines) | 核心改动说明 |
| :--- | :--- | :--- | :--- |
| \`path/to/file.ext\` | 已修改 | +n -m | 简要描述改动点 |
| \`another/file.ext\` | 已创建 | +x -0 | 新增功能说明 |

**验证与决策**
Summarize checks run, results, and important implementation decisions.

Keep a blank line before and after every heading and Markdown table. Never collapse the table into plain inline text.
If only one file changed, still render the Markdown table with pipes and the separator row.

5. FILE OPERATIONS: After you modify, create, or read a file, explicitly state the result using one of these formats:
📄 \`filename.ext\` *(已创建/已修改)* **+n -m** (n = lines added, m = lines removed)
❌ \`filename.ext\` *(修改失败)*
📖 \`filename.ext\` *(已读取)*

6. CONCISE CODE CHANGES: For large code modifications, DO NOT output the full file content in your conversation response. Instead, use a "SEARCH/REPLACE" style diff or a unified diff format to show only what changed. This makes it much easier for the user to review.
   Example:
   \`\`\`diff
   - (old code line)
   + (new code line)
   \`\`\`

7. AVOID MASSIVE TEXT OUTPUTS (CRITICAL RULE):
   - YOU MUST NEVER regurgitate, repeat, or copy-paste large blocks of text, file contents, grep results, or code into your conversational response.
   - **SMART TRUNCATION AWARENESS**: The terminal output bridge has a strict 2000-character display limit. If you run commands with huge output (e.g., \`cat\` a large file, \`npm install\`), the UI will truncate it. 
   - **PREFER SPECIFIC COMMANDS**: ALWAYS use specific commands to find information rather than dumping whole files. Use \`grep -C 5\`, \`head -n 50\`, \`tail -n 50\`, or \`sed\` to extract only the necessary lines.
   - If you search for files or read files, DO NOT print the contents you found in the chat. The user can already see the command output in the terminal block.
   - Instead of dumping text, provide a HIGH-LEVEL SUMMARY of what you found, or point the user to the file paths.
   - If you must show code, ONLY show the specific 2-3 lines that need changing using a diff format.
   - The UI DOES NOT support scrollable or collapsible blocks. YOU MUST keep your text output extremely concise.
   - VIOLATION OF THIS RULE WILL BREAK THE UI.

8. PROACTIVE DOCUMENTATION (MARKDOWN ARTIFACTS):
    - Like other native Work Buddy models, you MUST strongly prefer creating a Markdown (\`.md\`) file to present your final results, plans, summaries, or analyses, rather than outputting them entirely in the chat conversation.
    - When asked to analyze, plan, summarize, design, or provide a comprehensive report, ALWAYS create a new \`.md\` file in the workspace containing your detailed findings.
    - In your chat response, link to the file and provide a **CONCISE HIGH-LEVEL SUMMARY** (2-3 sentences) of the core conclusions or key takeaways at the end.
    - This keeps the chat interface clean while providing the user with a tangible, persistent artifact and immediate context.

9. NATURAL LANGUAGE: Explain what you are about to do in normal text before running commands.

10. CHANGE SCOPE CONTROL:
   - Treat the user's described problem as the boundary for code changes.
   - Make the smallest coherent change that solves the requested problem, following existing project patterns.
   - Do not opportunistically refactor, rename, reformat, reorganize, or "clean up" nearby code unless it is required for the requested fix.
   - If a broader cleanup or adjacent fix would be useful, list it in the final response as a recommendation and wait for explicit approval.
   - When editing shared files, preserve unrelated existing changes and avoid touching unrelated sections.

11. COMMAND VISIBILITY:
   - In the chat UI, describe ongoing actions in natural language only.
   - Keep exact commands, raw terminal output, stack traces, install logs, grep output, and long diagnostics in the terminal/tool output instead of repeating them in chat.
   - When a command matters, summarize its purpose and result; do not paste the command transcript.

12. WORK BUDDY ATTACHMENTS:
   - User-supplied images, files, local paths, URLs, mentions, and other structured input items may be normalized into the conversation as compact attachment lines.
   - When an attachment line contains a local path, use that path directly with local inspection tools instead of asking the user to upload it again.
   - When an attachment line says a data URL was saved, inspect the saved local file path.
   - Do not paste full file contents or binary data into chat; summarize what you inspected and cite the path.

13. COMPREHENSIVE FINAL SUMMARY:
   - You MUST NOT end any final response without a comprehensive and structured summary section titled "**✅ 任务完成总结**".
   - This section must provide a complete overview of the session, including:
     - **Execution Logic**: 2-3 sentences of natural language describing the approach and technical rationale.
     - **Action Checklist**: A list of all completed tasks from your "📋 任务规划".
     - **File Change Table**: A Markdown table listing all modified/created files with paths, status, line counts, and a brief description of the change.
     - **Verification & Decision**: Summary of verification results (e.g., syntax checks, test runs) and any major technical decisions made.
    - If no files were modified, explicitly state "未修改文件".
    - Use clear formatting (headers, tables, bullets) to ensure the summary is professional and exhaustive.
    - Markdown tables MUST include a header row, separator row, and one row per changed file. Put blank lines around the table so the UI renders it as a real table instead of one paragraph.
    - Do not emit the final summary as one dense paragraph. Each section must be separated by a blank line.
    - The final summary must be sent as normal assistant content, not as a progress update or reasoning-only content.
    - If a table would be too large, include the most relevant changed files and then add a short "其他" row; never convert the table into plain inline text.

14. ENCODING: Avoid Chinese text mojibake. When creating, modifying, reading, or printing scripts, source files, JSON, Markdown, batch files, or PowerShell files that contain Chinese text, use UTF-8 explicitly. On Windows PowerShell, prefix commands that may read or print Chinese with \$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(\$false); chcp 65001 | Out-Null;. Use explicit flags such as PowerShell \`Get-Content -Encoding utf8\`, \`Set-Content -Encoding utf8\`, \`Out-File -Encoding utf8\`, Node.js \`fs.readFileSync(path, "utf8")\` / \`fs.writeFileSync(path, content, "utf8")\`, and Python \`open(path, encoding="utf-8")\` / \`open(path, "w", encoding="utf-8")\`. Do not rely on Windows legacy console code pages or default file encodings for Chinese text.
   - If Chinese output appears garbled, first suspect encoding boundaries: terminal code page, PowerShell input/output encoding, file read/write encoding, response charset, and copied text from external tools.
   - Never "fix" mojibake by guessing or rewriting the Chinese text content unless the source encoding has been identified.

15. NO SPACING RULE (CRITICAL):
   - When Chinese characters meet English letters, numbers, or symbols, DO NOT use spaces at the **boundary** between them.
   - Connect them directly. Example: use "文字a文字" instead of "文字 a 文字", "文字1文字" instead of "文字 1 文字", "文字+文字" instead of "文字 + 文字".
   - **PRESERVE INTERNAL SPACES**: You MUST keep spaces between English words or numbers within their own segments.
   - Example: use "a cake is here是的" (Correct) instead of "acakeishere是的" (Incorrect).

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

// Caching for optimizations (AIAgent Performance)
let skillsCache = { data: null, lastScan: 0, mtimes: new Map() };

function getDirMaxMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  let maxTime = fs.statSync(dir).mtimeMs;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const filePath = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(filePath)) {
          maxTime = Math.max(maxTime, fs.statSync(filePath).mtimeMs);
        }
      }
    }
  } catch (e) {}
  return maxTime;
}

function loadSkills() {
  const dirsToScan = [
    SKILLS_DIR,
    path.join(os.homedir(), ".workbuddy", "skills-marketplace", "skills"),
  ];

  const now = Date.now();
  let cacheValid = skillsCache.data !== null && (now - skillsCache.lastScan < 5000); // Fast path 5s TTL
  
  if (!cacheValid) {
    cacheValid = true;
    for (const dir of dirsToScan) {
      const currentMtime = getDirMaxMtime(dir);
      if (skillsCache.mtimes.get(dir) !== currentMtime) {
        cacheValid = false;
        skillsCache.mtimes.set(dir, currentMtime);
      }
    }
    skillsCache.lastScan = now;
  }

  if (cacheValid) {
    return skillsCache.data;
  }

  const allSkills = [];

  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const filePath = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(filePath)) return null;
        
        const buffer = fs.readFileSync(filePath);
        let content;
        try {
          const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
          content = utf8Decoder.decode(buffer);
        } catch (e) {
          try {
            const gbkDecoder = new TextDecoder("gbk");
            content = gbkDecoder.decode(buffer);
            console.log(`[Skills] Decoded ${filePath} using GBK`);
          } catch (e2) {
            content = buffer.toString("utf8");
          }
        }
        
        return parseSkill(entry.name, filePath, content);
      })
      .filter(Boolean);

    allSkills.push(...entries);
  }

  skillsCache.data = allSkills;
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
        const normalized = normalizeContentPart(part);
        return normalized;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    return normalizeContentPart(content) || JSON.stringify(content);
  }
  return JSON.stringify(content);
}

function mergeRequestAttachments(messages, body = {}) {
  const attachmentFields = ["attachments", "files", "images", "items"];
  if (!attachmentFields.some((field) => body[field])) return messages;

  const nextMessages = messages.map((message) => ({ ...message }));
  let targetIndex = nextMessages.length > 0 ? nextMessages.length - 1 : 0;
  for (let i = nextMessages.length - 1; i >= 0; i -= 1) {
    if (nextMessages[i].role !== "assistant") {
      targetIndex = i;
      break;
    }
  }
  const target = nextMessages[targetIndex] || { role: "user", content: "" };

  for (const field of attachmentFields) {
    if (!body[field]) continue;
    target[field] = [...toArray(target[field]), ...toArray(body[field])];
  }

  nextMessages[targetIndex] = target;
  return nextMessages;
}

function normalizeMessageContent(message = {}) {
  const sections = [normalizeContent(message.content)];
  sections.push(normalizeAttachmentList("附件", message.attachments));
  sections.push(normalizeAttachmentList("文件", message.files));
  sections.push(normalizeAttachmentList("图片", message.images));
  sections.push(normalizeAttachmentList("输入项", message.items));

  return sections.filter(Boolean).join("\n\n");
}

function normalizeContentPart(part) {
  if (part == null) return "";
  if (typeof part === "string") return part;

  const type = String(part.type || "").toLowerCase();
  if (type === "text" || type === "input_text") return part.text || "";
  if (part.text && !isAttachmentLike(type) && !hasAttachmentFields(part)) return part.text;

  if (type === "image_url" || type === "input_image") {
    return formatAttachmentLine("图片", {
      url: part.image_url?.url || part.image_url || part.url,
      path: part.path || part.file_path,
      name: part.name || part.filename,
      detail: part.detail || part.image_url?.detail,
      fileId: part.file_id,
    });
  }

  if (type === "local_image") {
    return formatAttachmentLine("本地图片", {
      path: part.path || part.file_path,
      name: part.name || part.filename,
      detail: part.detail,
    });
  }

  if (type === "file" || type === "input_file" || type === "local_file") {
    return formatAttachmentLine("文件", {
      url: part.file?.url || part.url,
      path: part.path || part.file_path || part.file?.path,
      name: part.name || part.filename || part.file?.filename,
      data: part.file_data || part.file?.file_data,
      fileId: part.file_id || part.file?.file_id,
    });
  }

  if (type === "mention") {
    return formatAttachmentLine("引用", {
      url: part.url,
      path: part.path,
      name: part.name,
    });
  }

  return formatAttachmentLine(type || "结构化输入", part);
}

function normalizeAttachmentList(label, value) {
  if (!value) return "";
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => {
      if (typeof item === "string") {
        return formatAttachmentLine(label, { path: item, url: item });
      }
      return normalizeContentPart({ type: label, ...item });
    })
    .filter(Boolean)
    .join("\n");
}

function formatAttachmentLine(label, item = {}) {
  const name = item.name || item.filename || item.title || "";
  const url = normalizeAttachmentUrl(item.url || item.image_url);
  const localPath = normalizeAttachmentPath(item.path || item.file_path || url);
  const savedPath = saveDataUrlAttachment(url || item.data, name);
  const pieces = [];

  if (name) pieces.push(`名称: ${name}`);
  if (localPath) pieces.push(`本地路径: ${localPath}`);
  if (savedPath) pieces.push(`已保存到: ${savedPath}`);
  if (url && !url.startsWith("data:") && !localPath) pieces.push(`URL: ${url}`);
  if (item.detail) pieces.push(`细节: ${item.detail}`);
  if (item.fileId) pieces.push(`文件ID: ${item.fileId}`);

  if (pieces.length === 0 && item.text) return item.text;
  if (pieces.length === 0) return "";

  return `[WorkBuddy ${label}] ${pieces.join("；")}`;
}

function normalizeAttachmentUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.url || value.href || "";
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeAttachmentPath(value) {
  if (!value || typeof value !== "string") return "";
  if (value.startsWith("file://")) {
    try {
      const decoded = decodeURIComponent(value.replace(/^file:\/+/, ""));
      return process.platform === "win32" ? decoded.replace(/^\//, "").replace(/\//g, "\\") : `/${decoded}`;
    } catch {
      return value;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/")) return value;
  return "";
}

function saveDataUrlAttachment(value, name = "") {
  if (typeof value !== "string" || !value.startsWith("data:")) return "";

  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/);
  if (!match) return "";

  const mime = match[1] || "application/octet-stream";
  const ext = extensionFromMime(mime);
  const safeName = sanitizeFileName(path.parse(name || "attachment").name || "attachment");
  const filePath = path.join(ATTACHMENTS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}${ext}`);

  try {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
    return filePath;
  } catch (error) {
    console.error("[attachments] Failed to save data URL:", error.message);
    return "";
  }
}

function extensionFromMime(mime) {
  const normalized = String(mime || "").toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "text/plain") return ".txt";
  return ".bin";
}

function sanitizeFileName(value) {
  return String(value || "attachment").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80) || "attachment";
}

function isAttachmentLike(type) {
  return ["image_url", "input_image", "local_image", "file", "input_file", "local_file", "mention"].includes(type);
}

function hasAttachmentFields(value = {}) {
  return Boolean(
    value.path ||
      value.file_path ||
      value.url ||
      value.image_url ||
      value.file ||
      value.file_data ||
      value.filename ||
      value.name
  );
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
