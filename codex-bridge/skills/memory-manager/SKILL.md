# Memory Manager

<description>
A skill that allows the agent to read and write persistent memory. This helps the agent remember important context, user preferences, and project decisions across different chat sessions.
</description>

<triggers>
- 记住
- 记一下
- 保存状态
- update memory
- save context
</triggers>

<instructions>
You have access to a persistent memory file located at `.agent_memory.json` in the root of the current working directory.

When the user asks you to remember something, or when you make a significant architectural decision that should be preserved:
1. Read the existing `.agent_memory.json` (if it exists) using a command like `cat .agent_memory.json` or `Get-Content .agent_memory.json`.
2. Parse the JSON (mentally) and update it with the new information.
3. Write the updated JSON back to the file using an appropriate command (e.g., `echo '{...}' > .agent_memory.json` or Node.js/Python script).

Always ensure the file contains valid JSON.

Structure the memory like this:
```json
{
  "user_preferences": {
    "language": "Chinese",
    "framework": "React"
  },
  "project_context": {
    "architecture": "...",
    "current_focus": "..."
  },
  "important_notes": [
    "Note 1",
    "Note 2"
  ]
}
```
</instructions>