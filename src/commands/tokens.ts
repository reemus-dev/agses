import {defineCommand} from "citty";
import type {
  MessageCountTokensParams,
  MessageTokensCount,
} from "@anthropic-ai/sdk/resources/messages/messages";
import {CliFailure, runSafely, validateArguments} from "../modules/cli.js";
import {resolveModel} from "../modules/models.js";

async function readInput(file: string | undefined): Promise<string> {
  if (!file || file === "-") {
    if (process.stdin.isTTY) {
      throw new CliFailure(
        "No file specified and stdin is a TTY. Provide a file path or pipe input.",
      );
    }
    return Bun.stdin.text();
  }

  const bunFile = Bun.file(file);
  if (!(await bunFile.exists())) {
    throw new CliFailure(`File not found: ${file}`);
  }
  return bunFile.text();
}

/** Count through the API, at `ANTHROPIC_BASE_URL` when set, as Claude Code does */
async function countTokens(
  apiKey: string,
  model: string,
  content: string,
): Promise<number> {
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const body: MessageCountTokensParams = {
    model: resolveModel(model),
    messages: [{role: "user", content}],
  };
  const response = await fetch(
    `${base.replace(/\/+$/, "")}/v1/messages/count_tokens`,
    {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  );
  const result = (await response.json().catch(() => ({}))) as Partial<
    MessageTokensCount & {error: {message?: string}}
  >;
  if (!response.ok || typeof result.input_tokens !== "number") {
    throw new CliFailure(
      `Token counting failed (${response.status}): ${result.error?.message ?? response.statusText}`,
    );
  }
  return result.input_tokens;
}

export const tokensCommand = defineCommand({
  meta: {
    name: "tokens",
    description: "Count tokens in a file or stdin via the Anthropic API.",
  },
  args: {
    file: {
      type: "positional",
      description: "File path (omit or use - for stdin)",
      required: false,
    },
    model: {
      type: "string",
      description: 'Model alias or ID (default: "opus")',
      alias: ["m"],
      default: "opus",
    },
  },
  async run({args, rawArgs, cmd}) {
    await runSafely(async () => {
      await validateArguments(rawArgs, cmd.args);
      const content = await readInput(args.file);
      if (!content.trim()) {
        console.log("0");
        return;
      }

      const apiKey =
        process.env.AGSES_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new CliFailure(
          "Set AGSES_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY to count tokens.",
        );
      }
      console.log(String(await countTokens(apiKey, args.model, content)));
    });
  },
});
