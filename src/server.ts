import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { PhaserDriver } from "./driver.js";

const driver = new PhaserDriver(loadConfig());
const server = new McpServer({ name: "phaser-agent", version: "0.1.0" });
const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

server.registerTool(
  "play",
  {
    description:
      "게임을 처음부터 실행한다. visible이 false면 창 없이 실행한다(기본은 창 표시). " +
      "결과의 missing은 설정에 있지만 게임에서 찾지 못해 기록되지 않는 항목이다",
    inputSchema: z.object({ visible: z.boolean().optional() }),
  },
  async ({ visible }) => {
    const missing = await driver.play(visible ?? true);
    return text(JSON.stringify({ started: true, missing }));
  }
);

server.registerTool(
  "get_state",
  {
    description:
      "입력 가능 여부, 재생 중인 소리, 설정 파일의 state에 정의한 게임 값을 돌려준다",
    inputSchema: z.object({}),
  },
  async () => text(JSON.stringify(await driver.getState()))
);

server.registerTool(
  "stop",
  { description: "게임을 종료한다", inputSchema: z.object({}) },
  async () => {
    await driver.stop();
    return text("stopped");
  }
);

server.registerTool(
  "list_targets",
  {
    description: "지금 누를 수 있는 오브젝트의 id와 게임 좌표를 돌려준다",
    inputSchema: z.object({}),
  },
  async () => text(JSON.stringify(await driver.listTargets()))
);

server.registerTool(
  "click",
  {
    description:
      "list_targets의 id로 오브젝트를 클릭한다. 결과의 inputEnabled가 false면 입력이 잠겨 클릭이 무시된 것이다",
    inputSchema: z.object({
      id: z.string().describe("list_targets가 돌려준 id"),
    }),
  },
  async ({ id }) => text(JSON.stringify(await driver.click(id)))
);

server.registerTool(
  "drag",
  {
    description:
      "list_targets의 id를 게임 좌표 (x, y)로 드래그한다. inputEnabled가 false면 무시된 것이다",
    inputSchema: z.object({ id: z.string(), x: z.number(), y: z.number() }),
  },
  async ({ id, x, y }) => text(JSON.stringify(await driver.drag(id, x, y)))
);

server.registerTool(
  "timeline",
  {
    description:
      "play 이후 게임 이벤트를 시간순으로 돌려준다. ms는 기록 시작 후 경과 밀리초, nowMs는 현재 시각이다. " +
      "sinceMs를 주면 그 이후 이벤트만 돌려준다",
    inputSchema: z.object({ sinceMs: z.number().optional() }),
  },
  async ({ sinceMs }) =>
    text(JSON.stringify(await driver.getTimeline(sinceMs ?? 0)))
);

server.registerTool(
  "screenshot",
  {
    description:
      "현재 게임 화면을 이미지로 돌려준다. 토큰을 많이 쓰므로 위치나 연출을 눈으로 봐야 할 때만 호출한다",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: "image" as const,
        data: await driver.screenshot(),
        mimeType: "image/jpeg",
      },
    ],
  })
);

await server.connect(new StdioServerTransport());
