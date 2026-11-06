import express, { NextFunction, Request, Response } from "express";
import apiRoutes from "./routes/apiRoutes";
import { errorResponse } from "./controllers/shared";

export function createApp(apiKey: string) {
  const app = express();

  app.set("trust proxy", 1);

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.header("X-API-Key") !== apiKey) {
      res.status(401).json({ error: "missing or invalid API key" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(apiRoutes);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      errorResponse(res, 400, "request body must be valid JSON");
      return;
    }
    console.error("Request failed", error);
    errorResponse(res, 500, "internal server error");
  });

  return app;
}
