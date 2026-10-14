/**
 * Example Gnito plugin.
 *
 * Exposes one tool: `example_read_first_line` — reads the first line of
 * a file inside an approved folder and returns it.
 *
 * SECURITY NOTE: this code runs inside the Gnito process. It is not
 * sandboxed. Only install plugins you trust. See docs/plugin-sdk.md.
 */
export const tools = [
  {
    name: 'example_read_first_line',
    description: 'Read the first line of a file in an approved folder.',
    permissions: ['files:read'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside an approved root.' },
      },
      required: ['path'],
    },
    async execute(input) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      // This is example code — in a real plugin you would use the Gnito
      // SDK's permission broker instead of direct fs access.
      const approvedRoot = process.env.GNITO_EXAMPLE_ROOT || process.cwd();
      const target = path.resolve(approvedRoot, input.path);
      if (!target.startsWith(path.resolve(approvedRoot))) {
        return { error: 'Path escapes approved root.' };
      }
      const content = await fs.readFile(target, 'utf8');
      const firstLine = content.split('\n')[0] || '';
      return { output: { firstLine, path: input.path } };
    },
  },
];
