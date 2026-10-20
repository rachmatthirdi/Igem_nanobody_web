// Child process: runs ONE engine handler for ONE session, then exits.
//
// Process-per-call is what makes the engine multi-user safe without rewriting
// it: everything the engine keeps in module scope (workspace root, cancel
// flag, running containers, GPU flag) lives and dies with this process, so two
// sessions can never see each other's state. The parent talks to it over the
// fork() IPC channel:
//   parent -> child: { type: "call", channel, args } | { type: "cancel" }
//   child -> parent: { type: "console-log"|"stage-progress", payload }
//                    { type: "result", value } | { type: "error", message, cancelled }

const engine = require("./engine");

function reply(msg) {
  // Wait for the message to flush before exiting, or the result can be lost.
  process.send(msg, () => process.exit(0));
}

process.on("message", async (msg) => {
  if (msg.type === "cancel") {
    engine.cancelPipeline();
    return;
  }
  if (msg.type !== "call") return;
  const handler = engine.handlers[msg.channel];
  if (!handler) return reply({ type: "error", message: `No handler for ${msg.channel}` });
  try {
    const value = await handler(null, ...msg.args);
    reply({ type: "result", value: value === undefined ? null : value });
  } catch (e) {
    reply({ type: "error", message: String(e && e.message ? e.message : e), cancelled: !!(e && e.cancelled) });
  }
});

// If the server dies, do not leave tool containers running for a dead session.
process.on("disconnect", () => {
  engine.cancelPipeline();
  process.exit(1);
});

process.send({ type: "ready" });
