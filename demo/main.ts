import Phaser from "phaser";

class Controller extends Phaser.Events.EventEmitter {
  ready = false;
  phase = 1;
  score = 0;
  timer: Phaser.Time.TimerEvent | null = null;

  addScore(amount: number) {
    this.score += amount;
  }

  nextPhase() {
    this.phase += 1;
    this.emit("GAME_COMPLETE");
  }
}

class MainScene extends Phaser.Scene {
  controller = new Controller();

  constructor() {
    super("Main");
  }

  create() {
    this.add.text(40, 40, "Phaser Agent MCP Demo", {
      fontSize: "28px",
      color: "#ffffff",
    });
    const status = this.add.text(40, 86, "", {
      fontSize: "20px",
      color: "#9fb3c8",
    });
    const refresh = () =>
      status.setText(
        `score ${this.controller.score}   phase ${this.controller.phase}`
      );
    refresh();

    const button = this.add
      .rectangle(170, 320, 180, 90, 0x3a86ff)
      .setName("button")
      .setInteractive();
    this.add.text(138, 306, "CLICK", { fontSize: "24px" });
    button.on("pointerdown", () => {
      this.controller.addScore(1);
      refresh();
    });

    const goal = this.add
      .rectangle(640, 320, 170, 170, 0x2a9d8f, 0.35)
      .setStrokeStyle(3, 0x2a9d8f)
      .setName("goal");

    const block = this.add
      .rectangle(400, 320, 90, 90, 0xffb703)
      .setName("block")
      .setInteractive({ draggable: true });

    this.input.on(
      "drag",
      (
        _pointer: Phaser.Input.Pointer,
        object: Phaser.GameObjects.Rectangle,
        x: number,
        y: number
      ) => object.setPosition(x, y)
    );
    this.input.on(
      "dragend",
      (_pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.Rectangle) => {
        const reached = Phaser.Geom.Rectangle.Overlaps(
          object.getBounds(),
          goal.getBounds()
        );
        if (object === block && reached) {
          this.controller.nextPhase();
          refresh();
        }
      }
    );

    this.controller.timer = this.time.addEvent({
      delay: 7000,
      loop: true,
      callback: () => undefined,
    });
    this.controller.ready = true;
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: "game",
  backgroundColor: "#16202a",
  audio: { noAudio: true },
  scene: MainScene,
});

(window as unknown as { __game: Phaser.Game }).__game = game;
