# Verify slack-mcp-tools is applied

```bash
grep "mcp__slack__\*" container/agent-runner/src/index.ts
grep 'SLACK_MCP_XOXB_TOKEN' container/agent-runner/src/index.ts
grep "delete process.env.SLACK_BOT_TOKEN" container/agent-runner/src/index.ts
```

All three should print a matching line. If any print nothing, re-run `git cherry-pick origin/skill/slack-mcp-tools` per `SKILL.md`.
