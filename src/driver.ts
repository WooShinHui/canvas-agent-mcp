import { chromium, type Browser, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";

const DEBUG_PORT = 9333;

// tsx가 넣는 __name 호출을 브라우저에서도 동작시키고, 설정의 경로 문자열을 해석한다
const PAGE_HELPERS = `
globalThis.__name = (f) => f;
globalThis.__resolvePath = (root, path) => {
  if (!path) return root;
  let current = root;
  for (const part of path.split(".")) {
    if (current == null) return null;
    const isCall = part.endsWith("()");
    const key = isCall ? part.slice(0, -2) : part;
    current = isCall ? current[key]?.() : current[key];
  }
  return current ?? null;
};
`;

export interface Target {
  id: string;
  x: number;
  y: number;
}

export class PhaserDriver {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private chrome: ChildProcess | null = null;

  constructor(private readonly config: Config) {
    process.on("exit", () => this.chrome?.kill());
  }

  /** 게임을 처음부터 실행하고, 추적하지 못한 항목 목록을 돌려준다. */
  async play(visible = true): Promise<string[]> {
    await this.stop();

    if (visible) {
      this.chrome = spawn(
        chromium.executablePath(),
        [
          `--remote-debugging-port=${DEBUG_PORT}`,
          `--user-data-dir=${path.join(os.tmpdir(), "phaser-agent-profile")}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--autoplay-policy=no-user-gesture-required",
          // 창이 가려져도 게임이 느려지지 않게 한다
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
          "--window-size=1300,900",
          "about:blank",
        ],
        { stdio: "ignore" }
      );
      this.browser = await this.connect();
      const context = this.browser.contexts()[0];
      this.page = context.pages()[0] ?? (await context.newPage());
      await this.page.setViewportSize({ width: 1280, height: 768 });
    } else {
      this.browser = await chromium.launch({
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      this.page = await this.browser.newPage({
        viewport: { width: 1280, height: 768 },
      });
    }

    await this.page.addInitScript(PAGE_HELPERS);
    await this.page.goto(this.config.url);
    await this.page.waitForFunction(
      ({ gameGlobal, scene, readyPath }) => {
        const w = window as any;
        const s = w[gameGlobal]?.scene?.getScene(scene);
        if (!s) return false;
        return readyPath ? Boolean(w.__resolvePath(s, readyPath)) : true;
      },
      {
        gameGlobal: this.config.gameGlobal,
        scene: this.config.scene,
        readyPath: this.config.readyPath ?? "",
      }
    );
    return this.installTimeline();
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    this.chrome?.kill(); // CDP로 접속한 창은 close만으로 닫히지 않는다
    this.browser = null;
    this.page = null;
    this.chrome = null;
  }

  async getState(): Promise<Record<string, unknown>> {
    return this.activePage().evaluate(
      ({ gameGlobal, scene, state }) => {
        const w = window as any;
        const s = w[gameGlobal].scene.getScene(scene);
        const custom = Object.fromEntries(
          Object.entries(state).map(([key, path]) => [
            key,
            w.__resolvePath(s, path),
          ])
        );
        return {
          inputEnabled: s.input.enabled,
          sounds: (s.sound.sounds ?? [])
            .filter((sound: any) => sound.isPlaying)
            .map((sound: any) => sound.key),
          ...custom,
        };
      },
      {
        gameGlobal: this.config.gameGlobal,
        scene: this.config.scene,
        state: this.config.state,
      }
    );
  }

  async listTargets(): Promise<Target[]> {
    return this.activePage().evaluate(
      ({ gameGlobal, scene }) => {
        const s = (window as any)[gameGlobal].scene.getScene(scene);
        const result: { id: string; x: number; y: number }[] = [];
        const seen: Record<string, number> = {};

        const walk = (list: any[]) => {
          for (const object of list) {
            if (object.input?.enabled && object.visible) {
              let x: number;
              let y: number;
              if (typeof object.getBounds === "function") {
                const bounds = object.getBounds();
                x = bounds.centerX;
                y = bounds.centerY;
              } else {
                const hit = object.input.hitArea;
                const point = object
                  .getWorldTransformMatrix()
                  .transformPoint(hit.x + hit.width / 2, hit.y + hit.height / 2);
                x = point.x;
                y = point.y;
              }
              const base =
                object.name || object.texture?.key || object.constructor.name;
              seen[base] = (seen[base] ?? 0) + 1;
              const id = seen[base] === 1 ? base : `${base}#${seen[base]}`;
              result.push({ id, x: Math.round(x), y: Math.round(y) });
            }
            if (object.list) walk(object.list);
          }
        };

        walk(s.children.list);
        return result;
      },
      { gameGlobal: this.config.gameGlobal, scene: this.config.scene }
    );
  }

  async click(id: string) {
    const target = await this.findTarget(id);
    const { inputEnabled } = await this.getState();
    const point = await this.toScreen(target.x, target.y);
    await this.activePage().mouse.click(point.x, point.y);
    return { clicked: id, x: target.x, y: target.y, inputEnabled };
  }

  async drag(id: string, toX: number, toY: number) {
    const target = await this.findTarget(id);
    const { inputEnabled } = await this.getState();
    const from = await this.toScreen(target.x, target.y);
    const to = await this.toScreen(toX, toY);
    const page = this.activePage();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await page.mouse.up();
    return {
      dragged: id,
      from: [target.x, target.y],
      to: [toX, toY],
      inputEnabled,
    };
  }

  async getTimeline(sinceMs = 0) {
    return this.activePage().evaluate((since) => {
      const w = window as any;
      return {
        nowMs: Math.round(performance.now() - w.__timelineStart),
        events: w.__timeline.filter((event: any) => event.ms >= since),
      };
    }, sinceMs);
  }

  async screenshot(): Promise<string> {
    const image = await this.activePage().screenshot({
      type: "jpeg",
      quality: 60,
    });
    return image.toString("base64");
  }

  private activePage(): Page {
    if (!this.page) throw new Error("먼저 play를 호출하세요");
    return this.page;
  }

  private async connect(): Promise<Browser> {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("브라우저에 연결하지 못했습니다");
  }

  private async findTarget(id: string): Promise<Target> {
    const targets = await this.listTargets();
    const target = targets.find((candidate) => candidate.id === id);
    if (!target) {
      const available = targets.map((candidate) => candidate.id).join(", ");
      throw new Error(`대상 없음: ${id}. 가능한 대상: ${available}`);
    }
    return target;
  }

  /** 게임 좌표를 화면 좌표로 바꾼다. Canvas가 확대·축소되어 있어도 맞춘다. */
  private async toScreen(x: number, y: number) {
    const page = this.activePage();
    const box = await page.locator("canvas").first().boundingBox();
    if (!box) throw new Error("Canvas를 찾지 못했습니다");
    const gameWidth = await page.evaluate(
      ({ gameGlobal, scene }) =>
        (window as any)[gameGlobal].scene.getScene(scene).scale.width as number,
      { gameGlobal: this.config.gameGlobal, scene: this.config.scene }
    );
    const ratio = box.width / gameWidth;
    return { x: box.x + x * ratio, y: box.y + y * ratio };
  }

  private async installTimeline(): Promise<string[]> {
    return this.activePage().evaluate(
      ({ gameGlobal, scene, trace, events }) => {
        const w = window as any;
        const s = w[gameGlobal].scene.getScene(scene);
        const missing: string[] = [];

        w.__timelineStart = performance.now();
        w.__timeline = [];
        const log = (type: string, detail?: unknown) =>
          w.__timeline.push({
            ms: Math.round(performance.now() - w.__timelineStart),
            type,
            detail,
          });

        // 메서드가 불리면 기록하고, 원래 동작은 그대로 실행한다
        for (const { target, method, event } of trace) {
          const owner = w.__resolvePath(s, target);
          const original = owner?.[method];
          if (typeof original !== "function") {
            missing.push(`${target || "scene"}.${method}`);
            continue;
          }
          owner[method] = function (...args: unknown[]) {
            log(
              event,
              args.filter(
                (arg) => typeof arg === "string" || typeof arg === "number"
              )
            );
            return original.apply(this, args);
          };
        }

        for (const { target, name, event } of events) {
          const owner = w.__resolvePath(s, target);
          if (typeof owner?.on !== "function") {
            missing.push(`${target || "scene"}.on(${name})`);
            continue;
          }
          owner.on(name, () => log(event));
        }

        s.input.on("pointerdown", (pointer: any) =>
          log("pointer_down", [Math.round(pointer.x), Math.round(pointer.y)])
        );
        s.input.on("dragend", (_: unknown, object: any) =>
          log("drag_end", object.name || object.texture?.key)
        );

        const hookSound = (sound: any) => {
          sound.on("play", () => log("sound_play", sound.key));
          sound.on("complete", () => log("sound_end", sound.key));
        };
        (s.sound.sounds ?? []).forEach(hookSound);
        const add = s.sound.add;
        s.sound.add = function (...args: unknown[]) {
          const sound = add.apply(this, args);
          hookSound(sound);
          return sound;
        };

        return missing;
      },
      {
        gameGlobal: this.config.gameGlobal,
        scene: this.config.scene,
        trace: this.config.trace,
        events: this.config.events,
      }
    );
  }
}
