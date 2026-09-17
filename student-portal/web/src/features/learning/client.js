import { api } from "../../api/client";

export const learningApi = {
  catalog: () => api.get("/lms/learning/catalog"),
  studyVisualResume: (theme = "light") => api.get(`/ai/study-visuals/resume?theme=${encodeURIComponent(theme)}`),
  retention: () => api.get("/psv/v1/me/retention"),
  gaps: () => api.get("/psv/v1/me/knowledge-gaps"),
  feed: () => api.get("/discover/feed?limit=12"),
};

export function parseSseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const event =
    lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() || "message";
  const text = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!text || text === "[DONE]") return { event, data: null };
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: { text } };
  }
}

export async function streamTutor(body, onEvent, signal) {
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    credentials: "include",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "The tutor is unavailable. Try again.");
  }
  if (!response.body)
    throw new Error("Streaming is unavailable in this browser.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = parseSseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame.event === "error")
          throw new Error(
            frame.data?.error ||
              frame.data?.message ||
              "The tutor response was interrupted.",
          );
        onEvent(frame);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function waitForResult(
  path,
  { signal, onProgress = () => {}, maxAttempts = 120 } = {},
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const result = await api.get(path);
    onProgress(result);
    if (["done", "succeeded", "ready"].includes(result.status)) return result;
    if (["failed", "error", "cancelled"].includes(result.status))
      throw new Error(
        result.failureReason ||
          result.error ||
          "Generation failed. Please retry.",
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000 + attempt * 250, 5000)),
    );
  }
  throw new Error(
    "This is taking longer than expected. Your request may still be processing; reopen the chapter to check.",
  );
}

export function safeExternalUrl(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
