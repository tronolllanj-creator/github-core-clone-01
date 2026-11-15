import * as http from "node:http";
import { Store } from "./store.ts";
import type { Repo } from "./store.ts";
import {
  uploadPackAdvertisement,
  receivePackAdvertisement,
  uploadPack,
} from "./gitproto.ts";
import { handleReceivePack } from "./gitrecv.ts";
import { handleRest } from "./rest.ts";
import type { RestContext, RestResponse } from "./rest.ts";
import { executeGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import type { JsonRpcRequest } from "./mcp.ts";

let requestIdCounter = 0;

function getNextRequestId(): string {
  requestIdCounter += 1;
  const randomHex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `req-${requestIdCounter}-${randomHex}`;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err: Error) => {
      reject(err);
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function createApp(store: Store, opts: { token: string }): http.RequestListener {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    (async () => {
      const requestId = getNextRequestId();
      res.setHeader("X-GitHub-Request-Id", requestId);

      try {
        const rawUrl = req.url ?? "/";
        const reqUrl = new URL(rawUrl, "http://localhost");
        const pathname = normalizePath(reqUrl.pathname);
        const method = req.method ?? "GET";

        if (method === "GET" && pathname === "/healthz") {
          sendJson(res, 200, { ok: true });
          return;
        }

        const authHeader = req.headers["authorization"];
        if (authHeader !== `Bearer ${opts.token}`) {
          sendJson(res, 401, { message: "Bad credentials" });
          return;
        }

        const infoRefsMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/info\/refs$/);
        if (infoRefsMatch && method === "GET") {
          const owner = infoRefsMatch[1];
          const repoName = infoRefsMatch[2];
          const service = reqUrl.searchParams.get("service");

          if (service === "git-upload-pack") {
            const repo: Repo | null | undefined = store.getRepo(owner, repoName);
            if (!repo) {
              sendJson(res, 404, { message: "Not Found" });
              return;
            }
            const adv = uploadPackAdvertisement(repo);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/x-git-upload-pack-advertisement");
            res.end(adv);
            return;
          } else if (service === "git-receive-pack") {
            const repo: Repo | null | undefined = store.getRepo(owner, repoName);
            if (!repo) {
              sendJson(res, 404, { message: "Not Found" });
              return;
            }
            const adv = receivePackAdvertisement(repo);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/x-git-receive-pack-advertisement");
            res.end(adv);
            return;
          } else {
            sendJson(res, 400, { message: "Invalid service" });
            return;
          }
        }

        const uploadPackMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/);
        if (uploadPackMatch && method === "POST") {
          const owner = uploadPackMatch[1];
          const repoName = uploadPackMatch[2];
          const repo: Repo | null | undefined = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          const bodyBuf = await readBody(req);
          const result = uploadPack(repo, bodyBuf);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-git-upload-pack-result");
          res.end(result);
          return;
        }

        const receivePackMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/);
        if (receivePackMatch && method === "POST") {
          const owner = receivePackMatch[1];
          const repoName = receivePackMatch[2];
          const repo: Repo | null | undefined = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          const bodyBuf = await readBody(req);
          const result = handleReceivePack(repo, bodyBuf);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-git-receive-pack-result");
          res.end(result);
          return;
        }

        if (pathname === "/api/graphql" && method === "POST") {
          const bodyBuf = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyBuf.toString("utf-8"));
          } catch {
            sendJson(res, 400, { message: "Invalid JSON" });
            return;
          }
          const gqlRes = executeGraphQL(store, "adaiversen", parsed);
          sendJson(res, gqlRes.status, gqlRes.body);
          return;
        }

        if (pathname === "/mcp" && method === "POST") {
          const bodyBuf = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyBuf.toString("utf-8"));
          } catch {
            sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            return;
          }
          const mcpRes = handleMcp(store, "adaiversen", parsed as JsonRpcRequest);
          sendJson(res, 200, mcpRes);
          return;
        }

        if (pathname === "/api/v3" || pathname.startsWith("/api/v3/")) {
          const pathSuffix = pathname === "/api/v3" ? "" : pathname.slice("/api/v3/".length);
          const segments = pathSuffix.split("/").filter((s) => s.length > 0);

          const query: Record<string, string> = {};
          for (const [k, v] of reqUrl.searchParams.entries()) {
            if (!(k in query)) {
              query[k] = v;
            }
          }

          let parsedBody: unknown = null;
          if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
            const bodyBuf = await readBody(req);
            if (bodyBuf.length > 0) {
              try {
                parsedBody = JSON.parse(bodyBuf.toString("utf-8"));
              } catch {
                sendJson(res, 400, { message: "Invalid JSON" });
                return;
              }
            }
          }

          const hostHeader = req.headers.host ?? "";
          const origin = hostHeader ? `http://${hostHeader}` : "";
          const ctx: RestContext = {
            store,
            viewerLogin: "adaiversen",
            method,
            segments,
            query,
            body: parsedBody,
            origin,
          };

          const restRes: RestResponse | null = handleRest(ctx);
          if (restRes === null) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }

          res.statusCode = restRes.status;
          let hasContentType = false;
          if (restRes.headers) {
            for (const [hk, hv] of Object.entries(restRes.headers)) {
              if (hk.toLowerCase() === "content-type") {
                hasContentType = true;
              }
              res.setHeader(hk, hv);
            }
          }
          if (!hasContentType) {
            res.setHeader("Content-Type", "application/json");
          }
          res.end(JSON.stringify(restRes.body));
          return;
        }

        sendJson(res, 404, { message: "Not Found" });
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { message: "Internal Server Error" });
        }
      }
    })();
  };
}
