#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  buildImmutableRelease,
  installService,
  ProductionError,
  resolveXdgPaths,
  smokeRelease,
  verifyInstalledService,
} from "./production.mjs";

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === "--managed" || name === "--allow-unready") {
      options[name.slice(2)] = true;
      continue;
    }
    if (!name?.startsWith("--")) {
      throw new ProductionError("Production command options must be named.");
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProductionError(
        "A production command option is missing its value.",
      );
    }
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value === "") {
    throw new ProductionError(`The --${name} option is required.`);
  }
  return value;
}

function rejectUnknownOptions(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) {
      throw new ProductionError(`The --${name} option is not supported.`);
    }
  }
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseOptions(arguments_);

  if (command === "build-release") {
    rejectUnknownOptions(options, ["data-home"]);
    const paths = resolveXdgPaths({
      ...process.env,
      ...(options["data-home"] === undefined
        ? {}
        : { XDG_DATA_HOME: path.resolve(options["data-home"]) }),
    });
    const result = await buildImmutableRelease({ paths });
    console.log(
      JSON.stringify({
        status: "built",
        releaseId: result.manifest.releaseId,
        releaseDirectory: result.releaseDirectory,
      }),
    );
    return;
  }

  if (command === "install-service") {
    rejectUnknownOptions(options, ["release", "knowledge-base", "port"]);
    const releaseDirectory = path.resolve(requireOption(options, "release"));
    const knowledgeBasePath = requireOption(options, "knowledge-base");
    const port =
      options.port === undefined
        ? undefined
        : Number(requireOption(options, "port"));
    const manifest = await installService({
      paths: resolveXdgPaths(),
      releaseDirectory,
      knowledgeBasePath,
      ...(port === undefined ? {} : { port }),
    });
    console.log(
      JSON.stringify({
        status: "installed-and-verified",
        releaseId: manifest.releaseId,
      }),
    );
    return;
  }

  if (command === "verify-service") {
    rejectUnknownOptions(options, []);
    const configuration = await verifyInstalledService();
    console.log(
      JSON.stringify({
        status: "verified-unchanged",
        releaseId: configuration.releaseId,
      }),
    );
    return;
  }

  if (command === "smoke-release") {
    rejectUnknownOptions(options, [
      "release",
      "knowledge-base",
      "managed",
      "allow-unready",
    ]);
    const manifest = await smokeRelease({
      releaseDirectory: path.resolve(requireOption(options, "release")),
      knowledgeBasePath: requireOption(options, "knowledge-base"),
      managed: options.managed === true,
      requireReady: options["allow-unready"] !== true,
    });
    console.log(
      JSON.stringify({
        status:
          options.managed === true ? "managed-smoke-passed" : "smoke-passed",
        releaseId: manifest.releaseId,
      }),
    );
    return;
  }

  throw new ProductionError(
    "Usage: cli.mjs <build-release|install-service|verify-service|smoke-release> [options]",
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ProductionError) {
    console.error(error.message);
  } else {
    console.error("The production operation failed.");
  }
  process.exitCode = 1;
}
