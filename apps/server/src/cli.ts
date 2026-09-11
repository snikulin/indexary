import process from "node:process";

import { buildApplication } from "./application.js";
import { ConfigurationError, resolveRuntimeConfig } from "./config.js";

async function main(): Promise<void> {
  try {
    const config = resolveRuntimeConfig(
      process.argv.slice(2),
      process.env,
      process.env.INIT_CWD ?? process.cwd(),
    );
    const app = await buildApplication(config);
    await app.listen({ host: config.host, port: config.port });

    const close = async () => {
      await app.close();
      process.exit(0);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);

    console.log(
      `Indexary is listening on http://${config.host}:${config.port}`,
    );
  } catch (error) {
    const message =
      error instanceof ConfigurationError
        ? error.message
        : "Indexary could not be started.";
    console.error(message);
    process.exitCode = 1;
  }
}

await main();
