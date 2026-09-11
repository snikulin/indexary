import fastifyStatic from "@fastify/static";
import {
  Type,
  TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";

import type { RuntimeConfig } from "./config.js";
import {
  createKnowledgeBase,
  type KnowledgeBase,
} from "./knowledge-base/index.js";

const LiveResponse = Type.Object(
  { status: Type.Literal("live") },
  { additionalProperties: false },
);
const ReadyResponse = Type.Object(
  { status: Type.Literal("ready"), homeDocument: Type.Literal("available") },
  { additionalProperties: false },
);
const NotReadyResponse = Type.Object(
  {
    status: Type.Literal("not-ready"),
    reason: Type.Union([
      Type.Literal("initializing"),
      Type.Literal("home-document-unavailable"),
    ]),
  },
  { additionalProperties: false },
);
const DocumentResponse = Type.Object(
  {
    path: Type.Literal("index.md"),
    title: Type.String({ minLength: 1 }),
    html: Type.String(),
  },
  { additionalProperties: false },
);
const ErrorResponse = Type.Object(
  {
    code: Type.Literal("HOME_DOCUMENT_NOT_FOUND"),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export interface ApplicationOptions {
  knowledgeBase?: KnowledgeBase;
}

export async function buildApplication(
  config: RuntimeConfig,
  options: ApplicationOptions = {},
): Promise<FastifyInstance> {
  const knowledgeBase =
    options.knowledgeBase ?? createKnowledgeBase(config.knowledgeBasePath);
  const app = Fastify({ logger: false }).setValidatorCompiler(
    TypeBoxValidatorCompiler,
  );
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    "/api/health/live",
    { schema: { response: { 200: LiveResponse } } },
    async () => ({ status: "live" as const }),
  );

  typedApp.get(
    "/api/health/ready",
    { schema: { response: { 200: ReadyResponse, 503: NotReadyResponse } } },
    async (_request, reply) => {
      const status = knowledgeBase.status();
      if (status.state === "ready") {
        return { status: "ready" as const, homeDocument: "available" as const };
      }
      return reply
        .status(503)
        .send({ status: "not-ready" as const, reason: status.state });
    },
  );

  typedApp.get(
    "/api/documents/home",
    { schema: { response: { 200: DocumentResponse, 404: ErrorResponse } } },
    async (_request, reply) => {
      const document = await knowledgeBase.openHomeDocument();
      if (document === undefined) {
        return reply.status(404).send({
          code: "HOME_DOCUMENT_NOT_FOUND" as const,
          message: "Домашний документ /index.md недоступен.",
        });
      }
      return document;
    },
  );

  if (config.webRoot !== undefined) {
    await typedApp.register(fastifyStatic, {
      root: config.webRoot,
      index: false,
      wildcard: false,
    });
    typedApp.get("/", async (_request, reply) =>
      reply.type("text/html").sendFile("index.html"),
    );
  }

  void knowledgeBase.initialize();
  return app;
}
