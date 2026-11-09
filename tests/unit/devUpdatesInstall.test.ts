import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandState } from '../../apps/web/src/lib/devUpdates';

const example = {
  serverName: 'ai17z-dev-updates',
  apiUrl: 'http://localhost:8787',
  token: 'ai17z_dus_REPLACE_WITH_SENDER_TOKEN',
  projectKey: 'my-project',
  serverPath: '/path/to/ai17z/tools/dev-updates-mcp.mjs',
};

describe('coding assistant installation instructions', () => {
  for (const file of ['README.md', 'docs/architecture/DEV_UPDATES.md']) {
    it(`${file} agrees with the screen command and generic MCP configuration`, () => {
      const doc = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      const block = doc.split('<!-- dev-updates-install:start -->')[1]?.split('<!-- dev-updates-install:end -->')[0];
      expect(block, 'generated installation instructions must be present').toBeTruthy();
      const screen = commandState({
        connection: { serverName: example.serverName, mcpServerPath: example.serverPath, reason: null },
        localPath: '',
        apiUrl: example.apiUrl,
        token: example.token,
        projectKey: example.projectKey,
      });
      expect(screen.command).toBeTruthy();
      expect(block?.match(/```sh\n([^\n]+)\n```/)?.[1]).toBe(screen.command);
      const config = JSON.parse(block?.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? '{}');
      expect(config).toEqual({
        mcpServers: {
          'ai17z-dev-updates': {
            command: 'node',
            args: [example.serverPath],
            env: {
              AI17Z_API_URL: example.apiUrl,
              AI17Z_DEV_UPDATES_TOKEN: example.token,
              AI17Z_DEV_UPDATES_PROJECT: example.projectKey,
            },
          },
        },
      });
    });
  }
});
