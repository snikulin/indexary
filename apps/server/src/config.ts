import path from "node:path";

import Type from "typebox";
import Schema from "typebox/schema";

const RuntimeConfigSchema = Type.Object(
  {
    knowledgeBasePath: Type.String({ minLength: 1 }),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    profile: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$" }),
    cacheRoot: Type.Optional(Type.String({ minLength: 1 })),
    webRoot: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const RuntimeConfig = Schema.Compile(RuntimeConfigSchema);

export type RuntimeConfig = Type.Static<typeof RuntimeConfigSchema>;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

type Environment = Readonly<Record<string, string | undefined>>;

interface RawOptions {
  knowledgeBasePath?: string;
  host?: string;
  port?: string;
  profile?: string;
  cacheRoot?: string;
  webRoot?: string;
}

const optionNames: Record<string, keyof RawOptions> = {
  "--knowledge-base": "knowledgeBasePath",
  "--host": "host",
  "--port": "port",
  "--profile": "profile",
  "--cache-root": "cacheRoot",
  "--web-root": "webRoot",
};

function parseOptions(arguments_: readonly string[]): RawOptions {
  const options: RawOptions = {};

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--") {
      continue;
    }
    const name = option === undefined ? undefined : optionNames[option];
    if (name === undefined) {
      throw new ConfigurationError(`Unknown option: ${option ?? ""}`);
    }

    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${option} requires a value.`);
    }

    options[name] = value;
    index += 1;
  }

  return options;
}

export function resolveRuntimeConfig(
  arguments_: readonly string[],
  environment: Environment = process.env,
  workingDirectory = process.cwd(),
): RuntimeConfig {
  const options = parseOptions(arguments_);
  const knowledgeBasePath =
    options.knowledgeBasePath ?? environment.INDEXARY_KNOWLEDGE_BASE;

  if (knowledgeBasePath === undefined || knowledgeBasePath.trim() === "") {
    throw new ConfigurationError(
      "A Knowledge Base path is required. Pass --knowledge-base or INDEXARY_KNOWLEDGE_BASE.",
    );
  }

  const portText = options.port ?? environment.INDEXARY_PORT ?? "4173";
  if (!/^\d+$/.test(portText)) {
    throw new ConfigurationError(
      "The configured port must be an integer from 1 to 65535.",
    );
  }

  const candidate = {
    knowledgeBasePath: path.resolve(workingDirectory, knowledgeBasePath),
    host: options.host ?? environment.INDEXARY_HOST ?? "127.0.0.1",
    port: Number(portText),
    profile: options.profile ?? environment.INDEXARY_PROFILE ?? "default",
    ...((options.cacheRoot ?? environment.INDEXARY_CACHE_ROOT)
      ? {
          cacheRoot: path.resolve(
            workingDirectory,
            options.cacheRoot ?? environment.INDEXARY_CACHE_ROOT!,
          ),
        }
      : {}),
    ...((options.webRoot ?? environment.INDEXARY_WEB_ROOT)
      ? {
          webRoot: path.resolve(
            workingDirectory,
            options.webRoot ?? environment.INDEXARY_WEB_ROOT!,
          ),
        }
      : {}),
  };

  try {
    return RuntimeConfig.Parse(candidate);
  } catch {
    throw new ConfigurationError(
      "Runtime configuration does not match the supported schema.",
    );
  }
}
