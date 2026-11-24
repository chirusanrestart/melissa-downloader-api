import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { createDownloadAgentHub } from "../download-agent-hub.js";

const API_KEY = "test-shared-api-key";

const messageReaders = new WeakMap();

function nextMessage(socket, timeoutMs = 1500) {
  let reader = messageReaders.get(socket);
  if (!reader) {
    const queue = [];
    const waiters = [];
    socket.on("message", raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        while (waiters.length) waiters.shift().reject(error);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    });
    reader = { queue, waiters };
    messageReaders.set(socket, reader);
  }

  if (reader.queue.length) return Promise.resolve(reader.queue.shift());
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const index = reader.waiters.indexOf(waiter);
      if (index !== -1) reader.waiters.splice(index, 1);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    reader.waiters.push(waiter);
  });
}

function makeJob(id) {
  return {
    id,
    method: "GET",
    path: "/_downloader-reverse?url=https%3A%2F%2Fyoutu.be%2Fabcdefghijk&mode=video",
    headers: {}
  };
}

async function createHarness(t) {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const pendingIds = new Set();
  const hub = createDownloadAgentHub(server, {
    apiKey: API_KEY,
    isPending: id => pendingIds.has(id),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 180_000
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const sockets = new Set();
  const harness = {
    server,
    hub,
    pendingIds,
    sockets,
    url: `ws://127.0.0.1:${address.port}/download-agent/connect`,
    connect(key = API_KEY) {
      const socket = new WebSocket(this.url, { headers: { "x-api-key": key } });
      sockets.add(socket);
      return socket;
    }
  };

  t.after(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      await new Promise(resolve => {
        socket.once("close", resolve);
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      });
    }
    hub.close();
    await new Promise(resolve => server.close(resolve));
  });

  return harness;
}

async function connectAgent(harness) {
  const socket = harness.connect();
  await once(socket, "open");
  const ready = await nextMessage(socket);
  assert.equal(ready.type, "ready");
  return socket;
}

test("authenticates the persistent connection and acknowledges agent heartbeats", async t => {
  const harness = await createHarness(t);
  const socket = await connectAgent(harness);

  socket.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
  const reply = await nextMessage(socket);

  assert.equal(reply.type, "heartbeat_ack");
  assert.equal(typeof reply.serverTime, "number");
});

test("pushes queued jobs to one connected agent and waits for task completion", async t => {
  const harness = await createHarness(t);
  const first = makeJob("123e4567-e89b-12d3-a456-426614174000");
  const second = makeJob("123e4567-e89b-12d3-a456-426614174001");
  harness.pendingIds.add(first.id);
  harness.pendingIds.add(second.id);

  harness.hub.enqueue(first);
  harness.hub.enqueue(second);

  const socket = await connectAgent(harness);
  const firstMessage = await nextMessage(socket);
  assert.equal(firstMessage.type, "task");
  assert.deepEqual(firstMessage.job, first);

  const unexpectedMessage = nextMessage(socket, 100).then(() => true, () => false);
  assert.equal(await unexpectedMessage, false);

  socket.send(JSON.stringify({ type: "task_complete", id: first.id }));
  const secondMessage = await nextMessage(socket);
  assert.equal(secondMessage.type, "task");
  assert.equal(secondMessage.job.id, second.id);
});

test("requeues an active job when its agent disconnects", async t => {
  const harness = await createHarness(t);
  const job = makeJob("123e4567-e89b-12d3-a456-426614174002");
  harness.pendingIds.add(job.id);
  harness.hub.enqueue(job);

  const firstAgent = await connectAgent(harness);
  const firstDelivery = await nextMessage(firstAgent);
  assert.equal(firstDelivery.job.id, job.id);

  const firstClosed = once(firstAgent, "close");
  firstAgent.close();
  await firstClosed;

  const replacementAgent = await connectAgent(harness);
  const replacementDelivery = await nextMessage(replacementAgent);
  assert.equal(replacementDelivery.type, "task");
  assert.deepEqual(replacementDelivery.job, job);
});

test("rejects a connection with a different API key", async t => {
  const harness = await createHarness(t);
  const socket = harness.connect("wrong-key");

  const statusCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Expected HTTP 401 handshake rejection")), 1500);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(statusCode, 401);
});
