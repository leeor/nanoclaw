# Verify add-linear-tool

```bash
grep -q '"linear"' groups/*/container.json && \
  grep -q "'mcp__linear__\\*'" container/agent-runner/src/providers/claude.ts && \
  echo "WIRED" || echo "NOT WIRED"
```
