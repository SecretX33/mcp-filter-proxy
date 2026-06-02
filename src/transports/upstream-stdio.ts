import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stripProxyEnv } from "../config.js";

export function createStdioUpstream(
  command: string,
  args: string[],
): StdioClientTransport {
  console.error(
    `Using stdio transport for upstream server: ${command} ${args.join(" ")}`,
  );
  return new StdioClientTransport({
    command,
    args,
    env: stripProxyEnv(process.env),
    stderr: "pipe",
  });
}
