export interface DevUpdatesInstall {
  serverName: string;
  apiUrl: string;
  token: string;
  projectKey: string;
  serverPath: string;
}

/** Explicit environment values make the server independent of the calling shell. */
export function devUpdatesMcpConfig(input: DevUpdatesInstall) {
  return {
    command: 'node',
    args: [input.serverPath],
    env: {
      AI17Z_API_URL: input.apiUrl,
      AI17Z_DEV_UPDATES_TOKEN: input.token,
      AI17Z_DEV_UPDATES_PROJECT: input.projectKey,
    },
  };
}

/** Callers validate shell values first. The screen uses commandState for this. */
export function mcpAddCommand(input: DevUpdatesInstall): string {
  const config = devUpdatesMcpConfig(input);
  return [
    'claude mcp add',
    input.serverName,
    '--scope local',
    ...Object.entries(config.env).map(([key, value]) => `--env ${key}=${value}`),
    // Some PowerShell shims drop --. End the variadic env option explicitly.
    '--transport stdio',
    '--',
    config.command,
    `"${input.serverPath}"`,
  ].join(' ');
}
