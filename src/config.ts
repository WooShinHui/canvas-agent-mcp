import { readFileSync } from "node:fs";
import * as z from "zod/v4";

const configSchema = z.object({
  url: z.string().default("http://localhost:5173"),
  gameGlobal: z.string().default("__game"),
  scene: z.string(),
  readyPath: z.string().optional(),
  state: z.record(z.string(), z.string()).default({}),
  trace: z
    .array(
      z.object({
        target: z.string().default(""),
        method: z.string(),
        event: z.string(),
      })
    )
    .default([]),
  events: z
    .array(
      z.object({
        target: z.string().default(""),
        name: z.string(),
        event: z.string(),
      })
    )
    .default([]),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(input: unknown): Config {
  return configSchema.parse(input);
}

export function loadConfig(
  file = process.env.PHASER_AGENT_CONFIG ?? "phaser-agent.config.json"
): Config {
  return parseConfig(JSON.parse(readFileSync(file, "utf-8")));
}
