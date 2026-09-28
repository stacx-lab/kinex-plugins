// One handler per process, even when OpenCode opens several workspace instances.
// Preserve the host's handlers; restore default signal termination when it has none.
const owners = new Set<() => Promise<void>>()
let stopping = false
const interrupt = () => { void shutdown("SIGINT") }
const terminate = () => { void shutdown("SIGTERM") }

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (stopping) return
  stopping = true
  try {
    await Promise.allSettled([...owners].map(dispose => dispose()))
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
  } finally { stopping = false }
}

export function onShutdown(dispose: () => Promise<void>) {
  if (!owners.size) { process.on("SIGINT", interrupt); process.on("SIGTERM", terminate) }
  owners.add(dispose)
  return () => {
    owners.delete(dispose)
    if (!owners.size) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate) }
  }
}
