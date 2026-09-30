import express from "express";
import { greet } from "./index.js";

const app = express();
const port = process.env.PORT ?? 3000;

app.get("/", (_req, res) => {
  res.send(greet("world"));
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
