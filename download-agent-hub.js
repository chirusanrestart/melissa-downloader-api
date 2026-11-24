import { WebSocket, WebSocketServer } from "ws";

const CONNECT_PATH = "/download-agent/connect";

function rejectUpgrade(socket, statusCode, statusText) {
  if (socket.destroyed) return;
  socket.write(
    "HTTP/1.1 " + statusCode + " " + statusText + "\r\n" +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n\r\n"
  );
  socket.destroy();
}

function parseMessage(raw) {
  try {
    const value = JSON.parse(raw.toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function createDownloadAgentHub(server, options = {}) {
  const {
    apiKey,
    isPending = () => true,
    heartbeatIntervalMs = 20_000,
    heartbeatTimeoutMs = 60_000
  } = options;

  if (!server || typeof server.on !== "function") {
    throw new TypeError("É necessário fornecer um servidor HTTP");
  }
  if (typeof isPending !== "function") {
    throw new TypeError("isPending deve ser uma função");
  }

  const queue = [];
  const agents = new Set();
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false
  });
  let closed = false;

  function dispatch() {
    if (closed) return;

    for (const agent of agents) {
      if (!queue.length) break;
      if (agent.job || agent.socket.readyState !== WebSocket.OPEN) continue;

      let job = null;
      while (queue.length && !job) {
        const candidate = queue.shift();
        if (isPending(candidate.id)) job = candidate;
      }
      if (!job) break;

      agent.job = job;
      try {
        agent.socket.send(JSON.stringify({ type: "task", job }), error => {
          if (error && agent.job && agent.job.id === job.id) {
            agent.job = null;
            if (isPending(job.id)) queue.unshift(job);
          }
          dispatch();
        });
      } catch {
        if (agent.job && agent.job.id === job.id) {
          agent.job = null;
          if (isPending(job.id)) queue.unshift(job);
        }
        dispatch();
      }
    }
  }

  function enqueue(job) {
    if (!job || typeof job.id !== "string") {
      throw new TypeError("Tarefa reversa inválida");
    }
    queue.push(job);
    dispatch();
  }

  function removeQueuedJob(id) {
    const index = queue.findIndex(job => job.id === id);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  }

  function onUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== CONNECT_PATH) {
      socket.destroy();
      return;
    }
    if (!apiKey) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (req.headers["x-api-key"] !== apiKey) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    webSockets.handleUpgrade(req, socket, head, agentSocket => {
      webSockets.emit("connection", agentSocket, req);
    });
  }

  server.on("upgrade", onUpgrade);

  webSockets.on("connection", socket => {
    const agent = {
      socket,
      job: null,
      lastHeartbeat: Date.now()
    };
    agents.add(agent);

    socket.send(JSON.stringify({ type: "ready", online: true }));

    socket.on("message", raw => {
      const message = parseMessage(raw);
      if (!message) return;

      if (message.type === "heartbeat") {
        agent.lastHeartbeat = Date.now();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "heartbeat_ack",
            serverTime: Date.now()
          }));
        }
        return;
      }

      if (message.type === "task_complete") {
        agent.lastHeartbeat = Date.now();
        if (typeof message.id === "string" && agent.job && agent.job.id === message.id) {
          agent.job = null;
          dispatch();
        }
      }
    });

    socket.on("pong", () => {
      agent.lastHeartbeat = Date.now();
    });

    socket.on("close", () => {
      agents.delete(agent);
      const interruptedJob = agent.job;
      agent.job = null;
      if (interruptedJob && isPending(interruptedJob.id)) {
        queue.unshift(interruptedJob);
      }
      dispatch();
    });

    socket.on("error", error => {
      console.warn("Conexão do agente reverso apresentou erro:", error.message);
    });

    dispatch();
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const agent of agents) {
      if (now - agent.lastHeartbeat > heartbeatTimeoutMs) {
        agent.socket.terminate();
        continue;
      }
      if (agent.socket.readyState === WebSocket.OPEN) {
        agent.socket.ping();
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  return {
    enqueue,
    removeQueuedJob,
    getStatus() {
      let activeDownloads = 0;
      let onlineAgents = 0;
      for (const agent of agents) {
        if (agent.socket.readyState !== WebSocket.OPEN) continue;
        onlineAgents += 1;
        if (agent.job) activeDownloads += 1;
      }
      return {
        online_agents: onlineAgents,
        active_downloads: activeDownloads,
        queued_downloads: queue.length
      };
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      server.off("upgrade", onUpgrade);
      for (const agent of agents) agent.socket.terminate();
      agents.clear();
      webSockets.close();
    }
  };
}
