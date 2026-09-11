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
  InvalidKnowledgeBasePath,
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
    path: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    html: Type.String(),
    searchableText: Type.String(),
    tags: Type.Array(Type.String({ minLength: 1 })),
    sourceMaterials: Type.Array(Type.String({ minLength: 1 })),
    properties: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          value: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    diagnostics: Type.Array(
      Type.Object(
        {
          code: Type.String({ minLength: 1 }),
          message: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const ErrorResponse = Type.Object(
  {
    code: Type.Union([
      Type.Literal("HOME_DOCUMENT_NOT_FOUND"),
      Type.Literal("DOCUMENT_NOT_FOUND"),
      Type.Literal("FOLDER_NOT_FOUND"),
      Type.Literal("INVALID_KNOWLEDGE_BASE_PATH"),
    ]),
    message: Type.String(),
  },
  { additionalProperties: false },
);
const PathQuery = Type.Object(
  { path: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const CatalogResponse = Type.Object(
  {
    path: Type.String(),
    name: Type.String({ minLength: 1 }),
    folders: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    documents: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    diagnostics: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          code: Type.String({ minLength: 1 }),
          message: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const SearchResponse = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          tags: Type.Array(Type.String({ minLength: 1 })),
          snippet: Type.Array(
            Type.Object(
              {
                text: Type.String(),
                highlighted: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
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
    options.knowledgeBase ??
    createKnowledgeBase(config.knowledgeBasePath, {
      profile: config.profile,
      ...(config.cacheRoot === undefined
        ? {}
        : { cacheRoot: config.cacheRoot }),
    });
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
    "/api/catalog",
    {
      schema: {
        querystring: PathQuery,
        response: {
          200: CatalogResponse,
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const folder = await knowledgeBase.browseFolder(
          request.query.path ?? "",
        );
        if (folder === undefined) {
          return reply.status(404).send({
            code: "FOLDER_NOT_FOUND" as const,
            message: "Папка не найдена.",
          });
        }
        return folder;
      } catch (error) {
        if (error instanceof InvalidKnowledgeBasePath) {
          return reply.status(400).send({
            code: "INVALID_KNOWLEDGE_BASE_PATH" as const,
            message: "Путь внутри Базы знаний недопустим.",
          });
        }
        throw error;
      }
    },
  );

  typedApp.get(
    "/api/documents",
    {
      schema: {
        querystring: Type.Object(
          { path: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        response: {
          200: DocumentResponse,
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const document = await knowledgeBase.openDocument(request.query.path);
        if (document === undefined) {
          return reply.status(404).send({
            code: "DOCUMENT_NOT_FOUND" as const,
            message: "Документ не найден.",
          });
        }
        return document;
      } catch (error) {
        if (error instanceof InvalidKnowledgeBasePath) {
          return reply.status(400).send({
            code: "INVALID_KNOWLEDGE_BASE_PATH" as const,
            message: "Путь внутри Базы знаний недопустим.",
          });
        }
        throw error;
      }
    },
  );

  typedApp.get(
    "/api/search",
    {
      schema: {
        querystring: Type.Object(
          {
            q: Type.Optional(Type.String({ maxLength: 500 })),
            tag: Type.Optional(Type.String({ maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: SearchResponse },
      },
    },
    async (request) => ({
      results: await knowledgeBase.searchDocuments({
        ...(request.query.q === undefined ? {} : { query: request.query.q }),
        ...(request.query.tag === undefined ? {} : { tag: request.query.tag }),
      }),
    }),
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
    typedApp.get("/folders", async (_request, reply) =>
      reply.type("text/html").sendFile("index.html"),
    );
    for (const route of ["/documents/*", "/folders/*"]) {
      typedApp.get(route, async (_request, reply) =>
        reply.type("text/html").sendFile("index.html"),
      );
    }
  }

  await knowledgeBase.initialize();
  return app;
}
