# Built-in Tools

Agent SDK ships with 20+ tools covering file I/O, search, command execution, web access, task management, and MCP integration.

| Tool                                       | Description                                  |
| ------------------------------------------ | -------------------------------------------- |
| **Bash**                                   | Execute shell commands                       |
| **Read**                                   | Read files with line numbers (text, images, PDFs) |
| **Write**                                  | Create / overwrite files                     |
| **Edit**                                   | Precise string replacement in files          |
| **Glob**                                   | Find files by pattern                        |
| **Grep**                                   | Search file contents with regex              |
| **WebFetch**                               | Fetch and parse web content                  |
| **WebSearch**                              | Search the web                               |
| **Task**                                  | Spawn a subagent for delegated work                      |
| **MultiTask**                              | Parallel multi-subagent dispatch             |
| **Skill**                                  | Invoke registered skills                     |
| **AskUserQuestion**                        | Ask the user for input                       |
| **FindTool**                               | Discover lazy-loaded tools                   |
| **CronCreate/Delete/List**                 | Scheduled task management                    |
| **Config**                                 | Dynamic configuration                        |
| **TodoWrite**                              | Session todo list                            |

### PDF Support

The Read tool supports extracting text content from PDF files:

```typescript
const agent = createAgent({
  agent: {
    description: 'PDF reader',
    prompt: 'You are a helpful assistant.',
    allowedTools: ['Read'],
  },
})
const result = await agent.prompt('Read /path/to/document.pdf and summarize it')
console.log(result.text)
```

**Requirements:** PDF support uses `pdfjs-dist`, which ships as a dependency of the SDK — no separate install needed.

**Features:**

- Extracts text from each page with page markers
- Extracts AcroForm field values
- Works with `offset` and `limit` parameters like text files
