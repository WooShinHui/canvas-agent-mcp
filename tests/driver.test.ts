import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.js";
import { PhaserDriver } from "../src/driver.js";

const PORT = 5199;
const URL = `http://localhost:${PORT}`;
let server: ChildProcess;

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("데모 서버가 시작되지 않았습니다");
}

function config(overrides: object = {}) {
  return parseConfig({ ...loadConfig(), url: URL, ...overrides });
}

before(async () => {
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "demo",
      "--port",
      String(PORT),
      "--strictPort",
    ],
    { stdio: "ignore" }
  );
  await waitForServer();
});

after(() => {
  server.kill();
});

test("에이전트가 게임을 조작하고 상태와 이벤트로 검증한다", async () => {
  const driver = new PhaserDriver(config());
  try {
    assert.deepEqual(await driver.play(false), []);

    const ids = (await driver.listTargets()).map((target) => target.id);
    assert.deepEqual(ids.sort(), ["block", "button"]);

    await driver.click("button");
    assert.equal((await driver.getState()).score, 1);

    await driver.drag("block", 640, 320);
    assert.equal((await driver.getState()).phase, 2);

    const state = await driver.getState();
    assert.equal(typeof state.timerLeftMs, "number");

    const { events } = await driver.getTimeline();
    const types = events.map((event: { type: string }) => event.type);
    for (const expected of [
      "pointer_down",
      "score_add",
      "drag_end",
      "phase_up",
      "complete",
    ]) {
      assert.ok(types.includes(expected), `${expected} 이벤트 없음`);
    }

    assert.ok((await driver.screenshot()).length > 1000);
  } finally {
    await driver.stop();
  }
});

test("게임에 없는 추적 대상은 조용히 넘어가지 않고 알려 준다", async () => {
  const driver = new PhaserDriver(
    config({
      trace: [{ target: "controller", method: "renamedMethod", event: "x" }],
      events: [{ target: "noSuchObject", name: "EVENT", event: "y" }],
    })
  );
  try {
    assert.deepEqual(await driver.play(false), [
      "controller.renamedMethod",
      "noSuchObject.on(EVENT)",
    ]);
  } finally {
    await driver.stop();
  }
});

test("없는 대상을 누르면 가능한 대상을 알려 준다", async () => {
  const driver = new PhaserDriver(config());
  try {
    await driver.play(false);
    await assert.rejects(() => driver.click("missing"), /가능한 대상: .*button/);
  } finally {
    await driver.stop();
  }
});
