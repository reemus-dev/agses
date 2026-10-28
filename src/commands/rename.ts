import {constants} from "node:fs";
import {appendFile} from "node:fs/promises";
import {defineCommand} from "citty";
import {CliFailure, runSafely, validateArguments} from "../modules/cli.js";
import {discoverProjects, sessionsOf} from "../modules/discovery.js";
import {formatPreview} from "../modules/format.js";
import {resolveSession} from "../modules/sessions.js";

export const renameCommand = defineCommand({
  meta: {
    name: "rename",
    description: "Rename a Claude Code session, as /rename does.",
  },
  args: {
    session: {
      type: "positional",
      description: "Session path, UUID/prefix, 14-char Hex ID, or exact name",
      required: true,
    },
    name: {
      type: "positional",
      description: "New session name",
      required: true,
    },
    project: {
      type: "string",
      description: "Project path or unique cwd substring",
      alias: ["p"],
    },
  },
  async run({args, rawArgs, cmd}) {
    await runSafely(async () => {
      await validateArguments(rawArgs, cmd.args);
      const name = args.name.trim();
      if (name === "") throw new CliFailure("The new name must not be empty.");

      // Claude Code names a continued session from the transcript continuing it
      const selected = await resolveSession(args.session, args.project);
      const session = sessionsOf(await discoverProjects()).find(
        ({id, continues}) =>
          id === selected.id ||
          continues.some((earlier) => earlier.id === selected.id),
      );
      if (session === undefined) {
        throw new CliFailure(`Session ${selected.id} no longer exists.`);
      }

      // The latest custom-title entry names the session, in a running Claude
      // Code process too. Without O_CREAT, a transcript deleted meanwhile fails.
      const entry = {
        type: "custom-title",
        customTitle: name,
        sessionId: session.id,
      };
      await appendFile(session.transcript, `${JSON.stringify(entry)}\n`, {
        flag: constants.O_WRONLY | constants.O_APPEND,
      });
      process.stdout.write(
        `Renamed ${session.hexId} from "${formatPreview(session.name)}" to "${name}".\n`,
      );
    });
  },
});
