# Peazy MCP App (Manufact)

Thin TypeScript MCP app that exposes ADK runtime data/tools to ChatGPT and renders a Vidstack player widget.

## Prerequisites

- Node.js 22+
- Running ADK runtime API (`mcp_server.py`) reachable from this app

## Environment

- `ADK_API_BASE_URL` (default: `http://localhost:8000`)
- `ADK_API_TIMEOUT_MS` (default: `9000`)
- `ADK_DEFAULT_RUN_ID` (optional)
- `MCP_URL` (set by platform on deploy; local default `http://localhost:3000`)

## Local Development

```bash
npm install
npm run dev
```

Inspector is available at `http://localhost:3000/inspector`.

## Tools

- `list_runs`
- `open_run_player`
- `get_segment_quiz`
- `submit_segment_quiz`

## Deploy (Manufact)

```bash
npm run deploy
```

Run deploy from this `mcp-app/` directory.
